// Writing the index: chunks (with weighted tsvectors), thread rollups, chunk vectors, and the
// sweeps that keep them complete. Every message Hedwig has seen gets chunked and embedded,
// whatever its age; pipeline.backfillDays only limits the model steps in other modules.
import { pool, query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { embed, toVectorLiteral, EmbeddingError } from '../embeddings.js';
import { getState, setState } from '../state.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { splitBody } from './parse.js';
import { buildMessageChunks, buildThreadRollup } from './chunk.js';
import { currentRecipe } from './recipe.js';

const SPAM_NAME = /(^|[/.])(spam|junk|junk e-?mail|bulk mail)$/i;
const TS_WEIGHT = { header: 'B', body: 'B', thread: 'B', attachment: 'C', quote: 'D' };

export const isSpamRow = (r) => Boolean(r.coverage_spam) || r.special_use === '\\Junk' || SPAM_NAME.test(String(r.folder || ''));
const hasBody = (r) => r.body_text != null || r.body_html != null;

let tsConfigCache = null; // { name, at }

/** The configured text-search configuration if Postgres knows it, else 'simple'. */
export async function tsConfig() {
  const cfg = await getConfig();
  const want = String(cfg['index.tsConfig'] || 'simple');
  if (tsConfigCache && tsConfigCache.want === want && Date.now() - tsConfigCache.at < 300_000) return tsConfigCache.name;
  let name = 'simple';
  try {
    const { rows } = await query('SELECT cfgname FROM pg_ts_config WHERE cfgname = $1', [want]);
    if (rows.length) name = want;
    else console.warn(`[hedwig] index: text-search config "${want}" does not exist; using simple`);
  } catch { /* keep simple */ }
  tsConfigCache = { want, name, at: Date.now() };
  return name;
}

async function chunkOptions() {
  const cfg = await getConfig();
  return { maxTokens: cfg['index.chunkTokens'], overlap: cfg['index.chunkOverlap'], maxChunks: cfg['index.maxChunksPerMessage'] };
}

async function attachmentTexts(messageIds) {
  if (!messageIds.length) return new Map();
  const { rows } = await query(
    `SELECT message_id, attachment_index, filename, text FROM hedwig_attachment_text
      WHERE message_id = ANY($1::uuid[]) AND text IS NOT NULL AND text <> '' ORDER BY message_id, attachment_index`,
    [messageIds],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push({ index: r.attachment_index, filename: r.filename, text: r.text });
  }
  return map;
}

async function insertChunks(client, chunks, version, cfgName) {
  if (!chunks.length) return [];
  const col = (k) => chunks.map((c) => c[k]);
  const { rows } = await client.query(
    `INSERT INTO hedwig_chunks (message_id, user_id, thread_key, kind, ordinal, attachment_index, text, tokens, tsv, recipe, spam, msg_date)
     SELECT x.mid, x.uid, x.tk, x.kind, x.ord, x.ai, x.text, x.tokens,
            setweight(to_tsvector($14::regconfig, x.subj), 'A') || setweight(to_tsvector($14::regconfig, x.body), x.w::"char"),
            $15, x.spam, x.d
       FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::int[], $6::int[], $7::text[], $8::int[],
                   $9::text[], $10::text[], $11::text[], $12::bool[], $13::timestamptz[])
         AS x(mid, uid, tk, kind, ord, ai, text, tokens, subj, body, w, spam, d)
     RETURNING id, message_id`,
    [col('messageId'), col('userId'), col('threadKey'), col('kind'), col('ordinal'), col('attachmentIndex'),
      col('text').map(stripNul), col('tokens'), col('tsSubject').map(stripNul), col('tsBody').map(stripNul),
      chunks.map((c) => TS_WEIGHT[c.kind] || 'B'), col('spam'), col('date'), cfgName, version],
  );
  return rows;
}

const stripNul = (s) => String(s ?? '').replace(/\0/g, '');

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * (Re)chunk a batch of message rows (MESSAGE_COLUMNS) under the current chunker version, then
 * refresh the rollups of the threads they belong to. A message that fails to parse records its
 * error and the rest of the batch continues.
 * @returns {Promise<{ messages: number, chunks: number, chunkIds: number[] }>}
 */
export async function indexMessages(rows) {
  if (!rows.length) return { messages: 0, chunks: 0, chunkIds: [] };
  const recipe = await currentRecipe();
  const opts = await chunkOptions();
  const cfgName = await tsConfig();
  const atts = await attachmentTexts(rows.map((r) => r.id));
  const all = [];
  const state = [];
  for (const r of rows) {
    try {
      const parts = splitBody(r);
      const chunks = buildMessageChunks(r, parts, atts.get(r.id) || [], opts);
      for (const c of chunks) all.push({ ...c, messageId: r.id, userId: r.user_id, threadKey: r.thread_key, spam: isSpamRow(r), date: r.date });
      state.push({ r, chunks: chunks.length, error: null });
    } catch (err) {
      state.push({ r, chunks: 0, error: `parse: ${err.message}`.slice(0, 500) });
    }
  }
  const ids = state.map((s) => s.r.id);
  const inserted = await inTransaction(async (client) => {
    // Same-version chunks are replaced; older versions stay until the user's rebuild completes.
    await client.query(
      "DELETE FROM hedwig_chunks WHERE message_id = ANY($1::uuid[]) AND recipe = $2 AND kind <> 'thread'",
      [ids, recipe.version],
    );
    const out = await insertChunks(client, all, recipe.version, cfgName);
    await client.query(
      `INSERT INTO hedwig_index_msg (message_id, user_id, account_id, thread_key, msg_date, spam, chunk_version, had_body, chunks, chunked_at, embed_recipe, error)
       SELECT x.id, x.uid, x.aid, x.tk, x.d, x.spam, CASE WHEN x.err IS NULL THEN $10 END, x.body, x.n, NOW(), NULL, x.err
         FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[], $6::bool[], $7::bool[], $8::int[], $9::text[])
           AS x(id, uid, aid, tk, d, spam, body, n, err)
       ON CONFLICT (message_id) DO UPDATE SET thread_key = EXCLUDED.thread_key, msg_date = EXCLUDED.msg_date, spam = EXCLUDED.spam,
         chunk_version = EXCLUDED.chunk_version, had_body = EXCLUDED.had_body, chunks = EXCLUDED.chunks,
         chunked_at = NOW(), embed_recipe = NULL, error = EXCLUDED.error, updated_at = NOW()`,
      [ids, state.map((s) => s.r.user_id), state.map((s) => s.r.account_id), state.map((s) => s.r.thread_key),
        state.map((s) => s.r.date), state.map((s) => isSpamRow(s.r)), state.map((s) => hasBody(s.r)),
        state.map((s) => s.chunks), state.map((s) => s.error), recipe.version],
    );
    return out;
  });
  await refreshThreads(rows.map((r) => ({ userId: r.user_id, threadKey: r.thread_key })));
  return { messages: rows.length, chunks: inserted.length, chunkIds: inserted.map((r) => Number(r.id)) };
}

/**
 * Rebuild the rollup chunk of each thread (one per thread with two or more messages). The rollup
 * hangs off the newest message so it is deleted with the thread.
 */
export async function refreshThreads(threads) {
  const seen = new Set();
  const byUser = new Map();
  for (const t of threads) {
    if (!t.threadKey || !t.userId) continue;
    const key = `${t.userId}|${t.threadKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byUser.has(t.userId)) byUser.set(t.userId, []);
    byUser.get(t.userId).push(t.threadKey);
  }
  if (!byUser.size) return 0;
  const recipe = await currentRecipe();
  const opts = await chunkOptions();
  const cfgName = await tsConfig();
  let built = 0;
  for (const [userId, keys] of byUser) {
    const { rows } = await query(
      `SELECT ${MESSAGE_COLUMNS}, x.spam AS index_spam
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         JOIN hedwig_index_msg x ON x.message_id = m.id
        WHERE a.user_id = $1 AND m.thread_key = ANY($2::text[]) AND m.is_deleted = false
        ORDER BY m.date ASC NULLS FIRST`,
      [userId, keys],
    );
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.thread_key)) groups.set(r.thread_key, { list: [], mids: new Set() });
      const g = groups.get(r.thread_key);
      // Copies of one message (Sent + INBOX, Gmail labels) count once.
      if (r.message_id && g.mids.has(r.message_id)) continue;
      if (r.message_id) g.mids.add(r.message_id);
      g.list.push(r);
    }
    const inserts = [];
    const owners = [];
    for (const key of keys) {
      const list = groups.get(key)?.list || [];
      const rollup = list.length >= 2
        ? buildThreadRollup(list.slice(-50).map((row) => ({ row, newText: safeNewText(row) })), opts)
        : null;
      if (rollup) {
        const owner = list[list.length - 1];
        owners.push(owner.id);
        inserts.push({ ...rollup, messageId: owner.id, userId, threadKey: key, spam: list.every((r) => r.index_spam), date: owner.date });
      }
    }
    await inTransaction(async (client) => {
      await client.query(
        "DELETE FROM hedwig_chunks WHERE user_id = $1 AND kind = 'thread' AND thread_key = ANY($2::text[]) AND recipe = $3",
        [userId, keys, recipe.version],
      );
      await insertChunks(client, inserts, recipe.version, cfgName);
      if (owners.length) {
        await client.query('UPDATE hedwig_index_msg SET embed_recipe = NULL, updated_at = NOW() WHERE message_id = ANY($1::uuid[])', [owners]);
      }
    });
    built += inserts.length;
  }
  return built;
}

function safeNewText(row) {
  try { return splitBody(row).newText; } catch { return row.snippet || ''; }
}

const EMBED_BACKOFF = 'index.embedBackoff';

/**
 * An embedding error caused by the input itself: the batch is split to find the bad chunk. Other
 * 4xx (401/403/404: wrong key or URL), 408/429 and 5xx, connection failures and malformed replies
 * are outages or configuration: splitting would only multiply the requests.
 */
export function isInputError(err) {
  return [400, 413, 422].includes(Number(err?.status));
}

/** How long to leave the embedding endpoint alone after `failures` outages in a row. */
export function embedBackoffMs(failures, retryAfterSec) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return Math.min(retryAfterSec, 3600) * 1000;
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Embed chunks that lack a vector for the current recipe, newest mail first, and mark messages
 * whose chunks are all embedded. Returns the number of chunks embedded.
 *
 * Failures: a 400/413/422 on a batch is split one chunk at a time and only the failing messages are
 * marked. Anything else (rate limit, 5xx, connection) is rethrown and backs the endpoint off
 * (index.embedBackoff in hedwig_state: 30 s doubling to 15 min, or the server's Retry-After); until
 * then both the sweep and the live pipeline step skip embedding (the sweep catches up afterwards).
 * @param {{ messageIds?: string[], maxChunks?: number }} [opts]
 */
export async function embedPending({ messageIds = null, maxChunks = 256 } = {}) {
  const recipe = await currentRecipe();
  if (!recipe.vectors) return 0;
  const backoff = await getState(EMBED_BACKOFF, null).catch(() => null);
  if (backoff?.until && Date.parse(backoff.until) > Date.now()) return 0;
  const cfg = await getConfig();
  let ids = messageIds;
  if (!ids) {
    const { rows } = await query(
      `SELECT message_id FROM hedwig_index_msg WHERE embed_recipe IS NULL AND chunk_version = $1 AND error IS NULL
        ORDER BY msg_date DESC NULLS LAST LIMIT $2`,
      [recipe.version, Math.max(8, Math.ceil(maxChunks / 3))],
    );
    ids = rows.map((r) => r.message_id);
  }
  if (!ids.length) return 0;
  const { rows: chunks } = await query(
    `SELECT c.id, c.user_id, c.message_id, c.text FROM hedwig_chunks c
      WHERE c.message_id = ANY($1::uuid[]) AND c.recipe = $2
        AND NOT EXISTS (SELECT 1 FROM hedwig_chunk_vectors v WHERE v.chunk_id = c.id AND v.recipe = $3)
      ORDER BY c.msg_date DESC NULLS LAST, c.id
      LIMIT $4`,
    [ids, recipe.version, recipe.full, maxChunks],
  );
  const batch = cfg['index.embedBatch'];
  const store = async (slice, out) => {
    await query(
      `INSERT INTO hedwig_chunk_vectors (chunk_id, user_id, model, recipe, dims, vector)
       SELECT x.id, x.uid, $3, $4, $5, x.vec::vector FROM UNNEST($1::bigint[], $2::uuid[], $6::text[]) AS x(id, uid, vec)
       ON CONFLICT (chunk_id, recipe) DO UPDATE SET vector = EXCLUDED.vector, model = EXCLUDED.model, created_at = NOW()`,
      [slice.map((c) => c.id), slice.map((c) => c.user_id), out.model, recipe.full, out.dims, out.vectors.map(toVectorLiteral)],
    );
  };
  let done = 0;
  try {
    for (let i = 0; i < chunks.length; i += batch) {
      const slice = chunks.slice(i, i + batch);
      let out;
      try {
        out = await embed(slice.map((c) => c.text));
      } catch (err) {
        if (!isInputError(err)) throw err;
        // One bad input must not block the queue: retry one by one and mark only the failing
        // messages. An outage met on the way stops the split (rethrow, backoff below).
        const failed = [];
        if (slice.length === 1) failed.push({ c: slice[0], e: err });
        else {
          for (const c of slice) {
            try {
              const one = await embed([c.text]);
              if (one) { await store([c], one); done++; }
            } catch (e) {
              if (!isInputError(e)) throw e;
              failed.push({ c, e });
            }
          }
        }
        if (!failed.length) continue;
        await query(
          `UPDATE hedwig_index_msg SET error = LEFT($2, 500), updated_at = NOW() WHERE message_id = ANY($1::uuid[])`,
          [[...new Set(failed.map((f) => f.c.message_id))], `embed: ${failed[0].e.message}`],
        );
        continue;
      }
      if (!out) return done;
      await store(slice, out);
      done += slice.length;
    }
    await setState('index.embedError', null).catch(() => {});
    if (backoff) await setState(EMBED_BACKOFF, null).catch(() => {});
  } catch (err) {
    await setState('index.embedError', { error: String(err.message).slice(0, 500), at: new Date().toISOString() }).catch(() => {});
    if (err instanceof EmbeddingError && !isInputError(err)) {
      const failures = (Number(backoff?.failures) || 0) + 1;
      const ms = embedBackoffMs(failures, err.retryAfterSec);
      await setState(EMBED_BACKOFF, { until: new Date(Date.now() + ms).toISOString(), failures, error: String(err.message).slice(0, 300) }).catch(() => {});
      console.warn(`[hedwig] index: embeddings unavailable (${err.message}); pausing embedding for ${Math.round(ms / 1000)} s`);
    }
    throw err;
  } finally {
    await query(
      `UPDATE hedwig_index_msg x SET embed_recipe = $2, embedded_at = NOW(), updated_at = NOW()
        WHERE x.message_id = ANY($1::uuid[]) AND x.chunk_version = $3
          AND NOT EXISTS (SELECT 1 FROM hedwig_chunks c WHERE c.message_id = x.message_id AND c.recipe = $3
                           AND NOT EXISTS (SELECT 1 FROM hedwig_chunk_vectors v WHERE v.chunk_id = c.id AND v.recipe = $2))`,
      [ids, recipe.full, recipe.version],
    ).catch(() => {});
  }
  return done;
}

/**
 * Messages Hedwig has seen that need (re)chunking: never chunked (including everything seen before
 * the index existed), chunked under another version, marked dirty (attachment text arrived), or
 * chunked before their body arrived. Newest first.
 */
export async function chunkPending({ limit = 100 } = {}) {
  const recipe = await currentRecipe();
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, (h.skip_reason = 'spam') AS coverage_spam
       FROM hedwig_msg h
       JOIN messages m ON m.id = h.message_id
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       LEFT JOIN hedwig_index_msg x ON x.message_id = h.message_id
      WHERE (h.skip_reason IS NULL OR h.skip_reason = 'spam') AND m.is_deleted = false
        AND (x.message_id IS NULL
             OR (x.chunk_version IS NULL AND x.error IS NULL)
             OR x.chunk_version <> $2
             OR (x.had_body = false AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL)))
      ORDER BY m.date DESC NULLS LAST
      LIMIT $1`,
    [limit, recipe.version],
  );
  if (!rows.length) return 0;
  await decorate(rows);
  await indexMessages(rows);
  return rows.length;
}

/** Run `fn` repeatedly while it reports work, within a time budget. */
export async function drain(fn, { budgetMs = 8000, maxRounds = 20 } = {}) {
  const started = Date.now();
  let total = 0;
  for (let i = 0; i < maxRounds && Date.now() - started < budgetMs; i++) {
    const n = await fn();
    total += n;
    if (!n) break;
  }
  return total;
}
