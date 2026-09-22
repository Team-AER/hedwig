// Pipeline step `embed` and its catch-up schedule.
//
// Messages synced header-only have no body yet. They are embedded from what is there (subject and
// snippet), their body is requested from the API process, and the catch-up pass re-embeds them
// once the body has arrived (hedwig_msg.text_hash starts with 'partial:' until then).
import { createHash } from 'crypto';
import { pool, query } from '../../services/db.js';
import { embed, embeddingProfile, toVectorLiteral } from '../embeddings.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { messageHeader, messageText } from '../text.js';
import { requestBody } from '../core/bodies.js';
import { contextEnabled, groupByUser } from './entities.js';
import { isBulkMessage } from './util.js';

// pgvector's HNSW indexes vectors of up to 2000 dimensions.
const HNSW_MAX_DIMS = 2000;
const ensured = new Set();

/** Create the per-dimension HNSW index once per process. Safe to call repeatedly. */
export async function ensureVectorIndex(dims) {
  if (!Number.isInteger(dims) || dims < 1 || ensured.has(dims)) return;
  if (dims > HNSW_MAX_DIMS) {
    console.warn(`[hedwig] context: ${dims}-dim embeddings exceed HNSW's ${HNSW_MAX_DIMS}; vector search will scan`);
    ensured.add(dims);
    return;
  }
  const client = await pool.connect();
  try {
    // Building over an existing table can take longer than the pool's statement timeout.
    await client.query('SET statement_timeout = 0');
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_hedwig_embeddings_hnsw_${dims} ON hedwig_embeddings
         USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) WHERE dims = ${dims}`,
    );
    ensured.add(dims);
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

const hasBody = (r) => r.body_text != null || r.body_html != null;

export function embedInput(row, { allowEmpty = false } = {}) {
  const text = messageText(row);
  if (text) return `${messageHeader(row)}\n\n${text}`;
  // A body that renders to nothing (image-only mail) will not improve; embed the header alone.
  return allowEmpty ? messageHeader(row) : null;
}

/** Embed rows and store the vectors. Rows without any text are left for the catch-up pass. */
export async function embedRows(rows, { catchUp = false } = {}) {
  const profile = await embeddingProfile();
  if (!profile || !rows.length) return 0;
  const todo = [];
  for (const r of rows) {
    if (!hasBody(r) && !catchUp && !isBulkMessage(r)) await requestBody(r.id);
    const input = embedInput(r, { allowEmpty: catchUp && hasBody(r) });
    if (input) todo.push({ row: r, input });
  }
  if (!todo.length) return 0;
  const out = await embed(todo.map((t) => t.input));
  if (!out) return 0;
  await ensureVectorIndex(out.dims);
  const hashes = todo.map((t) => `${hasBody(t.row) ? '' : 'partial:'}${createHash('sha1').update(t.input).digest('hex')}`);
  await query(
    `INSERT INTO hedwig_embeddings (message_id, user_id, model, dims, embedding)
     SELECT x.id, x.user_id, $3, $4, x.vec::vector FROM UNNEST($1::uuid[], $2::uuid[], $5::text[]) AS x(id, user_id, vec)
     ON CONFLICT (message_id) DO UPDATE SET model = EXCLUDED.model, dims = EXCLUDED.dims,
       embedding = EXCLUDED.embedding, created_at = NOW()`,
    [todo.map((t) => t.row.id), todo.map((t) => t.row.user_id), out.model, out.dims, out.vectors.map(toVectorLiteral)],
  );
  await query(
    `UPDATE hedwig_msg h SET embedded_at = NOW(), text_hash = x.hash
       FROM UNNEST($1::uuid[], $2::text[]) AS x(id, hash) WHERE h.message_id = x.id`,
    [todo.map((t) => t.row.id), hashes],
  );
  return todo.length;
}

export async function runEmbedStep(rows) {
  const eligible = [];
  for (const [userId, userRows] of groupByUser(rows)) {
    if (await contextEnabled(userId)) eligible.push(...userRows);
  }
  await embedRows(eligible);
}

/**
 * Catch-up: messages never embedded (provider was down), embedded before their body arrived, or
 * embedded by a different model than the one configured now. Bounded per run, newest first.
 */
export async function embedCatchUp({ limit = 64 } = {}) {
  const profile = await embeddingProfile();
  if (!profile) return 0;
  const { rows: users } = await query('SELECT DISTINCT user_id FROM email_accounts');
  let done = 0;
  for (const { user_id: userId } of users) {
    if (done >= limit) break;
    const cfg = await contextEnabled(userId);
    if (!cfg) continue;
    const { rows } = await query(
      `SELECT ${MESSAGE_COLUMNS}
         FROM hedwig_msg h
         JOIN messages m ON m.id = h.message_id
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         LEFT JOIN hedwig_embeddings e ON e.message_id = h.message_id
        WHERE h.user_id = $1 AND h.skip_reason IS NULL AND m.is_deleted = false
          AND m.date >= NOW() - make_interval(days => $3)
          AND (
            (h.embedded_at IS NULL AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL OR COALESCE(m.snippet, '') <> ''))
            OR (h.text_hash LIKE 'partial:%' AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL))
            OR (e.message_id IS NOT NULL AND e.model <> $4)
          )
        ORDER BY m.date DESC NULLS LAST
        LIMIT $2`,
      [userId, limit - done, cfg['pipeline.backfillDays'], profile.model],
    );
    if (!rows.length) continue;
    await decorate(rows);
    done += await embedRows(rows, { catchUp: true });
    // Topics created before their first vector existed get one now.
    await query(
      `UPDATE hedwig_topics t SET centroid = e.embedding, dims = e.dims, updated_at = NOW()
         FROM hedwig_topic_members tm JOIN hedwig_embeddings e ON e.message_id = tm.message_id
        WHERE tm.topic_id = t.id AND t.user_id = $1 AND t.centroid IS NULL AND tm.message_id = ANY($2::uuid[])`,
      [userId, rows.map((r) => r.id)],
    );
  }
  return done;
}
