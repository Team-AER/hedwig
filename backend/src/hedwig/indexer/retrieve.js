// Retrieval over the chunk index: full-text (OR of terms plus a phrase boost) and vector search in
// parallel, an evidence gate (a chunk goes on only if one retriever found it for a good reason),
// weighted reciprocal rank fusion with a recency prior and per-kind weights, a fused-score cut, then
// neighbouring chunks and the replied-to message. Every query is scoped to the caller's accounts;
// ids in filters only narrow that scope.
//
// The relevance floor is two things:
//   - the evidence gate, before fusion. Fused scores are ranks, so the best of a set of unrelated
//     hits still scores high; the gate instead asks whether the evidence itself is good. A chunk is
//     admitted when its vector hit has cosine similarity >= index.minCosine (index.minCosineHash for
//     the lexical hash provider), or its full-text hit contains at least index.minTermCoverage of the
//     query's words or has ts_rank_cd (+ phrase bonus) >= index.minFtsRank. Admitted chunks keep
//     their ranks in both lists; the rest are dropped from both.
//   - index.floor, after fusion: a cut on the normalised fused score (1.0 = first in both lists and
//     brand new). Rank-based, so it only trims the tail.
// `floor: true` in the result means one of them removed everything or cut the list short.
import { pool, query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { embedQuery, toVectorLiteral } from '../embeddings.js';
import { getState } from '../state.js';
import { recipesFor, VECTOR_DIMS } from './recipe.js';
import { tsConfig } from './store.js';

export const RRF_K = 60;

const STOPWORDS = new Set(('a an and are as at be but by can did do does for from had has have how i if in into is it its me my '
  + 'of on or our so than that the their them then there these they this to was we were what when where which who why will with '
  + 'you your about any all also been could get got just more most not now only out over some such very would').split(' '));

/**
 * OR query over the words of free text (stopwords dropped unless nothing else is left), each as a
 * prefix match. Only letters and digits reach to_tsquery, so user input cannot break its syntax.
 */
export function buildOrQuery(text) {
  const words = [...new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
  const content = words.filter((w) => !STOPWORDS.has(w));
  return (content.length ? content : words).slice(0, 16).map((w) => `${w}:*`).join(' | ');
}

/** Words that make a phrase worth boosting (two or more). */
export function phraseOf(text) {
  const words = String(text || '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.length >= 2 ? words.slice(0, 12).join(' ') : '';
}

/** 1 for mail from now, 0.5 after `halfLifeDays`, and so on. */
export function recencyPrior(date, { now = Date.now(), halfLifeDays = 180 } = {}) {
  if (!date) return 0;
  const ageDays = Math.max(0, (now - new Date(date).getTime()) / 86400_000);
  return 0.5 ** (ageDays / halfLifeDays);
}

/**
 * Weighted reciprocal rank fusion of the full-text and vector lists, plus a recency prior, times a
 * per-kind weight, normalised so 1.0 = first in both lists and brand new.
 * @param {{ fts: object[], vec: object[] }} lists rows with { id, date, kind, ... } in rank order
 * @returns {object[]} rows with score, ftsRank, vecRank (1-based or null), best first
 */
export function fuse({ fts = [], vec = [] }, { weights = {}, kindWeights = {}, k = RRF_K, now = Date.now(), halfLifeDays = 180 } = {}) {
  const wf = weights.fts ?? 1;
  const wv = weights.vec ?? 1;
  const wr = weights.recency ?? 0;
  const byId = new Map();
  const take = (list, key) => {
    let rank = 0;
    for (const row of list) {
      const id = String(row.id);
      if (byId.has(id) && byId.get(id)[key] != null) continue;
      rank++;
      const cur = byId.get(id) || { ...row, id, ftsRank: null, vecRank: null };
      cur[key] = rank;
      byId.set(id, cur);
    }
  };
  take(fts, 'ftsRank');
  take(vec, 'vecRank');
  const norm = (wf + wv + wr) / (k + 1) || 1;
  const out = [];
  for (const row of byId.values()) {
    const rrf = (row.ftsRank ? wf / (k + row.ftsRank) : 0) + (row.vecRank ? wv / (k + row.vecRank) : 0);
    const kw = kindWeights[row.kind] ?? 1;
    const prior = wr * recencyPrior(row.date, { now, halfLifeDays }) / (k + 1);
    out.push({ ...row, score: (rrf * kw + prior) / norm });
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The evidence gate. Rows carry `cosine` (vector list) and `coverage` / `rank` (full-text list).
 * A chunk is admitted when either list has strong evidence for it; admitted chunks stay in both
 * lists (keeping their ranks), everything else is removed from both.
 * @returns {{ fts: object[], vec: object[], dropped: number }} dropped = distinct chunks removed
 */
export function admit({ fts = [], vec = [] }, { minCosine = 0, minTermCoverage = 0, minFtsRank = Infinity } = {}) {
  const ok = new Set();
  for (const r of vec) if (Number(r.cosine) >= minCosine) ok.add(String(r.id));
  for (const r of fts) if (Number(r.coverage) >= minTermCoverage || Number(r.rank) >= minFtsRank) ok.add(String(r.id));
  const seen = new Set([...fts, ...vec].map((r) => String(r.id)));
  const keep = (r) => ok.has(String(r.id));
  return { fts: fts.filter(keep), vec: vec.filter(keep), dropped: seen.size - ok.size };
}

/**
 * Keep at most `perMessage` chunks per message and `limit` overall, dropping anything under the
 * floor. `floor` in the result is true when the floor is why fewer than `limit` came back.
 */
export function cut(fused, { limit = 20, floor = 0, perMessage = 3 } = {}) {
  const perMsg = new Map();
  const out = [];
  let dropped = false;
  for (const r of fused) {
    if (out.length >= limit) break;
    if (r.score < floor) { dropped = true; break; }
    const n = perMsg.get(r.messageId) || 0;
    if (n >= perMessage) continue;
    perMsg.set(r.messageId, n + 1);
    out.push(r);
  }
  return { chunks: out, floor: dropped && out.length < limit };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const TRASH_NAME = "(^|[/.])(trash|bin|deleted items|deleted messages|drafts)$";
const SPAM_NAME = "(^|[/.])(spam|junk|junk e-?mail|bulk mail)$";

function toArray(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

function dateOrNull(v, name) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) { const e = new Error(`invalid ${name}`); e.status = 400; throw e; }
  return d;
}

/** Normalised filters; throws 400-style errors for bad dates. */
export function normalizeFilters(f = {}) {
  const people = toArray(f.people).map((p) => p.toLowerCase());
  return {
    people,
    after: dateOrNull(f.after, 'after'),
    before: dateOrNull(f.before, 'before'),
    folders: toArray(f.folders),
    hasAttachment: typeof f.hasAttachment === 'boolean' ? f.hasAttachment : null,
    threadId: f.threadId ? String(f.threadId) : null,
    includeSpam: f.includeSpam === true,
    entityId: f.entityId || null,
    topicId: f.topicId || null,
    excludeThread: f.excludeThread || null,
  };
}

/**
 * WHERE conditions (aliases c = chunk, m = message, a = account) for a user's filters, plus the
 * recipe condition. Mutates `params`; $1 must be the user id.
 */
export function whereSql(f, recipes, params) {
  const out = ['c.user_id = $1', 'a.user_id = $1', 'm.is_deleted = false', `m.folder !~* '${TRASH_NAME}'`];
  params.push(recipes.activeVersion);
  const act = `$${params.length}`;
  if (recipes.targetVersion && recipes.targetVersion !== recipes.activeVersion) {
    // Mid-rebuild: the active recipe, plus new-recipe chunks of messages the old one never covered.
    params.push(recipes.targetVersion);
    out.push(`(c.recipe = ${act} OR (c.recipe = $${params.length} AND NOT EXISTS (
                SELECT 1 FROM hedwig_chunks o WHERE o.message_id = c.message_id AND o.recipe = ${act})))`);
  } else {
    out.push(`c.recipe = ${act}`);
  }
  if (!f.includeSpam) out.push(`c.spam = false AND m.folder !~* '${SPAM_NAME}'`);
  if (f.people.length) {
    const emails = f.people.filter((p) => p.includes('@'));
    const names = f.people.filter((p) => !p.includes('@'));
    const ors = [];
    if (emails.length) {
      params.push(emails);
      const p = `$${params.length}`;
      ors.push(`lower(m.from_email) = ANY(${p}::text[])`);
      ors.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m.to_addresses, '[]'::jsonb) || COALESCE(m.cc_addresses, '[]'::jsonb)) e
                 WHERE lower(CASE WHEN jsonb_typeof(e) = 'string' THEN e #>> '{}' ELSE COALESCE(e->>'address', e->>'email') END) = ANY(${p}::text[]))`);
    }
    for (const n of names) {
      params.push(`%${n.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
      ors.push(`m.from_name ILIKE $${params.length}`);
    }
    out.push(`(${ors.join(' OR ')})`);
  }
  if (f.after) { params.push(f.after); out.push(`m.date >= $${params.length}`); }
  if (f.before) { params.push(f.before); out.push(`m.date < $${params.length}`); }
  if (f.folders.length) { params.push(f.folders); out.push(`m.folder = ANY($${params.length}::text[])`); }
  if (f.hasAttachment != null) { params.push(f.hasAttachment); out.push(`COALESCE(m.has_attachments, false) = $${params.length}`); }
  if (f.threadId) { params.push(f.threadId); out.push(`c.thread_key = $${params.length}`); }
  if (f.excludeThread) { params.push(f.excludeThread); out.push(`c.thread_key <> $${params.length}`); }
  if (f.entityId) {
    params.push(f.entityId);
    out.push(`m.id IN (SELECT me.message_id FROM hedwig_message_entities me JOIN hedwig_entities fe ON fe.id = me.entity_id
                        WHERE fe.user_id = $1 AND fe.id = $${params.length})`);
  }
  if (f.topicId) {
    params.push(f.topicId);
    out.push(`m.id IN (SELECT tm.message_id FROM hedwig_topic_members tm JOIN hedwig_topics ft ON ft.id = tm.topic_id
                        WHERE ft.user_id = $1 AND ft.id = $${params.length})`);
  }
  return out.join('\n        AND ');
}

const CHUNK_COLS = `c.id, c.message_id, c.thread_key, c.kind, c.ordinal, c.attachment_index, c.text, m.date, m.in_reply_to, m.account_id`;
const FROM = `FROM hedwig_chunks c JOIN messages m ON m.id = c.message_id JOIN email_accounts a ON a.id = m.account_id`;

/**
 * Full-text hits with `rank` (ts_rank_cd normalised to [0, 1), plus 0.5 for a phrase match) and
 * `coverage`, the share of the query's words the chunk contains (words the text-search config
 * reduces to nothing, e.g. its stopwords, are not counted).
 */
async function ftsSearch(userId, q, f, recipes, depth) {
  const orq = buildOrQuery(q);
  if (!orq) return [];
  const cfgName = await tsConfig();
  const params = [userId, orq, phraseOf(q), depth, cfgName, orq.split(' | ')];
  const where = whereSql(f, recipes, params);
  const { rows } = await query(
    `SELECT ${CHUNK_COLS},
            ts_rank_cd('{0.1, 0.3, 0.6, 1.0}', c.tsv, q, 32)
              + CASE WHEN $3 <> '' AND c.tsv @@ phraseto_tsquery($5::regconfig, $3) THEN 0.5 ELSE 0 END AS rank,
            (SELECT COUNT(*) FROM unnest(t.tqs) w(tq) WHERE c.tsv @@ w.tq)::float8 / GREATEST(cardinality(t.tqs), 1) AS coverage
       ${FROM}, to_tsquery($5::regconfig, $2) q,
       (SELECT COALESCE(array_agg(tq), '{}') AS tqs
          FROM (SELECT to_tsquery($5::regconfig, w) AS tq FROM unnest($6::text[]) w) s WHERE numnode(tq) > 0) t
      WHERE c.tsv @@ q
        AND ${where}
      ORDER BY rank DESC, m.date DESC NULLS LAST
      LIMIT $4`,
    params,
  );
  return rows;
}

const SELECTIVE = (f) => Boolean(f.threadId || f.people.length || f.folders.length || f.entityId || f.topicId);

/** Vector hits with `dist` (cosine distance), plus the embedding model that made the query vector. */
async function vecSearch(userId, q, f, recipes, depth) {
  if (!recipes.vectors) return { rows: [], model: null };
  const e = await embedQuery(q);
  if (!e || e.dims !== VECTOR_DIMS) return { rows: [], model: null };
  return { rows: await vecRows(userId, e, f, recipes, depth), model: e.model };
}

async function vecRows(userId, e, f, recipes, depth) {
  const lit = toVectorLiteral(e.vector);
  const params = [userId, lit, depth, recipes.vecRecipe];
  const where = whereSql(f, recipes, params);
  if (SELECTIVE(f)) {
    // A narrow filter: rank the small candidate set exactly instead of walking the HNSW graph.
    const { rows } = await query(
      `WITH cand AS MATERIALIZED (SELECT ${CHUNK_COLS} ${FROM} WHERE ${where})
       SELECT cand.*, v.vector <=> $2::vector(${VECTOR_DIMS}) AS dist
         FROM cand JOIN hedwig_chunk_vectors v ON v.chunk_id = cand.id AND v.recipe = $4
        ORDER BY dist LIMIT $3`,
      params,
    );
    return rows;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // pgvector ≥ 0.8: keep walking the graph until enough rows pass the per-user filter.
    await client.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', '100', true)").catch(() => {});
    const { rows } = await client.query(
      `SELECT ${CHUNK_COLS}, v.vector <=> $2::vector(${VECTOR_DIMS}) AS dist
         FROM hedwig_chunk_vectors v JOIN hedwig_chunks c ON c.id = v.chunk_id
         JOIN messages m ON m.id = c.message_id JOIN email_accounts a ON a.id = m.account_id
        WHERE v.user_id = $1 AND v.recipe = $4 AND ${where}
        ORDER BY v.vector <=> $2::vector(${VECTOR_DIMS})
        LIMIT $3`,
      params,
    );
    await client.query('COMMIT');
    return rows.sort((x, y) => x.dist - y.dist);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Neighbour chunks (same message, kind and attachment, ordinal ± 1) and the replied-to message. */
async function expand(userId, primary, f, recipes) {
  if (!primary.length) return [];
  const params = [userId];
  const where = whereSql(f, recipes, params);
  params.push(primary.map((p) => p.messageId), primary.map((p) => p.kind), primary.map((p) => p.attachmentIndex ?? -1),
    primary.map((p) => p.ordinal), primary.map((p) => p.chunkId));
  const n = params.length;
  const { rows: neighbours } = await query(
    `SELECT ${CHUNK_COLS}, p.pid AS parent
       ${FROM}
       JOIN UNNEST($${n - 4}::uuid[], $${n - 3}::text[], $${n - 2}::int[], $${n - 1}::int[], $${n}::bigint[]) AS p(mid, kind, ai, ord, pid)
         ON c.message_id = p.mid AND c.kind = p.kind AND COALESCE(c.attachment_index, -1) = p.ai AND c.ordinal IN (p.ord - 1, p.ord + 1)
      WHERE ${where}`,
    params,
  );
  const replyTo = [...new Map(primary.filter((p) => p.inReplyTo).map((p) => [p.inReplyTo, p])).values()];
  let parents = [];
  if (replyTo.length) {
    const p2 = [userId];
    const w2 = whereSql(f, recipes, p2);
    p2.push(replyTo.map((p) => p.inReplyTo), replyTo.map((p) => p.chunkId));
    const { rows } = await query(
      `SELECT DISTINCT ON (r.pid) ${CHUNK_COLS}, r.pid AS parent
         ${FROM}
         JOIN UNNEST($${p2.length - 1}::text[], $${p2.length}::bigint[]) AS r(mid, pid) ON m.message_id = r.mid
        WHERE c.kind IN ('body','header') AND ${w2}
        ORDER BY r.pid, (c.kind = 'body') DESC, c.ordinal`,
      p2,
    );
    parents = rows;
  }
  return [...neighbours, ...parents];
}

const shape = (r, extra = {}) => ({
  chunkId: Number(r.id),
  messageId: r.message_id,
  threadId: r.thread_key,
  kind: r.kind,
  ordinal: r.ordinal,
  attachmentIndex: r.attachment_index,
  text: r.text,
  date: r.date,
  ...extra,
});

/**
 * Hybrid retrieval over the caller's chunk index.
 * @param {{ userId: string, query: string, filters?: object, limit?: number, expandThreads?: boolean }} opts
 * @returns {Promise<{ chunks: object[], floor: boolean }>}
 */
export async function retrieve({ userId, query: q, filters = {}, limit = 20, expandThreads = true } = {}) {
  if (!userId) throw new Error('retrieve needs a userId');
  const text = typeof q === 'string' ? q.trim().slice(0, 500) : '';
  if (!text) return { chunks: [], floor: false };
  const f = normalizeFilters(filters);
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const cfg = await getConfig(userId);
  const recipes = await recipesFor(userId);
  const depth = Math.max(n * 4, 40);
  const [fts, vec] = await Promise.all([
    ftsSearch(userId, text, f, recipes, depth),
    vecSearch(userId, text, f, recipes, depth).catch((err) => {
      console.warn('[hedwig] retrieve: vector search failed, using full text only:', err.message);
      return { rows: [], model: null };
    }),
  ]);
  const toRow = (r) => ({ ...r, id: String(r.id), messageId: r.message_id });
  // Hash vectors are lexical, with a much lower cosine scale than a real embedding model.
  const lexical = /^hash-/.test(vec.model || '');
  const gated = admit({
    fts: fts.map(toRow),
    vec: vec.rows.map((r) => ({ ...toRow(r), cosine: 1 - Number(r.dist) })),
  }, {
    minCosine: cfg[lexical ? 'index.minCosineHash' : 'index.minCosine'] ?? 0,
    minTermCoverage: cfg['index.minTermCoverage'] ?? 0,
    minFtsRank: cfg['index.minFtsRank'] ?? Infinity,
  });
  const fused = fuse(gated, {
    weights: cfg['index.rrfWeights'] || {},
    kindWeights: cfg['index.kindWeights'] || {},
    halfLifeDays: cfg['index.recencyHalfLifeDays'],
  });
  const { chunks: top, floor: cutShort } = cut(fused, { limit: n, floor: cfg['index.floor'] });
  const floor = cutShort || (gated.dropped > 0 && top.length < n);
  const primary = top.map((r) => shape(r, { score: round(r.score), ftsRank: r.ftsRank, vecRank: r.vecRank, inReplyTo: r.in_reply_to || null }));
  let expanded = [];
  if (expandThreads && primary.length) {
    const have = new Set(primary.map((p) => p.chunkId));
    const scoreOf = new Map(primary.map((p) => [p.chunkId, p.score]));
    for (const r of await expand(userId, primary, f, recipes)) {
      const id = Number(r.id);
      if (have.has(id)) continue;
      have.add(id);
      const parent = Number(r.parent);
      expanded.push(shape(r, { score: round((scoreOf.get(parent) || 0) * 0.5), ftsRank: null, vecRank: null, expandedFrom: parent }));
    }
    expanded = expanded.sort((a, b) => b.score - a.score);
  }
  // eslint-disable-next-line no-unused-vars
  return { chunks: [...primary, ...expanded].map(({ inReplyTo, ...c }) => c), floor };
}

const round = (x) => Math.round(x * 1e5) / 1e5;

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);

/** Index progress for one user: per-folder coverage with percentages, totals, recipe, pending. */
export async function indexStatus(userId) {
  const { rows } = await query(
    `SELECT c.account_id, a.name AS account_name, a.email_address, c.folder, c.spam, c.state, c.cursor,
            c.total, c.seen, c.dupes, c.bodies, c.body_failed, c.chunked, c.embedded, c.error, c.updated_at
       FROM hedwig_index_coverage c JOIN email_accounts a ON a.id = c.account_id
      WHERE c.user_id = $1 AND a.user_id = $1
      ORDER BY a.name, c.spam, c.folder`,
    [userId],
  );
  const recipes = await recipesFor(userId);
  const cur = recipes.current;
  const { rows: tot } = await query(
    `SELECT (SELECT COUNT(*) FROM hedwig_chunks WHERE user_id = $1)::int AS chunks,
            (SELECT COUNT(*) FROM hedwig_msg h LEFT JOIN hedwig_index_msg x ON x.message_id = h.message_id
              WHERE h.user_id = $1 AND (h.skip_reason IS NULL OR h.skip_reason = 'spam')
                AND (x.message_id IS NULL OR x.chunk_version IS DISTINCT FROM $2
                     OR ($4 AND x.embed_recipe IS DISTINCT FROM $3)))::int AS unindexed,
            (SELECT COUNT(*) FROM hedwig_chunk_vectors WHERE user_id = $1)::int AS vectors,
            (SELECT COUNT(*) FROM hedwig_attachment_text t JOIN messages m ON m.id = t.message_id
               JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND t.text IS NOT NULL)::int AS attachments`,
    [userId, cur.version, cur.full, cur.vectors],
  );
  const coverage = rows.map((r) => ({
    accountId: r.account_id,
    account: r.account_name || r.email_address,
    folder: r.folder,
    spam: r.spam,
    state: r.state,
    cursor: r.cursor,
    total: r.total,
    seen: r.seen,
    duplicates: r.dupes,
    bodies: r.bodies,
    bodyFailed: r.body_failed,
    chunked: r.chunked,
    embedded: r.embedded,
    error: r.error,
    updatedAt: r.updated_at,
    pct: {
      seen: pct(r.seen, r.total),
      bodies: pct(r.bodies + r.body_failed, r.total),
      chunked: pct(r.chunked, r.total - r.dupes),
      embedded: pct(r.embedded, r.total - r.dupes),
    },
  }));
  const sum = (k) => coverage.reduce((s, r) => s + (r[k] || 0), 0);
  const total = sum('total');
  const indexable = total - sum('duplicates');
  const chunked = sum('chunked');
  const embedded = sum('embedded');
  const embedError = await getState('index.embedError', null).catch(() => null);
  return {
    coverage,
    total,
    chunked,
    embedded,
    // Not yet seen by the scanner, plus seen but not fully chunked/embedded under the current recipe.
    pending: Math.max(0, total - sum('seen')) + tot[0].unindexed,
    pct: { chunked: pct(chunked, indexable), embedded: pct(embedded, indexable) },
    recipe: { active: recipes.active, target: recipes.current.full, vectors: recipes.vectors, note: recipes.current.reason },
    chunks: tot[0].chunks,
    vectors: tot[0].vectors,
    attachments: tot[0].attachments,
    embedError: embedError?.error || null,
    done: coverage.length > 0 && coverage.every((r) => r.state === 'done' || r.state === 'paused'),
  };
}

export { messageParts } from './parse.js';

/**
 * Recent attachments whose text Tika extracted, for Brief cards: newest first, with a short excerpt.
 * @returns {Promise<{ messageId: string, attachmentIndex: number, filename: string, mime: string, chars: number, excerpt: string, date: string, from: string, subject: string, threadId: string }[]>}
 */
export async function attachmentCards(userId, { days = 7, limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT t.message_id, t.attachment_index, t.filename, t.mime, t.chars, LEFT(t.text, 400) AS excerpt,
            m.date, m.subject, m.thread_key, COALESCE(m.from_name, m.from_email) AS from_who
       FROM hedwig_attachment_text t
       JOIN messages m ON m.id = t.message_id
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.is_deleted = false AND t.text IS NOT NULL AND t.chars > 0
        AND m.date >= NOW() - make_interval(days => $2::int)
        AND m.folder !~* '${SPAM_NAME}' AND m.folder !~* '${TRASH_NAME}'
        AND NOT EXISTS (SELECT 1 FROM hedwig_index_msg x WHERE x.message_id = m.id AND x.spam)
      ORDER BY m.date DESC
      LIMIT $3`,
    [userId, Math.max(1, Math.min(365, Number(days) || 7)), Math.max(1, Math.min(50, Number(limit) || 10))],
  );
  return rows.map((r) => ({
    messageId: r.message_id,
    attachmentIndex: r.attachment_index,
    filename: r.filename,
    mime: r.mime,
    chars: r.chars,
    excerpt: String(r.excerpt || '').replace(/\s+/g, ' ').trim(),
    date: r.date,
    from: r.from_who,
    subject: r.subject,
    threadId: r.thread_key,
  }));
}
