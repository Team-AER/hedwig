// Read side of the context engine: entity and topic cards, message context, lists.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { embeddingProfile, fromVectorLiteral } from '../embeddings.js';
import { messageText } from '../text.js';
import { vectorIds } from './search.js';
import { visibleCommitment } from './commitments.js';
import {
  COMMITMENT_ORDER, COMMITMENT_SELECT, ENTITY_LITE_SELECT, FACT_SELECT, MESSAGE_LITE_SELECT,
  loadMessagesLite, toCommitment, toEntityLite, toFact, toMessageLite,
} from './shapes.js';
import { cleanSubject, clampInt, gistOf, httpError, isUuid } from './util.js';

const ENTITY_KINDS = ['person', 'org', 'self'];

/** EntityLite[] matching a name, address or domain; most relevant people first. */
export async function findEntities(userId, q, limit = 20, { kind = null } = {}) {
  if (kind && !ENTITY_KINDS.includes(kind)) throw httpError(400, 'invalid kind');
  const text = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 200) : '';
  const params = [userId, clampInt(limit, 1, 200, 20)];
  const where = ['e.user_id = $1'];
  if (kind) { params.push(kind); where.push(`e.kind = $${params.length}`); }
  let rank = '0';
  if (text) {
    params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, text);
    const like = `$${params.length - 1}`;
    const exact = `$${params.length}`;
    where.push(`(lower(e.display_name) LIKE ${like} OR lower(e.primary_email) LIKE ${like} OR lower(e.domain) LIKE ${like}
                 OR EXISTS (SELECT 1 FROM hedwig_entity_addresses ea WHERE ea.entity_id = e.id AND ea.email LIKE ${like}))`);
    rank = `(CASE WHEN lower(e.primary_email) = ${exact} OR lower(e.display_name) = ${exact} THEN 2
                  WHEN lower(e.display_name) LIKE ${exact} || '%' THEN 1 ELSE 0 END)`;
  }
  const { rows } = await query(
    `SELECT ${ENTITY_LITE_SELECT} FROM hedwig_entities e WHERE ${where.join(' AND ')}
      ORDER BY ${rank} DESC, e.is_bulk ASC, e.last_seen DESC NULLS LAST, e.message_count DESC
      LIMIT $2`,
    params,
  );
  return rows.map(toEntityLite);
}

async function entityCommitments(userId, e, minConfidence) {
  // An org's commitments are its people's.
  const { rows } = await query(
    `SELECT ${COMMITMENT_SELECT} FROM hedwig_commitments c
      WHERE c.user_id = $1 AND ${visibleCommitment(3)}
        AND (c.counterparty_entity_id = $2
             OR c.counterparty_entity_id IN (SELECT id FROM hedwig_entities WHERE org_id = $2 AND user_id = $1))
        AND (c.status = 'open' OR (c.status = 'done' AND c.resolved_at > NOW() - INTERVAL '30 days'))
      ORDER BY ${COMMITMENT_ORDER} LIMIT 30`,
    [userId, e.id, minConfidence],
  );
  return rows.map(toCommitment);
}

async function entityFacts(userId, entityId, minConfidence) {
  const { rows } = await query(
    `SELECT ${FACT_SELECT} FROM hedwig_facts f
      WHERE f.user_id = $1 AND NOT f.dismissed AND (f.user_edited OR f.pinned OR f.confidence IS NULL OR f.confidence >= $3)
        AND (f.entity_id = $2 OR f.entity_id IN (SELECT id FROM hedwig_entities WHERE org_id = $2 AND user_id = $1))
      ORDER BY f.pinned DESC, f.updated_at DESC LIMIT 30`,
    [userId, entityId, minConfidence],
  );
  return rows.map(toFact);
}

/** EntityCard, or null when the entity is not this user's. */
export async function getEntityCard(userId, id) {
  if (!isUuid(id)) return null;
  const { rows: [e] } = await query(
    `SELECT ${ENTITY_LITE_SELECT}, e.org_id, e.pinned, e.summary, e.summary_at, e.summary_sources,
            e.sent_count, e.received_count, e.first_seen
       FROM hedwig_entities e WHERE e.id = $1 AND e.user_id = $2`,
    [id, userId],
  );
  if (!e) return null;
  const cfg = await getConfig(userId);
  const minConfidence = cfg['context.extractMinConfidence'];
  const [addresses, org, accounts, commitments, facts, recent, topics] = await Promise.all([
    query(
      `SELECT email, name FROM hedwig_entity_addresses WHERE entity_id = $1 AND user_id = $2
        ORDER BY (email = lower(COALESCE($3, ''))) DESC, email`,
      [e.id, userId, e.primary_email],
    ),
    e.org_id ? query(`SELECT ${ENTITY_LITE_SELECT} FROM hedwig_entities e WHERE e.id = $1 AND e.user_id = $2`, [e.org_id, userId]) : { rows: [] },
    query(
      `SELECT a.id, a.name, a.color FROM email_accounts a
        WHERE a.user_id = $2 AND EXISTS (
          SELECT 1 FROM hedwig_message_entities me JOIN messages m ON m.id = me.message_id
           WHERE me.entity_id = $1 AND m.account_id = a.id)
        ORDER BY a.sort_order, a.name`,
      [e.id, userId],
    ),
    entityCommitments(userId, e, minConfidence),
    entityFacts(userId, e.id, minConfidence),
    query(
      `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $2 AND m.is_deleted = false
          AND m.id IN (SELECT message_id FROM hedwig_message_entities WHERE entity_id = $1)
        ORDER BY m.date DESC NULLS LAST LIMIT 15`,
      [e.id, userId],
    ),
    query(
      `SELECT t.id, t.label, t.message_count, t.last_seen FROM hedwig_topics t
        WHERE t.user_id = $2 AND t.status = 'active' AND t.id IN (
          SELECT tm.topic_id FROM hedwig_topic_members tm JOIN hedwig_message_entities me ON me.message_id = tm.message_id
           WHERE me.entity_id = $1)
        ORDER BY t.last_seen DESC NULLS LAST LIMIT 10`,
      [e.id, userId],
    ),
  ]);
  const sources = Array.isArray(e.summary_sources) ? e.summary_sources : [];
  return {
    entity: { ...toEntityLite(e), addresses: addresses.rows, org: toEntityLite(org.rows[0]) || null, pinned: Boolean(e.pinned) },
    summary: e.summary ? { text: e.summary, at: e.summary_at, sources } : null,
    stats: {
      messages: Number(e.message_count) || 0,
      you_sent: Number(e.sent_count) || 0,
      they_sent: Number(e.received_count) || 0,
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      accounts: accounts.rows,
    },
    commitments,
    facts,
    recent: (await loadMessagesLite(userId, recent.rows.map((r) => r.id))).slice(0, 10),
    topics: topics.rows.map((t) => ({ id: t.id, label: t.label, message_count: t.message_count, last_seen: t.last_seen })),
  };
}

/** EntityCard for an address, or null when Hedwig has not seen it. */
export async function resolveEntityByEmail(userId, email) {
  const addr = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!addr.includes('@') || addr.length > 320) return null;
  const { rows } = await query('SELECT entity_id FROM hedwig_entity_addresses WHERE user_id = $1 AND email = $2', [userId, addr]);
  return rows[0] ? getEntityCard(userId, rows[0].entity_id) : null;
}

// Unlabelled topics fall back to the subject of their first message.
const TOPIC_LABEL = `COALESCE(t.label, (SELECT m.subject FROM hedwig_topic_members tm JOIN messages m ON m.id = tm.message_id
                                         WHERE tm.topic_id = t.id ORDER BY m.date ASC NULLS LAST LIMIT 1)) AS label`;

const labelOf = (r) => (r.label && r.label === r.raw_label ? r.label : cleanSubject(r.label));

/** Active topics, most recent first. Single-message topics are left out: they are just threads. */
export async function listTopics(userId, { limit = 30 } = {}) {
  const cfg = await getConfig(userId);
  const { rows } = await query(
    `SELECT t.id, t.label AS raw_label, ${TOPIC_LABEL}, t.summary, t.message_count, t.first_seen, t.last_seen,
            (SELECT COUNT(*)::int FROM hedwig_commitments c
              WHERE c.user_id = t.user_id AND c.topic_id = t.id AND c.status = 'open' AND ${visibleCommitment(3)}) AS open_commitments
       FROM hedwig_topics t
      WHERE t.user_id = $1 AND t.status = 'active' AND t.message_count >= 2
      ORDER BY t.last_seen DESC NULLS LAST LIMIT $2`,
    [userId, clampInt(limit, 1, 200, 30), cfg['context.extractMinConfidence']],
  );
  return rows.map((r) => ({
    id: r.id,
    label: labelOf(r),
    summary: r.summary,
    message_count: r.message_count,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    open_commitments: r.open_commitments,
  }));
}

/** TopicCard, or null when the topic is not this user's. */
export async function getTopicCard(userId, id) {
  if (!isUuid(id)) return null;
  const { rows: [t] } = await query(
    `SELECT t.id, t.label AS raw_label, ${TOPIC_LABEL}, t.summary, t.summary_sources, t.message_count, t.first_seen, t.last_seen
       FROM hedwig_topics t WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId],
  );
  if (!t) return null;
  const cfg = await getConfig(userId);
  const minConfidence = cfg['context.extractMinConfidence'];
  const [messages, people, commitments, facts, markers] = await Promise.all([
    query(
      `SELECT * FROM (
         SELECT ${MESSAGE_LITE_SELECT}, m.body_text, m.body_html
           FROM hedwig_topic_members tm JOIN messages m ON m.id = tm.message_id JOIN email_accounts a ON a.id = m.account_id
          WHERE tm.topic_id = $1 AND a.user_id = $2 AND m.is_deleted = false
          ORDER BY m.date DESC NULLS LAST LIMIT 50) x
        ORDER BY x.date ASC NULLS FIRST`,
      [id, userId],
    ),
    query(
      `SELECT ${ENTITY_LITE_SELECT} FROM hedwig_entities e
         JOIN (SELECT me.entity_id, COUNT(DISTINCT me.message_id) AS n
                 FROM hedwig_message_entities me JOIN hedwig_topic_members tm ON tm.message_id = me.message_id
                WHERE tm.topic_id = $1 GROUP BY me.entity_id) s ON s.entity_id = e.id
        WHERE e.user_id = $2 AND e.kind = 'person' AND NOT e.is_bulk
        ORDER BY s.n DESC, e.last_seen DESC NULLS LAST LIMIT 12`,
      [id, userId],
    ),
    query(
      `SELECT ${COMMITMENT_SELECT} FROM hedwig_commitments c
        WHERE c.user_id = $2 AND c.topic_id = $1 AND c.status <> 'dismissed' AND ${visibleCommitment(3)}
        ORDER BY ${COMMITMENT_ORDER} LIMIT 50`,
      [id, userId, minConfidence],
    ),
    query(
      `SELECT ${FACT_SELECT} FROM hedwig_facts f
        WHERE f.user_id = $2 AND f.topic_id = $1 AND NOT f.dismissed
          AND (f.user_edited OR f.pinned OR f.confidence IS NULL OR f.confidence >= $3)
        ORDER BY f.pinned DESC, f.updated_at DESC LIMIT 30`,
      [id, userId, minConfidence],
    ),
    query(
      `SELECT c.source_message_id, c.resolved_by_message_id, c.direction FROM hedwig_commitments c
        WHERE c.user_id = $2 AND c.topic_id = $1 AND c.status <> 'dismissed'`,
      [id, userId],
    ),
  ]);
  const settled = new Set(markers.rows.map((r) => r.resolved_by_message_id).filter(Boolean));
  const owes = new Map();
  for (const r of markers.rows) if (r.source_message_id && !owes.has(r.source_message_id)) owes.set(r.source_message_id, r.direction);
  return {
    topic: {
      id: t.id,
      label: labelOf(t),
      summary: t.summary,
      summary_sources: Array.isArray(t.summary_sources) ? t.summary_sources : [],
      message_count: t.message_count,
      first_seen: t.first_seen,
      last_seen: t.last_seen,
    },
    timeline: messages.rows.map((r) => ({
      message: toMessageLite(r),
      gist: gistOf(messageText(r, { maxChars: 600 })),
      marker: settled.has(r.id) ? 'settled' : owes.get(r.id) || null,
    })),
    people: people.rows.map(toEntityLite),
    commitments: commitments.rows.map(toCommitment),
    facts: facts.rows.map(toFact),
  };
}

async function similarMessages(userId, messageId, threadKey, limit) {
  const profile = await embeddingProfile();
  if (profile) {
    const { rows } = await query(
      'SELECT embedding::text AS v FROM hedwig_embeddings WHERE message_id = $1 AND user_id = $2 AND dims = $3 AND model = $4',
      [messageId, userId, profile.dims, profile.model],
    );
    if (rows[0]) {
      const vector = fromVectorLiteral(rows[0].v);
      const ids = await vectorIds(userId, { vector, dims: profile.dims, model: profile.model }, { excludeThread: threadKey }, limit * 2);
      if (ids.length) return ids;
    }
  }
  const { rows } = await query(
    `SELECT m.id FROM hedwig_topic_members tm
       JOIN hedwig_topic_members other ON other.topic_id = tm.topic_id AND other.message_id <> tm.message_id
       JOIN messages m ON m.id = other.message_id JOIN email_accounts a ON a.id = m.account_id
      WHERE tm.message_id = $1 AND a.user_id = $2 AND m.is_deleted = false AND m.thread_key <> $3
      ORDER BY m.date DESC NULLS LAST LIMIT $4`,
    [messageId, userId, threadKey, limit * 2],
  );
  return rows.map((r) => r.id);
}

/** MessageContext, or null when the message is not this user's. */
export async function getMessageContext(userId, messageId) {
  if (!isUuid(messageId)) return null;
  const { rows: [msg] } = await query(
    `SELECT m.id, m.thread_key, lower(m.from_email) AS from_email FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId],
  );
  if (!msg) return null;
  const cfg = await getConfig(userId);
  const minConfidence = cfg['context.extractMinConfidence'];
  const [parts, topic, commitments, facts, related] = await Promise.all([
    query(
      `SELECT me.role, e.id, e.kind FROM hedwig_message_entities me JOIN hedwig_entities e ON e.id = me.entity_id
        WHERE me.message_id = $1 AND e.user_id = $2 AND e.kind <> 'org'
        ORDER BY CASE me.role WHEN 'from' THEN 0 WHEN 'to' THEN 1 ELSE 2 END`,
      [msg.id, userId],
    ),
    query(
      `SELECT t.id, t.label AS raw_label, ${TOPIC_LABEL} FROM hedwig_topic_members tmx JOIN hedwig_topics t ON t.id = tmx.topic_id
        WHERE tmx.message_id = $1 AND t.user_id = $2 LIMIT 1`,
      [msg.id, userId],
    ),
    query(
      `SELECT ${COMMITMENT_SELECT} FROM hedwig_commitments c
        WHERE c.user_id = $1 AND (c.thread_key = $2 OR c.source_message_id = $3) AND c.status <> 'dismissed'
          AND ${visibleCommitment(4)}
        ORDER BY ${COMMITMENT_ORDER} LIMIT 30`,
      [userId, msg.thread_key, msg.id, minConfidence],
    ),
    query(
      `SELECT ${FACT_SELECT} FROM hedwig_facts f JOIN messages sm ON sm.id = f.source_message_id
         JOIN email_accounts sa ON sa.id = sm.account_id AND sa.user_id = $1
        WHERE f.user_id = $1 AND NOT f.dismissed AND sm.thread_key = $2
          AND (f.user_edited OR f.pinned OR f.confidence IS NULL OR f.confidence >= $3)
        ORDER BY f.pinned DESC, f.updated_at DESC LIMIT 30`,
      [userId, msg.thread_key, minConfidence],
    ),
    similarMessages(userId, msg.id, msg.thread_key, 6),
  ]);
  // For the user's own mail the interesting card is the person it went to.
  let senderId = parts.rows.find((p) => p.role === 'from' && p.kind !== 'self')?.id
    || parts.rows.find((p) => p.kind !== 'self')?.id || null;
  if (!senderId && !parts.rows.length && msg.from_email) {
    const { rows } = await query('SELECT entity_id FROM hedwig_entity_addresses WHERE user_id = $1 AND email = $2', [userId, msg.from_email]);
    senderId = rows[0]?.entity_id || null;
  }
  const t = topic.rows[0];
  return {
    sender: senderId ? await getEntityCard(userId, senderId) : null,
    topic: t ? { id: t.id, label: labelOf(t) } : null,
    commitments: commitments.rows.map(toCommitment),
    facts: facts.rows.map(toFact),
    related: (await loadMessagesLite(userId, related)).filter((m) => m.thread_key !== msg.thread_key).slice(0, 6),
  };
}

/** Ownership checks used before starting a stream. */
export async function ownsEntity(userId, id) {
  if (!isUuid(id)) return false;
  const { rows } = await query('SELECT 1 FROM hedwig_entities WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows.length > 0;
}

export async function ownsTopic(userId, id) {
  if (!isUuid(id)) return false;
  const { rows } = await query('SELECT 1 FROM hedwig_topics WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows.length > 0;
}
