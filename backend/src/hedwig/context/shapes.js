// SQL fragments and row mappers for the shapes in docs/hedwig/API.md. Every query that reads
// messages joins email_accounts on the caller's user id; nothing here trusts an id on its own.
import { query } from '../../services/db.js';

// Mail the user would not want surfaced as context: trash, junk and drafts.
export const VISIBLE_MESSAGE = `m.is_deleted = false
  AND m.folder !~* '(^|/)(spam|junk|trash|bin|deleted items|deleted messages|drafts)$'
  AND NOT EXISTS (SELECT 1 FROM folders xf WHERE xf.account_id = m.account_id AND xf.path = m.folder
                   AND xf.special_use IN ('\\Junk', '\\Trash', '\\Drafts'))`;

export const MESSAGE_LITE_SELECT = `m.id, m.account_id, a.name AS account_name, a.color AS account_color,
  m.folder, m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred,
  m.has_attachments, m.thread_key, m.message_id AS header_message_id`;

export function toMessageLite(r) {
  return {
    id: r.id,
    account_id: r.account_id,
    account: { id: r.account_id, name: r.account_name, color: r.account_color },
    folder: r.folder,
    subject: r.subject,
    from_name: r.from_name,
    from_email: r.from_email,
    date: r.date,
    snippet: r.snippet,
    is_read: Boolean(r.is_read),
    is_starred: Boolean(r.is_starred),
    has_attachments: Boolean(r.has_attachments),
    thread_key: r.thread_key,
  };
}

/**
 * MessageLite rows for ids the user owns, in the order given. Copies of one message (same
 * Message-ID in several folders or accounts) collapse to the first.
 */
export async function loadMessagesLite(userId, ids, { dedupe = true } = {}) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  const { rows } = await query(
    `SELECT ${MESSAGE_LITE_SELECT} FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = ANY($2::uuid[]) AND m.is_deleted = false`,
    [userId, unique],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set();
  const out = [];
  for (const id of unique) {
    const r = byId.get(id);
    if (!r) continue;
    const key = r.header_message_id || null;
    if (dedupe && key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(toMessageLite(r));
  }
  return out;
}

export const ENTITY_LITE_SELECT = 'e.id, e.kind, e.display_name, e.primary_email, e.domain, e.message_count, e.last_seen, e.is_bulk';

export function toEntityLite(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    display_name: r.display_name || r.primary_email || r.domain,
    primary_email: r.primary_email,
    domain: r.domain,
    message_count: Number(r.message_count) || 0,
    last_seen: r.last_seen,
    is_bulk: Boolean(r.is_bulk),
  };
}

export const COMMITMENT_SELECT = `c.id, c.direction, c.counterparty, c.counterparty_entity_id, c.what, c.due_at, c.status,
  c.source_message_id, c.thread_key, c.topic_id, c.confidence, c.created_at,
  (c.status = 'open' AND c.due_at IS NOT NULL AND c.due_at < NOW()) AS overdue`;

export function toCommitment(r) {
  return {
    id: r.id,
    direction: r.direction,
    counterparty: r.counterparty,
    counterparty_entity_id: r.counterparty_entity_id,
    what: r.what,
    due_at: r.due_at,
    status: r.status,
    source_message_id: r.source_message_id,
    thread_key: r.thread_key,
    topic_id: r.topic_id,
    confidence: r.confidence == null ? null : Number(r.confidence),
    created_at: r.created_at,
    overdue: Boolean(r.overdue),
  };
}

// Open first, overdue before the rest, soonest due first.
export const COMMITMENT_ORDER = `(c.status = 'open') DESC, (c.status = 'open' AND c.due_at < NOW()) DESC,
  c.due_at ASC NULLS LAST, c.created_at DESC`;

export const FACT_SELECT = 'f.id, f.key, f.value, f.entity_id, f.topic_id, f.source_message_id, f.confidence, f.pinned';

export function toFact(r) {
  return {
    id: r.id,
    key: r.key,
    value: r.value,
    entity_id: r.entity_id,
    topic_id: r.topic_id,
    source_message_id: r.source_message_id,
    confidence: r.confidence == null ? null : Number(r.confidence),
    pinned: Boolean(r.pinned),
  };
}
