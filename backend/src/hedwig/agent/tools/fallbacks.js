// Stand-ins for tools the context and triage modules own (search_mail, get_person, list_commitments,
// list_needs_you). They are registered only when the owning module has not registered its own, so
// the agent keeps basic abilities if a module is missing, and names never collide.
import { query } from '../../../services/db.js';

const LIMIT = { type: 'integer', minimum: 1, maximum: 25, default: 10 };

const compact = (r) => ({
  id: r.id,
  account: r.account_name,
  folder: r.folder,
  from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
  subject: r.subject,
  date: r.date,
  snippet: r.snippet ? String(r.snippet).slice(0, 200) : null,
  is_read: r.is_read,
});

const LITE = `m.id, a.name AS account_name, m.folder, m.from_name, m.from_email, m.subject, m.date, m.snippet, m.is_read`;

/** Postgres full-text search over the user's mail (subject, sender, snippet). */
export async function fullTextSearch(userId, { q, limit = 10, after = null, before = null }) {
  const { rows } = await query(
    `SELECT ${LITE}
       FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE m.is_deleted = false AND m.search_vector @@ websearch_to_tsquery('english', $2)
        AND ($3::timestamptz IS NULL OR m.date >= $3) AND ($4::timestamptz IS NULL OR m.date < $4)
        AND m.folder !~* '(^|[/.])(spam|junk|trash|bin|deleted items|drafts)$'
      ORDER BY ts_rank(m.search_vector, websearch_to_tsquery('english', $2)) DESC, m.date DESC
      LIMIT $5`,
    [userId, q, after ? new Date(after) : null, before ? new Date(before) : null, limit],
  );
  return rows.map(compact);
}

export const fallbackTools = [
  {
    name: 'search_mail',
    description: "Search the user's mail by keywords (sender names, subjects, words). Returns message ids to read or cite.",
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 300 },
        limit: LIMIT,
        after: { type: 'string', format: 'date-time' },
        before: { type: 'string', format: 'date-time' },
      },
      required: ['q'],
    },
    async handler(args, { userId }) {
      try {
        const { searchMessages } = await import('../../context/service.js');
        const res = await searchMessages(userId, { q: args.q, limit: args.limit, after: args.after, before: args.before });
        const list = Array.isArray(res) ? res : res?.results;
        if (Array.isArray(list)) return { results: list.map((r) => ({ ...compact({ ...r, account_name: r.account?.name }), score: r.score })) };
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.warn('[hedwig] search_mail: context search failed, using full-text:', err.message);
      }
      return { results: await fullTextSearch(userId, args), method: 'full-text' };
    },
  },
  {
    name: 'list_needs_you',
    description: 'Messages that need the user to act or reply, most important first.',
    parameters: { type: 'object', properties: { limit: LIMIT } },
    async handler({ limit }, { userId }) {
      try {
        const { listTriage } = await import('../../triage/service.js');
        const res = await listTriage(userId, { view: 'needs_you', limit });
        return { items: res.items.map((it) => ({ ...compact({ ...it.message, account_name: it.message.account?.name }), reason: it.triage?.reason_label || null })) };
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.warn('[hedwig] list_needs_you: triage unavailable, using unread direct mail:', err.message);
      }
      const { rows } = await query(
        `SELECT ${LITE}
           FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
          WHERE m.is_deleted = false AND m.is_read = false AND m.folder = 'INBOX'
            AND COALESCE(m.is_bulk, false) = false AND m.list_unsubscribe IS NULL
            AND m.date >= NOW() - INTERVAL '14 days'
            AND lower(m.from_email) NOT IN (SELECT lower(email_address) FROM email_accounts WHERE user_id = $1)
          ORDER BY m.date DESC LIMIT $2`,
        [userId, limit],
      );
      return { items: rows.map(compact), method: 'unread direct mail (triage unavailable)' };
    },
  },
  {
    name: 'get_person',
    description: 'What the mail says about one correspondent, by email address: how much you exchange, when last, and recent subjects.',
    parameters: { type: 'object', properties: { email: { type: 'string', minLength: 3, maxLength: 320 } }, required: ['email'] },
    async handler({ email }, { userId }) {
      const addr = email.trim().toLowerCase();
      const [{ rows: stats }, { rows: recent }] = await Promise.all([
        query(
          `SELECT COUNT(*) FILTER (WHERE lower(m.from_email) = $2)::int AS they_sent,
                  COUNT(*) FILTER (WHERE lower(m.from_email) <> $2)::int AS sent_to_them,
                  MIN(m.date) AS first_seen, MAX(m.date) AS last_seen,
                  (ARRAY_AGG(m.from_name ORDER BY m.date DESC) FILTER (WHERE lower(m.from_email) = $2 AND m.from_name <> ''))[1] AS name
             FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
            WHERE m.is_deleted = false
              AND (lower(m.from_email) = $2 OR m.to_addresses @> jsonb_build_array(jsonb_build_object('address', $2::text)))`,
          [userId, addr],
        ),
        query(
          `SELECT ${LITE}
             FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
            WHERE m.is_deleted = false AND lower(m.from_email) = $2
            ORDER BY m.date DESC LIMIT 8`,
          [userId, addr],
        ),
      ]);
      const s = stats[0] || {};
      if (!s.they_sent && !s.sent_to_them) return { email: addr, found: false };
      return { email: addr, name: s.name || null, they_sent: s.they_sent, sent_to_them: s.sent_to_them, first_seen: s.first_seen, last_seen: s.last_seen, recent: recent.map(compact) };
    },
  },
  {
    name: 'list_commitments',
    description: 'Open (or done) commitments found in mail: what the user owes others (i_owe) and what others owe the user (they_owe).',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'dismissed'], default: 'open' },
        direction: { type: 'string', enum: ['i_owe', 'they_owe'] },
        limit: LIMIT,
      },
    },
    async handler({ status, direction, limit }, { userId }) {
      const { rows } = await query(
        `SELECT id, direction, counterparty, what, due_at, status, source_message_id, created_at,
                (status = 'open' AND due_at < NOW()) AS overdue
           FROM hedwig_commitments
          WHERE user_id = $1 AND status = $2 AND ($3::text IS NULL OR direction = $3)
          ORDER BY due_at NULLS LAST, created_at DESC LIMIT $4`,
        [userId, status, direction || null, limit],
      );
      return rows;
    },
  },
];
