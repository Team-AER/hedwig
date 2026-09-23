// The per-message pipeline. The worker finds messages Hedwig has not seen yet (no hedwig_msg row),
// records them, and runs every registered step over the batch in `order`. Steps are contributed by
// feature modules (context, triage, …). A failing step records its error on hedwig_msg and never
// stops the other steps or the batch — mail handling itself never depends on this code.
//
// Two scans feed it:
//   realtime — messages dated in the last few days (cheap, runs every scan interval)
//   history  — by absence: any message in an included folder without a hedwig_msg row, whatever
//              its age, newest first. Folders come from the coverage ledger (indexer/coverage.js),
//              whose states are recounted from absence, so history never "finishes" for good while
//              mail is unseen. pipeline.backfillDays only limits which steps run (see runSteps).
import { query } from '../services/db.js';
import { getConfig } from './config.js';
import { setState } from './state.js';
import { runHedwigHook, HEDWIG_HOOKS } from './hooks.js';
import { maybeRefreshCoverage, historyPending, resetCoverage, coverageSummary } from './indexer/coverage.js';

/**
 * @typedef {object} PipelineStep
 * @property {string} name
 * @property {number} order        lower runs first
 * @property {boolean} [backfill]  also run on history older than pipeline.backfillDays (cheap steps only)
 * @property {boolean} [spam]      also run on mail in the server spam folder (indexing only)
 * @property {(rows: object[], ctx: object) => Promise<void>} run
 */

/** @type {PipelineStep[]} */
const steps = [];

export function defineStep(step) {
  if (!step?.name || typeof step.run !== 'function') throw new Error('pipeline step needs name and run');
  if (steps.some((s) => s.name === step.name)) throw new Error(`pipeline step ${step.name} already defined`);
  steps.push({ order: 50, backfill: false, spam: false, ...step });
  steps.sort((a, b) => a.order - b.order);
}

export function definedSteps() { return steps.map((s) => ({ name: s.name, order: s.order, backfill: s.backfill, spam: s.spam })); }

// Columns every step can rely on. `user_id` comes from the account; `is_outgoing` is derived.
export const MESSAGE_COLUMNS = `
  m.id, m.account_id, a.user_id, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
  m.sender_email, m.sender_name, m.to_addresses, m.cc_addresses, m.reply_to, m.date, m.snippet,
  m.body_text, m.body_html, m.is_read, m.is_starred, m.has_attachments, m.attachments, m.flags,
  m.thread_id, m.thread_key, m.in_reply_to, m.thread_references, m.is_bulk, m.category,
  m.list_unsubscribe, m.plugin_annotations, f.special_use`;

const FROM_JOIN = `
  FROM messages m
  JOIN email_accounts a ON a.id = m.account_id
  LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
  LEFT JOIN hedwig_msg h ON h.message_id = m.id`;

function folderFilter(cfg, params) {
  params.push(cfg['pipeline.excludeSpecialUse'] || []);
  const su = `$${params.length}`;
  params.push(cfg['pipeline.excludeFolders'] || []);
  const fx = `$${params.length}`;
  return `(f.special_use IS NULL OR NOT (f.special_use = ANY(${su}::text[])))
          AND NOT (m.folder = ANY(${fx}::text[]))
          AND m.folder !~* '(^|/)(spam|junk|trash|bin|deleted items|drafts)$'`;
}

/** Load user address sets so steps can tell outgoing mail from incoming. */
export async function userAddresses(userIds) {
  if (!userIds.length) return new Map();
  const { rows } = await query(
    `SELECT a.user_id, lower(a.email_address) AS email FROM email_accounts a WHERE a.user_id = ANY($1::uuid[])
     UNION
     SELECT a.user_id, lower(al.email) FROM account_aliases al JOIN email_accounts a ON a.id = al.account_id
      WHERE a.user_id = ANY($1::uuid[])`,
    [userIds],
  ).catch(async () => query(
    'SELECT user_id, lower(email_address) AS email FROM email_accounts WHERE user_id = ANY($1::uuid[])', [userIds],
  ));
  const map = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    if (!map.has(r.user_id)) map.set(r.user_id, new Set());
    map.get(r.user_id).add(r.email);
  }
  return map;
}

export async function decorate(rows) {
  const addrs = await userAddresses([...new Set(rows.map((r) => r.user_id))]);
  for (const r of rows) {
    const mine = addrs.get(r.user_id) || new Set();
    r.user_addresses = mine;
    r.is_outgoing = r.special_use === '\\Sent' || mine.has(String(r.from_email || '').toLowerCase());
  }
  return rows;
}

async function findRealtime(cfg, limit) {
  const params = [limit];
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS} ${FROM_JOIN}
      WHERE h.message_id IS NULL AND m.is_deleted = false AND a.enabled = true
        AND m.date >= NOW() - INTERVAL '3 days'
        AND ${folderFilter(cfg, params)}
      ORDER BY m.date DESC NULLS LAST
      LIMIT $1`,
    params,
  );
  return rows;
}

// History by absence over the folders the coverage ledger still has work in. No date cursor: a
// cursor that reached "done" on an empty database never restarted when mail synced later.
async function findHistory(limit) {
  if (!(await historyPending())) return [];
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, c.spam AS coverage_spam ${FROM_JOIN}
       JOIN hedwig_index_coverage c ON c.account_id = m.account_id AND c.folder = m.folder AND c.state IN ('pending','running')
      WHERE h.message_id IS NULL AND m.is_deleted = false AND a.enabled = true
      ORDER BY m.date DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async function markSeen(rows, cutoff) {
  if (!rows.length) return [];
  // Skip duplicate copies of one message (Gmail labels, moved copies): keep the first row per
  // (account, Message-ID) and record the rest as duplicates so they are never re-scanned.
  const seenKeys = new Set();
  const { rows: existing } = await query(
    `SELECT DISTINCT m.account_id, m.message_id FROM hedwig_msg h JOIN messages m ON m.id = h.message_id
      WHERE h.skip_reason IS NULL AND m.message_id = ANY($1::text[])`,
    [rows.map((r) => r.message_id).filter(Boolean)],
  );
  for (const e of existing) seenKeys.add(`${e.account_id}|${e.message_id}`);
  const fresh = [];
  const values = [];
  for (const r of rows) {
    const key = r.message_id ? `${r.account_id}|${r.message_id}` : null;
    let skip = null;
    if (key && seenKeys.has(key)) skip = 'duplicate';
    else if (r.coverage_spam) skip = 'spam'; // server spam folder: indexed only, never the other steps
    else if (cutoff && r.date && new Date(r.date) < cutoff) skip = null; // history: cheap steps only
    if (key && !skip) seenKeys.add(key);
    values.push([r.id, r.user_id, r.account_id, skip]);
    if (!skip || skip === 'spam') fresh.push(r);
  }
  await query(
    `INSERT INTO hedwig_msg (message_id, user_id, account_id, skip_reason)
     SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
     ON CONFLICT (message_id) DO NOTHING`,
    [values.map((v) => v[0]), values.map((v) => v[1]), values.map((v) => v[2]), values.map((v) => v[3])],
  );
  return fresh;
}

/** Run every step over a batch. Exported so tests and backfill tools can drive it directly. */
export async function runSteps(rows, { historical = false, spam = false } = {}) {
  if (!rows.length) return;
  await decorate(rows);
  const ctx = { historical, spam, getConfig };
  for (const step of steps) {
    if (historical && !step.backfill) continue;
    if (spam && !step.spam) continue;
    try {
      await step.run(rows, ctx);
    } catch (err) {
      console.warn(`[hedwig] pipeline step ${step.name} failed for a batch of ${rows.length}:`, err.message);
      await query(
        `UPDATE hedwig_msg SET error = LEFT(COALESCE(error || '; ', '') || $2, 1000) WHERE message_id = ANY($1::uuid[])`,
        [rows.map((r) => r.id), `${step.name}: ${err.message}`],
      ).catch(() => {});
    }
  }
  if (!historical && !spam) {
    for (const r of rows) {
      runHedwigHook(HEDWIG_HOOKS.onMessageIndexed, { userId: r.user_id, messageId: r.id, accountId: r.account_id }).catch(() => {});
    }
  }
}

/** One scan tick: realtime first, then one history batch. Returns counts for logging. */
export async function scanOnce() {
  const cfg = await getConfig();
  if (!cfg.enabled) return { realtime: 0, backfill: 0 };
  const batch = cfg['pipeline.batchSize'];
  const realtime = await findRealtime(cfg, batch);
  const freshRealtime = await markSeen(realtime, null);
  await runSteps(freshRealtime, { historical: false });

  // Throttled inside; creates rows for new accounts/folders and flips folders with unseen mail back.
  await maybeRefreshCoverage().catch((err) => console.warn('[hedwig] coverage refresh failed:', err.message));
  const back = await findHistory(batch);
  if (!back.length) return { realtime: freshRealtime.length, backfill: 0 };
  const cutoff = new Date(Date.now() - cfg['pipeline.backfillDays'] * 86400_000);
  const freshBack = await markSeen(back, cutoff);
  const spamRows = freshBack.filter((r) => r.coverage_spam);
  const mail = freshBack.filter((r) => !r.coverage_spam);
  const recent = mail.filter((r) => !r.date || new Date(r.date) >= cutoff);
  const old = mail.filter((r) => r.date && new Date(r.date) < cutoff);
  await runSteps(recent, { historical: false });
  await runSteps(old, { historical: true });
  await runSteps(spamRows, { historical: true, spam: true });
  return { realtime: freshRealtime.length, backfill: back.length };
}

/** Restart history (after changing folders or wiping derived data). */
export async function resetBackfill() {
  await setState('pipeline.backfill', { before: null, done: false }); // legacy key, kept but unused
  await resetCoverage();
  await maybeRefreshCoverage({ force: true }).catch((err) => console.warn('[hedwig] coverage refresh failed:', err.message));
}

/** Pipeline progress for the admin UI. */
export async function pipelineStats() {
  const [{ rows: totals }, coverage] = await Promise.all([
    query(`SELECT COUNT(*)::int AS seen,
                  COUNT(*) FILTER (WHERE skip_reason IS NULL)::int AS indexed,
                  COUNT(embedded_at)::int AS embedded,
                  COUNT(triaged_at)::int AS triaged,
                  COUNT(extracted_at)::int AS extracted,
                  COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors
             FROM hedwig_msg`),
    coverageSummary().catch(() => null),
  ]);
  // `backfill` keeps its old shape for the settings UI; it is now derived from the coverage ledger.
  const done = coverage ? coverage.folders > 0 && coverage.done + coverage.paused === coverage.folders : false;
  return { ...totals[0], backfill: { done, oldestSeen: coverage?.oldest_seen || null }, coverage };
}

export function _resetSteps() { steps.length = 0; }
