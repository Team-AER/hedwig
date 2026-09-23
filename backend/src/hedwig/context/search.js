// Hybrid retrieval: Postgres full-text search and vector similarity, merged with reciprocal rank
// fusion. Every query is scoped to the caller's accounts; ids from the request are only filters.
//
// Text queries go through the v2 chunk index (indexer/retrieve.js). While a user's index is still
// being built, the older message-level arms below are fused in so nothing unindexed goes missing.
import { pool, query } from '../../services/db.js';
import { embedQuery, toVectorLiteral } from '../embeddings.js';
import { retrieve } from '../indexer/retrieve.js';
import { loadMessagesLite, VISIBLE_MESSAGE } from './shapes.js';
import { clampInt, httpError, isUuid } from './util.js';

const RRF_K = 60;

/** Reciprocal rank fusion. lists: [{ ids: string[], weight? }] → [{ id, score }] best first. */
export function rrfMerge(lists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const { ids, weight = 1 } of lists) {
    const seen = new Set();
    let rank = 0;
    for (const id of ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      scores.set(id, (scores.get(id) || 0) + weight / (k + rank));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * An OR query over the words of free text. Natural questions rarely have every word in one
 * message, so ranking (ts_rank_cd) rather than matching does the work. Only letters and digits
 * reach to_tsquery, so user input cannot break its syntax.
 */
export function buildOrTsQuery(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  return [...new Set(words)].slice(0, 16).join(' | ');
}

/**
 * Pick k results favouring different threads without giving up relevance: each further message
 * from a thread is pushed `gap` places down, and a thread contributes at most `perThread`.
 * The picks keep their original rank order.
 */
export function diversify(results, k, { perThread = 3, gap = 2 } = {}) {
  const counts = new Map();
  const picks = [];
  results.forEach((r, i) => {
    const key = r.thread_key || r.id;
    const n = counts.get(key) || 0;
    counts.set(key, n + 1);
    if (n < perThread) picks.push({ r, i, eff: i + n * gap });
  });
  return picks.sort((a, b) => a.eff - b.eff || a.i - b.i).slice(0, k).sort((a, b) => a.i - b.i).map((p) => p.r);
}

function dateOrNull(v, name) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `invalid ${name}`);
  return d;
}

/** SQL conditions (on alias m) for the optional filters. Mutates params. */
function filterSql(userId, { entityId, topicId, after, before, excludeThread }, params) {
  const out = [];
  if (entityId) {
    params.push(entityId);
    out.push(`m.id IN (SELECT me.message_id FROM hedwig_message_entities me JOIN hedwig_entities fe ON fe.id = me.entity_id
                        WHERE fe.user_id = $1 AND fe.id = $${params.length})`);
  }
  if (topicId) {
    params.push(topicId);
    out.push(`m.id IN (SELECT tm.message_id FROM hedwig_topic_members tm JOIN hedwig_topics ft ON ft.id = tm.topic_id
                        WHERE ft.user_id = $1 AND ft.id = $${params.length})`);
  }
  if (after) { params.push(after); out.push(`m.date >= $${params.length}`); }
  if (before) { params.push(before); out.push(`m.date < $${params.length}`); }
  if (excludeThread) { params.push(excludeThread); out.push(`m.thread_key <> $${params.length}`); }
  return out.length ? `AND ${out.join(' AND ')}` : '';
}

async function fullTextIds(userId, tsq, filters, limit) {
  if (!tsq) return [];
  const params = [userId, tsq, limit];
  const extra = filterSql(userId, filters, params);
  // The body expression matches idx_messages_body exactly so the index is usable.
  const { rows } = await query(
    `SELECT m.id
       FROM messages m JOIN email_accounts a ON a.id = m.account_id, to_tsquery('english', $2) q
      WHERE a.user_id = $1 AND ${VISIBLE_MESSAGE}
        AND (m.search_vector @@ q OR to_tsvector('english', COALESCE(m.body_text, '')) @@ q)
        ${extra}
      ORDER BY ts_rank_cd(m.search_vector, q) * 2 + ts_rank_cd(to_tsvector('english', COALESCE(m.body_text, '')), q) DESC,
               m.date DESC NULLS LAST
      LIMIT $3`,
    params,
  );
  return rows.map((r) => r.id);
}

let iterativeScan = null;

async function supportsIterativeScan() {
  if (iterativeScan !== null) return iterativeScan;
  const { rows } = await query("SELECT extversion FROM pg_extension WHERE extname = 'vector'").catch(() => ({ rows: [] }));
  const [maj, min] = String(rows[0]?.extversion || '0.0').split('.').map(Number);
  iterativeScan = maj > 0 || min >= 8;
  return iterativeScan;
}

/**
 * Nearest messages to a vector. Unfiltered searches take the HNSW path (with pgvector's iterative
 * scan so the per-user filter does not starve the result); filtered ones scan the small subset.
 */
export async function vectorIds(userId, { vector, dims, model }, filters, limit) {
  if (!vector || !Number.isInteger(dims)) return [];
  const lit = toVectorLiteral(vector);
  const filtered = Boolean(filters.entityId || filters.topicId || filters.after || filters.before || filters.excludeThread);
  if (filtered) {
    const params = [userId, lit, limit, model];
    const extra = filterSql(userId, filters, params);
    const { rows } = await query(
      `SELECT e.message_id AS id
         FROM hedwig_embeddings e JOIN messages m ON m.id = e.message_id JOIN email_accounts a ON a.id = m.account_id
        WHERE e.user_id = $1 AND a.user_id = $1 AND e.dims = ${dims} AND e.model = $4 AND ${VISIBLE_MESSAGE} ${extra}
        ORDER BY (e.embedding::vector(${dims})) <=> $2::vector(${dims})
        LIMIT $3`,
      params,
    );
    return rows.map((r) => r.id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await supportsIterativeScan()) await client.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
    const { rows } = await client.query(
      `SELECT n.id FROM (
         SELECT e.message_id AS id, (e.embedding::vector(${dims})) <=> $2::vector(${dims}) AS dist
           FROM hedwig_embeddings e
          WHERE e.user_id = $1 AND e.dims = ${dims} AND e.model = $4
          ORDER BY (e.embedding::vector(${dims})) <=> $2::vector(${dims})
          LIMIT $3) n
        JOIN messages m ON m.id = n.id JOIN email_accounts a ON a.id = m.account_id
       WHERE a.user_id = $1 AND ${VISIBLE_MESSAGE}
       ORDER BY n.dist`,
      [userId, lit, limit, model],
    );
    await client.query('COMMIT');
    return rows.map((r) => r.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recentIds(userId, filters, limit) {
  const params = [userId, limit];
  const extra = filterSql(userId, filters, params);
  const { rows } = await query(
    `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND ${VISIBLE_MESSAGE} ${extra}
      ORDER BY m.date DESC NULLS LAST LIMIT $2`,
    params,
  );
  return rows.map((r) => r.id);
}

const completeCache = new Map(); // userId -> { complete, at }

/** True when every included folder of the user's is fully indexed (cached for a minute). */
export async function indexComplete(userId) {
  const hit = completeCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.complete;
  let complete;
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE state NOT IN ('done','paused'))::int AS open
         FROM hedwig_index_coverage WHERE user_id = $1`,
      [userId],
    );
    complete = rows[0].n > 0 && rows[0].open === 0;
  } catch { complete = false; }
  completeCache.set(userId, { complete, at: Date.now() });
  return complete;
}

const excerptOf = (text) => String(text || '').split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Hybrid search with the chunk index. Returns { results: (MessageLite & { score, excerpt? })[] }.
 * `people` (addresses or names) filters through the index; the legacy arms honour entityId only.
 */
export async function searchIndexed(userId, opts = {}) {
  const q = typeof opts.q === 'string' ? opts.q.trim() : '';
  if (q.length > 500) throw httpError(400, 'query too long');
  for (const k of ['entityId', 'topicId']) if (opts[k] != null && !isUuid(opts[k])) throw httpError(400, `invalid ${k}`);
  const limit = clampInt(opts.limit, 1, 100, 20);
  const people = Array.isArray(opts.people) ? opts.people.filter(Boolean) : [];
  const filters = {
    entityId: opts.entityId || null,
    topicId: opts.topicId || null,
    after: dateOrNull(opts.after, 'after'),
    before: dateOrNull(opts.before, 'before'),
  };
  const hasFilter = Boolean(filters.entityId || filters.topicId || filters.after || filters.before || people.length);
  if (!q && !hasFilter) return { results: [] };
  const depth = Math.max(limit * 3, 30);
  // The legacy message-level arms cannot filter by address; skip them for an address-only filter.
  const legacy = (!q || !(await indexComplete(userId))) && !(people.length && !filters.entityId);
  const tsq = buildOrTsQuery(q);
  const [indexed, fts, vec, recent] = await Promise.all([
    q ? retrieve({ userId, query: q, filters: { ...filters, people }, limit: depth, expandThreads: false })
      .catch((err) => { console.warn('[hedwig] search: chunk index unavailable:', err.message); return { chunks: [] }; })
      : { chunks: [] },
    legacy ? fullTextIds(userId, tsq, filters, depth) : [],
    legacy && q ? embedQuery(q).then((e) => (e ? vectorIds(userId, { vector: e.vector, dims: e.dims, model: e.model }, filters, depth) : [])) : [],
    // Within a person or topic, recency is itself a good signal ("what's the latest…").
    legacy && (hasFilter || !q) ? recentIds(userId, filters, depth) : [],
  ]);
  const excerpts = new Map();
  const indexIds = [];
  for (const c of indexed.chunks) {
    if (excerpts.has(c.messageId)) continue;
    excerpts.set(c.messageId, excerptOf(c.text));
    indexIds.push(c.messageId);
  }
  const merged = rrfMerge([{ ids: indexIds, weight: 2 }, { ids: fts, weight: 1 }, { ids: vec, weight: 1 }, { ids: recent, weight: q ? 0.5 : 1 }]);
  const lite = await loadMessagesLite(userId, merged.slice(0, depth).map((m) => m.id));
  const score = new Map(merged.map((m) => [m.id, m.score]));
  return {
    results: lite.slice(0, limit).map((m) => ({
      ...m,
      score: Math.round(score.get(m.id) * 1e5) / 1e5,
      ...(excerpts.has(m.id) ? { excerpt: excerpts.get(m.id) } : {}),
    })),
  };
}

/**
 * Hybrid search. Returns { results: (MessageLite & { score })[] }.
 * @param {{ q: string, limit?: number, entityId?: string, topicId?: string, after?: string, before?: string }} opts
 */
export async function searchMessages(userId, opts = {}) {
  const { results } = await searchIndexed(userId, {
    q: opts.q, limit: opts.limit, entityId: opts.entityId, topicId: opts.topicId, after: opts.after, before: opts.before,
  });
  return { results };
}
