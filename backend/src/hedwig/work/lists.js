// Lists a thread can be on (Reply Later, Set Aside, Pinned, reminders, Done, Snoozed) and the Done
// state machine:
//
//   open ──mark done──▶ done ──new mail from someone else──▶ open again (done_reason 'new_mail')
//        ◀──DELETE /work/lists/done/:id (undo)───
//
// A done thread leaves People: C's stream query adds peopleFilterSql() (messages dated before the
// thread was marked done are hidden, so a newer one shows the thread again even before the
// pipeline step below closes the done item). Marking done also closes the thread's Reply Later,
// Set Aside and reminder items. The user's own reply closes Reply Later.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { zonedParts, addDays, zonedToUtc } from '../insights/time.js';
import {
  httpError, threadKeyOf, latestOfThreads, streamRow, clampInt, parseDate, timeZoneOf, isUuid,
} from './util.js';

export const KINDS = Object.freeze(['reply_later', 'set_aside', 'pin', 'reminder', 'done', 'snoozed']);
const POSTABLE = new Set(['reply_later', 'set_aside', 'pin', 'reminder', 'done']);
const ALIASES = { replyLater: 'reply_later', setAside: 'set_aside', pinned: 'pin', pins: 'pin', reminders: 'reminder', snooze: 'snoozed' };
// Items marking a thread done closes (pins stay: a pinned thread can be done and still pinned).
const CLOSED_BY_DONE = ['reply_later', 'set_aside', 'reminder'];

export function normalizeKind(kind) {
  const k = ALIASES[kind] || String(kind || '').replace(/-/g, '_');
  if (!KINDS.includes(k)) throw httpError(400, `list must be one of ${KINDS.join(', ')}`);
  return k;
}

/**
 * SQL for C's People query: hide threads the user marked done (messages dated up to the moment
 * they did) and threads snoozed through Hedwig or sitting in upstream's Snoozed folder.
 * `m` is the messages alias, `s` the hedwig_sort alias (for user_id).
 */
export function peopleFilterSql(m = 'm', s = 's') {
  return `(COALESCE(${m}.folder, '') <> 'Snoozed' AND NOT EXISTS (
    SELECT 1 FROM hedwig_work_items w
     WHERE w.user_id = ${s}.user_id AND w.thread_key = ${m}.thread_key AND w.done_at IS NULL
       AND ((w.kind = 'done' AND (${m}.date IS NULL OR ${m}.date <= w.created_at)) OR (w.kind = 'snoozed' AND w.until > NOW()))))`;
}

// ── Counts and lists ────────────────────────────────────────────────────────

export async function listCounts(userId) {
  const { rows } = await query(
    `SELECT kind, COUNT(*)::int AS n FROM hedwig_work_items
      WHERE user_id = $1 AND done_at IS NULL AND (kind <> 'snoozed' OR until > NOW())
      GROUP BY kind`,
    [userId],
  );
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const r of rows) counts[r.kind] = r.n;
  // camelCase twins for the v2 frontend's existing list names.
  return { ...counts, replyLater: counts.reply_later, setAside: counts.set_aside };
}

const ORDER = {
  reply_later: 'position, created_at', set_aside: 'position, created_at', pin: 'position, created_at',
  reminder: 'until ASC NULLS LAST, created_at', done: 'created_at DESC', snoozed: 'until ASC',
};

function reminderRow(it) {
  return {
    threadId: `reminder:${it.id}`,
    messageId: null,
    from: { name: 'Reminder', email: null },
    subject: it.note || 'Reminder',
    snippet: '',
    date: it.until || it.created_at,
    needsYou: true,
    reason: 'You asked to be reminded',
    bundle: null,
    accountId: null,
    unread: true,
    synthetic: true,
    reminderId: Number(it.id),
  };
}

function itemExtras(it) {
  return { itemId: Number(it.id), note: it.note || null, until: it.until || null, position: it.position, addedAt: it.created_at };
}

export async function listItems(userId, kindIn, { limit = 200 } = {}) {
  const kind = normalizeKind(kindIn);
  const n = clampInt(limit, 200, 1, 500);
  const { rows } = await query(
    `SELECT id, thread_key, kind, note, until, position, created_at FROM hedwig_work_items
      WHERE user_id = $1 AND kind = $2 AND done_at IS NULL ${kind === 'snoozed' ? 'AND until > NOW()' : ''}
      ORDER BY ${ORDER[kind]} LIMIT $3`,
    [userId, kind, n],
  );
  const latest = await latestOfThreads(userId, rows.map((r) => r.thread_key));
  const items = [];
  for (const it of rows) {
    if (!it.thread_key) { items.push({ ...reminderRow(it), ...itemExtras(it) }); continue; }
    const r = latest.get(it.thread_key);
    if (r) items.push(streamRow(r, itemExtras(it)));
  }
  return { kind, items, next: null };
}

// ── Adding and removing ─────────────────────────────────────────────────────

async function requireThread(userId, threadKey) {
  const latest = (await latestOfThreads(userId, [threadKey])).get(threadKey);
  if (!latest) throw httpError(404, 'Thread not found');
  return latest;
}

/**
 * Mark threads done (the user's own call, a sweep, or a done list POST). Closes their Reply Later,
 * Set Aside and reminder items; re-marking a done thread moves its mark to now.
 * @returns {Promise<number>} threads marked
 */
export async function markDone(userId, threadKeys, { note = null } = {}) {
  const keys = [...new Set(threadKeys.filter(Boolean))];
  if (!keys.length) return 0;
  await query(
    `UPDATE hedwig_work_items SET done_at = NOW(), done_reason = 'done'
      WHERE user_id = $1 AND thread_key = ANY($2::text[]) AND done_at IS NULL AND kind = ANY($3::text[])`,
    [userId, keys, CLOSED_BY_DONE],
  );
  const { rowCount } = await query(
    `INSERT INTO hedwig_work_items (user_id, thread_key, kind, note, anchor_message_id)
     SELECT $1, k, 'done', $3, NULL FROM UNNEST($2::text[]) AS k
     ON CONFLICT (user_id, kind, thread_key) WHERE done_at IS NULL AND thread_key IS NOT NULL
     DO UPDATE SET created_at = NOW(), note = COALESCE(EXCLUDED.note, hedwig_work_items.note)`,
    [userId, keys, note],
  );
  return rowCount || keys.length;
}

/**
 * POST /work/lists/:kind { threadId, note?, until?, position? }. A reminder may have no thread:
 * { text, at } (or note/until).
 */
export async function addItem(userId, kindIn, body = {}) {
  const kind = normalizeKind(kindIn);
  if (!POSTABLE.has(kind)) throw httpError(400, 'Snooze through POST /work/snooze');
  const note = body.note ?? body.text ?? null;
  if (note !== null && typeof note !== 'string') throw httpError(400, 'note must be text');
  const until = parseDate(body.until ?? body.at, 'until');
  const position = body.position === undefined || body.position === null ? null : clampInt(body.position, 0, -1_000_000, 1_000_000);

  if (kind === 'reminder' && !body.threadId) {
    if (!note || !note.trim()) throw httpError(400, 'A reminder needs text');
    if (!until) throw httpError(400, 'A reminder needs a time (at)');
    const { rows } = await query(
      `INSERT INTO hedwig_work_items (user_id, thread_key, kind, note, until, position)
       VALUES ($1, NULL, 'reminder', $2, $3, COALESCE($4, 0)) RETURNING *`,
      [userId, note.trim().slice(0, 500), until, position],
    );
    return { item: { ...reminderRow(rows[0]), ...itemExtras(rows[0]) } };
  }

  const threadKey = threadKeyOf(body.threadId);
  const latest = await requireThread(userId, threadKey);
  if (kind === 'done') {
    await markDone(userId, [threadKey], { note: note ? note.slice(0, 500) : null });
    return { item: streamRow(latest, { kind: 'done' }), counts: await listCounts(userId) };
  }
  if (kind === 'reminder' && !until) throw httpError(400, 'A reminder needs a time (until)');
  const { rows } = await query(
    `INSERT INTO hedwig_work_items (user_id, thread_key, kind, note, until, position, anchor_message_id)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE($6, (SELECT COALESCE(MAX(position), 0) + 1 FROM hedwig_work_items WHERE user_id = $1 AND kind = $3 AND done_at IS NULL)),
             $7)
     ON CONFLICT (user_id, kind, thread_key) WHERE done_at IS NULL AND thread_key IS NOT NULL
     DO UPDATE SET note = COALESCE(EXCLUDED.note, hedwig_work_items.note),
                   until = COALESCE(EXCLUDED.until, hedwig_work_items.until),
                   position = CASE WHEN $6::int IS NULL THEN hedwig_work_items.position ELSE EXCLUDED.position END
     RETURNING *`,
    [userId, threadKey, kind, note ? note.slice(0, 500) : null, until, position, latest.id],
  );
  return { item: streamRow(latest, itemExtras(rows[0])), counts: await listCounts(userId) };
}

/** DELETE /work/lists/:kind/:threadId. Deleting from done un-does the thread (it returns to People). */
export async function removeItem(userId, kindIn, threadId) {
  const kind = normalizeKind(kindIn);
  if (kind === 'snoozed') throw httpError(400, 'A snooze ends by itself; move the message back from Snoozed to cancel it');
  const key = String(threadId || '');
  const m = /^reminder:(\d+)$/.exec(key);
  let res;
  if (kind === 'reminder' && (m || /^\d+$/.test(key))) {
    res = await query(
      `UPDATE hedwig_work_items SET done_at = NOW(), done_reason = 'user'
        WHERE user_id = $1 AND id = $2 AND kind = 'reminder' AND done_at IS NULL`,
      [userId, Number(m ? m[1] : key)],
    );
  } else {
    res = await query(
      `UPDATE hedwig_work_items SET done_at = NOW(), done_reason = 'user'
        WHERE user_id = $1 AND kind = $2 AND thread_key = $3 AND done_at IS NULL`,
      [userId, kind, threadKeyOf(key)],
    );
  }
  if (!res.rowCount) throw httpError(404, 'Not on that list');
  return { ok: true, counts: await listCounts(userId) };
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/**
 * POST /work/sweep { before } marks every People thread whose latest message is older than
 * `before` done. `before` as a plain date (YYYY-MM-DD) means "up to the end of that day" in the
 * user's zone; { day } sweeps just that one day.
 */
export async function sweep(userId, body = {}, { now = new Date() } = {}) {
  const cfg = await getConfig(userId);
  const tz = timeZoneOf(cfg);
  const dayStart = (s) => {
    const [y, mo, d] = s.split('-').map(Number);
    return zonedToUtc({ year: y, month: mo, day: d }, tz);
  };
  const nextDay = (s) => {
    const [y, mo, d] = s.split('-').map(Number);
    return zonedToUtc(addDays({ year: y, month: mo, day: d }, 1), tz);
  };
  const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  let before;
  let after = null;
  if (isDay(body.day)) {
    after = dayStart(body.day);
    before = nextDay(body.day);
  } else if (isDay(body.before)) {
    before = nextDay(body.before);
  } else {
    before = parseDate(body.before, 'before');
    if (!before) throw httpError(400, 'before is required');
  }
  if (before > now) before = now;
  const { rows } = await query(
    `SELECT m.thread_key
       FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = $1 AND s.stream = 'people' AND NOT s.own AND NOT m.is_deleted
      GROUP BY m.thread_key
     HAVING MAX(m.date) < $2 AND ($3::timestamptz IS NULL OR MAX(m.date) >= $3)
        AND NOT EXISTS (SELECT 1 FROM hedwig_work_items w
                         WHERE w.user_id = $1 AND w.kind = 'done' AND w.done_at IS NULL AND w.thread_key = m.thread_key
                           AND w.created_at >= MAX(m.date))
      LIMIT 5000`,
    [userId, before, after],
  );
  const marked = await markDone(userId, rows.map((r) => r.thread_key));
  return { marked, before, after };
}

// ── Snooze (wraps upstream's snooze through agent/mailOps.js) ───────────────

export function defaultSnoozeUntil(cfg, now = new Date()) {
  const tz = timeZoneOf(cfg);
  const today = zonedParts(now, tz);
  const day = addDays(today, clampInt(cfg['work.snoozeDefaultDays'], 1, 1, 30));
  return zonedToUtc({ ...day, hour: clampInt(cfg['work.snoozeDefaultHour'], 8, 0, 23), minute: 0 }, tz);
}

/**
 * POST /work/snooze { threadId | messageId, until? }. The move to Snoozed and the wake-up are
 * upstream's (the same protocol as POST /api/mail/messages/:id/snooze, via agent/mailOps.js);
 * Hedwig only records `until` so the thread can say "Back from snooze" when it returns.
 */
export async function snooze(userId, body = {}, { snoozeMessage = null } = {}) {
  const cfg = await getConfig(userId);
  const until = parseDate(body.until, 'until') || defaultSnoozeUntil(cfg);
  let messageId = body.messageId || null;
  let threadKey = body.threadId ? threadKeyOf(body.threadId) : null;
  if (messageId && !isUuid(messageId)) throw httpError(400, 'messageId must be a message id');
  if (!messageId) {
    if (!threadKey) throw httpError(400, 'threadId or messageId is required');
    const { rows } = await query(
      `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND m.thread_key = $2 AND NOT m.is_deleted AND m.folder <> 'Snoozed' AND m.message_id IS NOT NULL
        ORDER BY m.date DESC NULLS LAST LIMIT 1`,
      [userId, threadKey],
    );
    if (!rows[0]) throw httpError(404, 'Thread not found');
    messageId = rows[0].id;
  }
  const fn = snoozeMessage || (await import('../agent/mailOps.js')).snoozeMessage;
  const res = await fn(userId, { messageId, until: until.toISOString() });
  if (!threadKey) {
    const { rows } = await query(
      'SELECT m.thread_key FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id = $2',
      [messageId, userId],
    );
    threadKey = rows[0]?.thread_key || messageId;
  }
  await query(
    `INSERT INTO hedwig_work_items (user_id, thread_key, kind, until, anchor_message_id)
     VALUES ($1, $2, 'snoozed', $3, $4)
     ON CONFLICT (user_id, kind, thread_key) WHERE done_at IS NULL AND thread_key IS NOT NULL
     DO UPDATE SET until = EXCLUDED.until, anchor_message_id = EXCLUDED.anchor_message_id, created_at = NOW()`,
    [userId, threadKey, until, messageId],
  );
  return { ok: true, threadId: threadKey, messageId, until, moved: res?.count ?? res?.moved ?? null };
}

// ── People overlay: reminders as rows, "Back from snooze" ───────────────────

/**
 * Reminders that are due, as People rows. Free-standing reminders get a synthetic row
 * (threadId "reminder:<id>", messageId null); thread reminders show the thread's latest message.
 */
export async function syntheticRows(userId, { now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT id, thread_key, note, until, position, created_at FROM hedwig_work_items
      WHERE user_id = $1 AND kind = 'reminder' AND done_at IS NULL AND (until IS NULL OR until <= $2)
      ORDER BY until DESC NULLS LAST LIMIT 50`,
    [userId, now],
  );
  if (!rows.length) return [];
  const latest = await latestOfThreads(userId, rows.map((r) => r.thread_key));
  const out = [];
  for (const it of rows) {
    if (!it.thread_key) { out.push(reminderRow(it)); continue; }
    const r = latest.get(it.thread_key);
    if (!r) continue;
    out.push(streamRow(r, {
      needsYou: true, reason: it.note ? `Reminder: ${it.note}`.slice(0, 120) : 'You asked to be reminded', reminderId: Number(it.id), date: it.until || r.date,
    }));
  }
  return out;
}

/**
 * What C's People list calls on its page: due reminders on the first page (a thread already on the
 * page is replaced by its reminder row) and "Back from snooze" on threads whose snooze just ended.
 */
export async function withWorkRows(userId, items, { first = true, now = new Date() } = {}) {
  const cfg = await getConfig(userId);
  if (cfg['work.enabled'] === false) return items;
  let out = items;
  const keys = out.map((i) => i.threadId).filter(Boolean);
  if (keys.length) {
    const hours = clampInt(cfg['work.backFromSnoozeHours'], 72, 1, 720);
    const { rows } = await query(
      `SELECT thread_key FROM hedwig_work_items
        WHERE user_id = $1 AND kind = 'snoozed' AND done_at IS NULL AND thread_key = ANY($2::text[])
          AND until <= $3 AND until > $3::timestamptz - make_interval(hours => $4)`,
      [userId, keys, now, hours],
    );
    const woke = new Set(rows.map((r) => r.thread_key));
    if (woke.size) out = out.map((i) => (woke.has(i.threadId) ? { ...i, needsYou: true, reason: 'Back from snooze', backFromSnooze: true } : i));
  }
  if (!first) return out;
  const synthetic = await syntheticRows(userId, { now });
  if (!synthetic.length) return out;
  const replaced = new Set(synthetic.map((r) => r.threadId));
  return [...synthetic, ...out.filter((i) => !replaced.has(i.threadId))];
}

// ── Pipeline step: mail arriving changes list state ─────────────────────────

/**
 * New mail in a done thread from someone else re-opens it; the user's own message closes Reply
 * Later (and an ended snooze); anyone else writing resolves a "remind me if no reply" watch.
 * Rows carry user_id, thread_key, date, is_outgoing (pipeline.decorate).
 */
export async function applyMail(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!r.user_id || !r.thread_key || !r.date) continue;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { incoming: [], outgoing: [] });
    byUser.get(r.user_id)[r.is_outgoing ? 'outgoing' : 'incoming'].push(r);
  }
  let reopened = 0;
  for (const [userId, { incoming, outgoing }] of byUser) {
    if (incoming.length) {
      const keys = incoming.map((r) => r.thread_key);
      const dates = incoming.map((r) => new Date(r.date));
      const res = await query(
        `UPDATE hedwig_work_items w SET done_at = NOW(), done_reason = 'new_mail'
           FROM UNNEST($2::text[], $3::timestamptz[]) AS x(thread_key, at)
          WHERE w.user_id = $1 AND w.kind = 'done' AND w.done_at IS NULL AND w.thread_key = x.thread_key AND x.at > w.created_at`,
        [userId, keys, dates],
      );
      reopened += res.rowCount || 0;
      await query(
        `UPDATE hedwig_work_waiting ww SET resolved_at = NOW(), resolved_reason = 'replied'
           FROM UNNEST($2::text[], $3::timestamptz[]) AS x(thread_key, at)
          WHERE ww.user_id = $1 AND ww.resolved_at IS NULL AND ww.thread_key = x.thread_key AND x.at > ww.anchor_at`,
        [userId, keys, dates],
      );
    }
    if (outgoing.length) {
      await query(
        `UPDATE hedwig_work_items w SET done_at = NOW(), done_reason = 'replied'
           FROM UNNEST($2::text[], $3::timestamptz[]) AS x(thread_key, at)
          WHERE w.user_id = $1 AND w.done_at IS NULL AND w.thread_key = x.thread_key AND x.at > w.created_at
            AND (w.kind = 'reply_later' OR (w.kind = 'snoozed' AND w.until <= NOW()))`,
        [userId, outgoing.map((r) => r.thread_key), outgoing.map((r) => new Date(r.date))],
      );
    }
  }
  return { reopened };
}

