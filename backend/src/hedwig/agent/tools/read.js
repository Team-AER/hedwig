// Read-only agent tools owned by the agent module. Every handler scopes its queries to ctx.userId
// and re-checks ownership of any id it is given.
import { query } from '../../../services/db.js';
import { getConfig } from '../../config.js';
import { messageText, stripQuoted, addressesOf } from '../../text.js';
import { validTimezone, zonedParts, describeNow, weekdayName, localDay } from '../../insights/time.js';
import { loadOwnedMessage } from '../mailOps.js';

const ID = { type: 'string', format: 'uuid' };

async function requestBodyFetch(messageId) {
  try {
    const { requestBody } = await import('../../core/bodies.js');
    await requestBody(messageId, { priority: 3 });
  } catch (err) {
    console.warn('[hedwig] agent could not queue a body fetch:', err.message);
  }
}

const shortAddr = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);

async function ownAddressSet(userId) {
  const { rows } = await query(
    `SELECT lower(email_address) AS e FROM email_accounts WHERE user_id = $1
     UNION SELECT lower(al.email) FROM account_aliases al JOIN email_accounts a ON a.id = al.account_id WHERE a.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.e));
}

export const readTools = [
  {
    name: 'list_accounts',
    description: "List the user's mail accounts with their ids, addresses and unread inbox counts.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, { userId }) {
      const { rows } = await query(
        `SELECT a.id, a.name, a.email_address, a.color, a.enabled,
                COALESCE((SELECT unread_count FROM folders f WHERE f.account_id = a.id AND f.path = 'INBOX'), 0) AS unread_inbox
           FROM email_accounts a WHERE a.user_id = $1 ORDER BY a.sort_order NULLS LAST, a.created_at`,
        [userId],
      );
      return rows.map((r) => ({ id: r.id, name: r.name, email: r.email_address, enabled: r.enabled, unread_inbox: Number(r.unread_inbox) }));
    },
  },
  {
    name: 'read_message',
    description: 'Read one message: headers, attachment names and its text (quoted history removed). Use ids from other tool results.',
    parameters: { type: 'object', properties: { messageId: { ...ID, description: 'message id' } }, required: ['messageId'] },
    async handler({ messageId }, { userId }) {
      const m = await loadOwnedMessage(userId, messageId);
      const { rows: acc } = await query('SELECT name FROM email_accounts WHERE id = $1 AND user_id = $2', [m.account_id, userId]);
      const hasBody = Boolean(m.body_text || m.body_html);
      if (!hasBody) await requestBodyFetch(m.id);
      const attachments = (Array.isArray(m.attachments) ? m.attachments : [])
        .map((a) => ({ filename: a?.filename || a?.name || null, size: a?.size ?? null })).filter((a) => a.filename);
      return {
        id: m.id,
        account: acc[0]?.name || null,
        folder: m.folder,
        from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email,
        to: addressesOf(m.to_addresses).slice(0, 10).map(shortAddr),
        cc: addressesOf(m.cc_addresses).slice(0, 10).map(shortAddr),
        date: m.date,
        subject: m.subject,
        is_read: m.is_read,
        is_starred: m.is_starred,
        attachments,
        thread_key: m.thread_key,
        text: messageText(m, { maxChars: 4500 }),
        ...(hasBody ? {} : { note: 'Only the preview snippet is downloaded so far; the full body has been requested.' }),
      };
    },
  },
  {
    name: 'get_thread',
    description: 'Show the conversation a message belongs to, oldest first, with each message\'s new text (quotes removed).',
    parameters: { type: 'object', properties: { messageId: { ...ID, description: 'any message in the thread' } }, required: ['messageId'] },
    async handler({ messageId }, { userId }) {
      const m = await loadOwnedMessage(userId, messageId);
      const own = await ownAddressSet(userId);
      const { rows } = await query(
        `SELECT DISTINCT ON (COALESCE(m.message_id, m.id::text)) m.id, m.folder, m.from_name, m.from_email, m.to_addresses,
                m.date, m.subject, m.is_read, m.body_text, m.body_html, m.snippet
           FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
          WHERE m.account_id = $2 AND m.thread_key = $3 AND m.is_deleted = false
          ORDER BY COALESCE(m.message_id, m.id::text), m.date`,
        [userId, m.account_id, m.thread_key],
      );
      const msgs = rows.sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-25);
      return {
        subject: m.subject,
        count: rows.length,
        messages: msgs.map((r) => ({
          id: r.id,
          from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
          from_user: own.has(String(r.from_email || '').toLowerCase()),
          to: addressesOf(r.to_addresses).slice(0, 4).map((a) => a.email),
          date: r.date,
          folder: r.folder,
          is_read: r.is_read,
          text: stripQuoted(messageText(r, { maxChars: 1200, stripQuotes: false })).slice(0, 900),
        })),
      };
    },
  },
  {
    name: 'today',
    description: "The current date, time, weekday and timezone for the user. Use it to resolve 'tomorrow', 'next Friday' and similar.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, { userId }) {
      const cfg = await getConfig(userId);
      const tz = validTimezone(cfg['insights.timezone']);
      const now = new Date();
      const p = zonedParts(now, tz);
      return {
        now_utc: now.toISOString(),
        local: describeNow(now, tz),
        date: localDay(now, tz),
        time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
        weekday: weekdayName(p.weekday),
        timezone: tz,
      };
    },
  },
  {
    name: 'get_overview',
    description: 'Mail statistics for the last N days: volume, busiest senders with open/reply rates, reply times, commitments and triage counts.',
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } },
    async handler({ days }, { userId }) {
      const { overview } = await import('../../insights/service.js');
      const o = await overview(userId, { days });
      const totals = o.volume.reduce((acc, d) => ({ received: acc.received + d.received, sent: acc.sent + d.sent }), { received: 0, sent: 0 });
      return {
        days: o.days,
        totals,
        byAccount: o.byAccount.map((a) => ({ account: a.account.name, received: a.received, sent: a.sent })),
        topSenders: o.topSenders,
        responseTime: { median_hours: o.responseTime.median_hours, p90_hours: o.responseTime.p90_hours, weekly: o.responseTime.weekly.slice(-8) },
        owe: o.owe,
        triage: o.triage,
      };
    },
  },
  {
    name: 'get_briefing',
    description: "The user's latest daily briefing (markdown; its [n] citations refer to the listed source message ids in order).",
    parameters: { type: 'object', properties: {} },
    async handler(_args, { userId }) {
      const { latestBriefing } = await import('../../insights/service.js');
      const b = await latestBriefing(userId);
      if (!b) return { briefing: null, note: 'No briefing has been generated yet.' };
      return { title: b.title, created_at: b.created_at, body: b.body, sources: b.sources };
    },
  },
  {
    name: 'list_automations',
    description: "List the user's scheduled agent automations: name, schedule, whether enabled, and next run.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, { userId }) {
      const { rows } = await query(
        `SELECT id, name, schedule, enabled, deliver, last_run_at, next_run_at FROM hedwig_automations
          WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return rows;
    },
  },
];
