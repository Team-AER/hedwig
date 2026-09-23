// The coverage ledger: one hedwig_index_coverage row per included folder per account.
//
// A folder's state is recomputed from absence counts on every refresh (messages without a
// hedwig_msg row, without a body, without chunks under the current recipe, without vectors), so
// it can never stay 'done' while mail in it is unindexed — whatever that mail's age and however
// late it synced. The pipeline scanner reads the ledger to decide which folders still need a
// history pass. Adding an account or folder creates rows; changing the folder rules resets them.
import { createHash } from 'crypto';
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { getState, setState } from '../state.js';
import { applyRecipeChange, currentRecipe, switchCompletedUsers } from './recipe.js';

const SPAM_NAME = /(^|[/.])(spam|junk|junk e-?mail|bulk mail)$/i;
const EXCLUDED_NAME = /(^|[/.])(trash|bin|deleted items|deleted messages|drafts)$/i;

export function rulesOf(cfg) {
  return {
    excludeSpecialUse: [...(cfg['pipeline.excludeSpecialUse'] || [])].map(String).sort(),
    excludeFolders: [...(cfg['pipeline.excludeFolders'] || [])].map(String).sort(),
    indexSpam: cfg['index.indexSpamFolder'] !== false,
  };
}

export function rulesHash(rules) {
  return createHash('sha1').update(JSON.stringify(rules)).digest('hex').slice(0, 16);
}

/** Is a folder indexed, and is it the server spam folder? */
export function classifyFolder(path, specialUse, rules) {
  const p = String(path || '');
  if (!p || rules.excludeFolders.includes(p)) return { included: false, spam: false };
  const spam = specialUse === '\\Junk' || SPAM_NAME.test(p);
  if (spam) return { included: Boolean(rules.indexSpam), spam: true };
  if (specialUse && rules.excludeSpecialUse.includes(specialUse)) return { included: false, spam: false };
  if (EXCLUDED_NAME.test(p)) return { included: false, spam: false };
  return { included: true, spam: false };
}

/**
 * State from counts. `bodiesDue` = messages still waiting for a body fetch;
 * `indexable` = seen minus duplicate copies (which are never chunked).
 */
export function coverageState(c, { vectors = true, paused = false } = {}) {
  if (paused) return 'paused';
  if (!c.total) return 'done';
  const indexable = Math.max(0, c.seen - (c.dupes || 0));
  const complete = c.seen >= c.total
    && c.chunked >= indexable
    && (!vectors || c.embedded >= indexable)
    && !(c.bodiesDue > 0);
  if (complete) return 'done';
  return c.seen === 0 && c.chunked === 0 ? 'pending' : 'running';
}

export function coverageError(c) {
  const bits = [];
  if (c.bodyFailed > 0) bits.push(`${c.bodyFailed} bod${c.bodyFailed === 1 ? 'y' : 'ies'} could not be fetched${c.lastBodyError ? ` (last: ${String(c.lastBodyError).slice(0, 200)})` : ''}`);
  if (c.attachFailed > 0) bits.push(`${c.attachFailed} attachment text extraction${c.attachFailed === 1 ? '' : 's'} failed${c.lastAttachError ? ` (last: ${String(c.lastAttachError).slice(0, 200)})` : ''}`);
  if (c.indexErrors > 0) bits.push(`${c.indexErrors} message${c.indexErrors === 1 ? '' : 's'} could not be chunked${c.lastIndexError ? ` (last: ${String(c.lastIndexError).slice(0, 200)})` : ''}`);
  return bits.length ? bits.join('; ') : null;
}

/** Reset rows to pending (after a rule change, a rebuild or /admin/reindex). Paused rows stay paused. */
export async function resetCoverage({ userId = null, accountIds = null, hash = null } = {}) {
  const params = [];
  const where = [];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (accountIds) { params.push(accountIds); where.push(`account_id = ANY($${params.length}::uuid[])`); }
  params.push(hash);
  const { rowCount } = await query(
    `UPDATE hedwig_index_coverage
        SET state = CASE WHEN state = 'paused' THEN 'paused' ELSE 'pending' END, cursor = NULL,
            reset_at = NOW(), updated_at = NOW(), rules_hash = COALESCE($${params.length}, rules_hash)
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  );
  return rowCount;
}

let lastRefresh = 0;

/** Refresh unless one ran within `index.coverageEverySec` (or `force`). Used by the scanner. */
export async function maybeRefreshCoverage({ force = false } = {}) {
  const cfg = await getConfig();
  if (!force && Date.now() - lastRefresh < cfg['index.coverageEverySec'] * 1000) return null;
  return refreshCoverage();
}

/**
 * Sync rows with the current folders and rules, recount every row, derive states, and switch
 * users whose rebuilt recipe is complete.
 * @param {{ accountIds?: string[] }} [opts] limit to these accounts (enabled or not); default: every enabled account
 */
export async function refreshCoverage({ accountIds = null } = {}) {
  lastRefresh = Date.now();
  const cfg = await getConfig();
  const rules = rulesOf(cfg);
  const hash = rulesHash(rules);
  const recipe = await currentRecipe();
  await applyRecipeChange(recipe);

  // 1. Folder rules changed → every row starts over.
  const prev = await getState('index.coverageRules', null);
  if (prev?.hash !== hash) {
    await resetCoverage({ hash });
    await setState('index.coverageRules', { hash, rules, changedAt: new Date().toISOString() });
  }

  // 2. Rows for every included folder; drop rows for folders no longer included.
  const scope = accountIds ? 'a.id = ANY($1::uuid[])' : 'a.enabled = true';
  const { rows: folders } = await query(
    `SELECT a.id AS account_id, a.user_id, f.path, f.special_use
       FROM email_accounts a JOIN folders f ON f.account_id = a.id
      WHERE ${scope} AND COALESCE(f.no_select, false) = false`,
    accountIds ? [accountIds] : [],
  );
  const keep = folders.map((f) => ({ ...f, ...classifyFolder(f.path, f.special_use, rules) })).filter((f) => f.included);
  if (keep.length) {
    await query(
      `INSERT INTO hedwig_index_coverage (account_id, folder, user_id, spam, rules_hash)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[], $4::bool[], $5::text[])
       ON CONFLICT (account_id, folder) DO UPDATE SET spam = EXCLUDED.spam, user_id = EXCLUDED.user_id`,
      [keep.map((f) => f.account_id), keep.map((f) => f.path), keep.map((f) => f.user_id), keep.map((f) => f.spam), keep.map(() => hash)],
    );
  }
  const kept = `NOT EXISTS (SELECT 1 FROM UNNEST($1::uuid[], $2::text[]) k(aid, folder) WHERE k.aid = c.account_id AND k.folder = c.folder)`;
  const keepParams = [keep.map((f) => f.account_id), keep.map((f) => f.path)];
  if (accountIds) {
    await query(`DELETE FROM hedwig_index_coverage c WHERE c.account_id = ANY($3::uuid[]) AND ${kept}`, [...keepParams, accountIds]);
  } else {
    await query(
      `DELETE FROM hedwig_index_coverage c USING email_accounts a WHERE a.id = c.account_id AND (a.enabled = false OR ${kept})`,
      keepParams,
    );
  }

  // 3. Recount.
  const maxAge = cfg['index.bodyMaxAgeDays'];
  const params = [recipe.version, recipe.full, maxAge];
  let where = '';
  if (accountIds) { params.push(accountIds); where = `AND c.account_id = ANY($${params.length}::uuid[])`; }
  const { rows: counts } = await query(
    `SELECT c.account_id, c.folder, c.state,
            COUNT(m.id)::int AS total,
            COUNT(h.message_id)::int AS seen,
            COUNT(h.message_id) FILTER (WHERE h.skip_reason = 'duplicate')::int AS dupes,
            COUNT(m.id) FILTER (WHERE m.body_text IS NOT NULL OR m.body_html IS NOT NULL)::int AS bodies,
            COUNT(x.message_id) FILTER (WHERE x.body_state IN ('failed','empty'))::int AS body_failed,
            COUNT(m.id) FILTER (WHERE m.body_text IS NULL AND m.body_html IS NULL
                                  AND (x.body_state IS NULL OR x.body_state = 'requested')
                                  AND ($3::int = 0 OR m.date >= NOW() - make_interval(days => $3::int)))::int AS bodies_due,
            COUNT(x.message_id) FILTER (WHERE x.chunk_version = $1)::int AS chunked,
            COUNT(x.message_id) FILTER (WHERE x.embed_recipe = $2)::int AS embedded,
            COUNT(x.message_id) FILTER (WHERE x.attach_state = 'failed')::int AS attach_failed,
            COUNT(x.message_id) FILTER (WHERE x.error IS NOT NULL)::int AS index_errors,
            MAX(x.body_error) FILTER (WHERE x.body_state = 'failed') AS last_body_error,
            MAX(x.attach_error) FILTER (WHERE x.attach_state = 'failed') AS last_attach_error,
            MAX(x.error) AS last_index_error,
            MIN(m.date) FILTER (WHERE h.message_id IS NOT NULL) AS cursor
       FROM hedwig_index_coverage c
       LEFT JOIN messages m ON m.account_id = c.account_id AND m.folder = c.folder AND m.is_deleted = false
       LEFT JOIN hedwig_msg h ON h.message_id = m.id
       LEFT JOIN hedwig_index_msg x ON x.message_id = m.id
      WHERE true ${where}
      GROUP BY c.account_id, c.folder, c.state`,
    params,
  );
  const upd = counts.map((r) => {
    const c = {
      total: r.total, seen: r.seen, dupes: r.dupes, chunked: r.chunked, embedded: r.embedded, bodiesDue: r.bodies_due,
      bodyFailed: r.body_failed, lastBodyError: r.last_body_error, attachFailed: r.attach_failed,
      lastAttachError: r.last_attach_error, indexErrors: r.index_errors, lastIndexError: r.last_index_error,
    };
    return { ...r, state: coverageState(c, { vectors: recipe.vectors, paused: r.state === 'paused' }), error: coverageError(c) };
  });
  if (upd.length) {
    await query(
      `UPDATE hedwig_index_coverage c SET state = x.state, total = x.total, seen = x.seen, dupes = x.dupes, bodies = x.bodies,
              body_failed = x.body_failed, chunked = x.chunked, embedded = x.embedded, error = x.error,
              cursor = x.cursor, updated_at = NOW()
         FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::text[], $11::timestamptz[], $12::int[])
           AS x(account_id, folder, state, total, seen, bodies, body_failed, chunked, embedded, error, cursor, dupes)
        WHERE c.account_id = x.account_id AND c.folder = x.folder`,
      [upd.map((r) => r.account_id), upd.map((r) => r.folder), upd.map((r) => r.state), upd.map((r) => r.total),
        upd.map((r) => r.seen), upd.map((r) => r.bodies), upd.map((r) => r.body_failed), upd.map((r) => r.chunked),
        upd.map((r) => r.embedded), upd.map((r) => r.error), upd.map((r) => r.cursor), upd.map((r) => r.dupes)],
    );
  }

  // 4. Recipe switch-over for users whose rebuild finished.
  const userIds = [...new Set(keep.map((f) => f.user_id))];
  const switched = await switchCompletedUsers(userIds, recipe);
  return { folders: upd.length, done: upd.filter((r) => r.state === 'done').length, switched };
}

/** True when some included folder still has work; the scanner skips its history pass otherwise. */
export async function historyPending() {
  const { rows } = await query("SELECT EXISTS (SELECT 1 FROM hedwig_index_coverage WHERE state IN ('pending','running')) AS p");
  return Boolean(rows[0]?.p);
}

/** Totals over every row (admin health, pipeline stats). */
export async function coverageSummary({ userId = null } = {}) {
  const params = userId ? [userId] : [];
  const { rows } = await query(
    `SELECT COUNT(*)::int AS folders,
            COUNT(*) FILTER (WHERE state = 'done')::int AS done,
            COUNT(*) FILTER (WHERE state = 'running')::int AS running,
            COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE state = 'paused')::int AS paused,
            COALESCE(SUM(total),0)::int AS total, COALESCE(SUM(seen),0)::int AS seen, COALESCE(SUM(dupes),0)::int AS dupes,
            COALESCE(SUM(bodies),0)::int AS bodies, COALESCE(SUM(body_failed),0)::int AS body_failed,
            COALESCE(SUM(chunked),0)::int AS chunked, COALESCE(SUM(embedded),0)::int AS embedded,
            COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS with_errors,
            MIN(cursor) AS oldest_seen, MAX(updated_at) AS refreshed_at
       FROM hedwig_index_coverage ${userId ? 'WHERE user_id = $1' : ''}`,
    params,
  );
  return rows[0];
}

export function _resetCoverageClock() { lastRefresh = 0; }
