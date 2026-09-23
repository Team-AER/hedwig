// The index's numbers everyone quotes. One definition each, so admin health, /index/status,
// "Sort the past" and the feature responses agree.
//
// Real body: a message whose stored body (text or HTML) was fetched AND produced indexable text
// (at least one body or quote chunk under the current chunker version). Everything else in an
// included folder has exactly one reason:
//   duplicate      a copy of a message indexed from another folder (Sent + INBOX); not counted
//   fetch_failed   the body fetch failed (hedwig_index_msg.body_state = 'failed', body_error says why)
//   server_empty   the server returned no body (body_state = 'empty')
//   waiting        no body stored yet; the acquire sweep will fetch it
//   not_indexed    a body is stored but the message has not been (re)chunked with it yet
//   no_text        the body has no readable text (image-only HTML, an empty part)
//
// Coverage share: the share of the user's searchable mail (included folders, spam folder aside)
// that is chunked and embedded under the current recipe. Ask, search and cards report it until the
// index is complete, so nothing pretends to know what it has not read.
import { query } from '../../services/db.js';
import { currentRecipe } from './recipe.js';

export const BODY_REASONS = Object.freeze(['duplicate', 'fetch_failed', 'server_empty', 'waiting', 'not_indexed', 'no_text']);

const REASON_SQL = `CASE
    WHEN h.skip_reason = 'duplicate' THEN 'duplicate'
    WHEN x.had_body AND x.chunk_version = $1 AND EXISTS (
           SELECT 1 FROM hedwig_chunks k WHERE k.message_id = m.id AND k.recipe = $1 AND k.kind IN ('body', 'quote')) THEN 'real'
    WHEN x.body_state = 'failed' THEN 'fetch_failed'
    WHEN x.body_state = 'empty' THEN 'server_empty'
    WHEN m.body_text IS NULL AND m.body_html IS NULL THEN 'waiting'
    WHEN x.message_id IS NULL OR NOT x.had_body OR x.chunk_version IS DISTINCT FROM $1 THEN 'not_indexed'
    ELSE 'no_text' END`;

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : 1);

function emptyReasons() {
  return Object.fromEntries(BODY_REASONS.map((r) => [r, 0]));
}

/** Fold per-folder reason counts into totals. Pure. rows: { account_id, folder, spam, reason, n } */
export function foldBodyRows(rows) {
  const folders = new Map();
  const accounts = new Map();
  const totals = { total: 0, indexable: 0, real: 0, reasons: emptyReasons() };
  const bump = (acc, reason, n) => {
    acc.total += n;
    if (reason === 'real') acc.real += n;
    else acc.reasons[reason] = (acc.reasons[reason] || 0) + n;
    if (reason !== 'duplicate') acc.indexable += n;
  };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    const key = `${r.account_id}\n${r.folder}`;
    if (!folders.has(key)) folders.set(key, { accountId: r.account_id, folder: r.folder, spam: Boolean(r.spam), total: 0, indexable: 0, real: 0, reasons: emptyReasons() });
    if (!accounts.has(r.account_id)) accounts.set(r.account_id, { accountId: r.account_id, total: 0, indexable: 0, real: 0, reasons: emptyReasons() });
    bump(folders.get(key), r.reason, n);
    bump(accounts.get(r.account_id), r.reason, n);
    bump(totals, r.reason, n);
  }
  // Nothing indexable (no folder yet, or only duplicates): no share to report.
  const withShare = (o) => ({ ...o, share: o.indexable > 0 ? ratio(o.real, o.indexable) : null });
  return {
    ...withShare(totals),
    byFolder: [...folders.values()].map(withShare),
    byAccount: [...accounts.values()].map(withShare),
  };
}

/**
 * Real-body coverage over the included folders (hedwig_index_coverage rows) of one user, or of
 * everyone when userId is null.
 * @returns {Promise<{ total, indexable, real, share, reasons, byFolder: object[], byAccount: object[] }>}
 */
export async function bodyCoverage({ userId = null } = {}) {
  const recipe = await currentRecipe();
  const params = [recipe.version];
  if (userId) params.push(userId);
  const { rows } = await query(
    `SELECT c.account_id, c.folder, c.spam, ${REASON_SQL} AS reason, COUNT(*)::int AS n
       FROM hedwig_index_coverage c
       JOIN messages m ON m.account_id = c.account_id AND m.folder = c.folder AND m.is_deleted = false
       LEFT JOIN hedwig_msg h ON h.message_id = m.id
       LEFT JOIN hedwig_index_msg x ON x.message_id = m.id
      ${userId ? 'WHERE c.user_id = $2' : ''}
      GROUP BY 1, 2, 3, 4`,
    params,
  );
  return foldBodyRows(rows);
}

/** Share from coverage-ledger sums. Pure. rows: hedwig_index_coverage rows (spam rows ignored). */
export function shareOf(rows, { vectors = true } = {}) {
  const own = rows.filter((r) => !r.spam);
  const total = own.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const dupes = own.reduce((s, r) => s + (Number(r.dupes) || 0), 0);
  const indexable = Math.max(0, total - dupes);
  const done = own.reduce((s, r) => s + (Number(vectors ? r.embedded : r.chunked) || 0), 0);
  const indexed = Math.min(indexable, done);
  const complete = own.length > 0 && own.every((r) => r.state === 'done' || r.state === 'paused');
  // No included folder yet (no account, or the ledger has not run): nothing to report a share of.
  const share = own.length === 0 ? null : complete ? 1 : ratio(indexed, indexable);
  return { share, indexed, total: indexable, complete };
}

const shareCache = new Map(); // userId -> { at, value }
const SHARE_TTL_MS = 60_000;

/**
 * How much of the user's searchable mail the index covers, for the responses of Ask, search and
 * cards: { share: 0..1, indexed, total, complete }. Cached for a minute per user.
 */
export async function coverageShare(userId, { fresh = false } = {}) {
  const hit = shareCache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < SHARE_TTL_MS) return hit.value;
  let value;
  try {
    const recipe = await currentRecipe();
    const { rows } = await query(
      'SELECT spam, state, total, dupes, chunked, embedded FROM hedwig_index_coverage WHERE user_id = $1',
      [userId],
    );
    value = shareOf(rows, { vectors: recipe.vectors });
  } catch {
    value = { share: null, indexed: null, total: null, complete: false };
  }
  shareCache.set(userId, { at: Date.now(), value });
  if (shareCache.size > 1000) shareCache.delete(shareCache.keys().next().value);
  return value;
}

export function _resetShareCache() { shareCache.clear(); }
