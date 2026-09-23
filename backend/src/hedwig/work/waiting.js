// Waiting On: what the owner asked and has not heard back about. The list itself is triage's
// (hedwig_triage waiting_on rows, found by triage/resolution.js scanWaitingOn); this module adds
// explicit "remind me if no reply in N days" watches (hedwig_work_waiting), drafted nudges
// (work.nudge, returned, never sent) and resolving from the work surface.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { llmAvailable } from '../llm.js';
import { runPrompt } from '../prompts/index.js';
import { listTriage, resolveTriage } from '../triage/service.js';
import { outgoingSql } from '../triage/store.js';
import { addressesOf } from '../text.js';
import {
  httpError, threadKeyOf, loadThreadMessages, ownerOf, todayLine, clampInt, latestOfThreads, DAY_MS,
} from './util.js';
import { newTextOf } from './thread.js';
import { voiceWith } from './voice.js';

const EFFECTIVE = 'COALESCE(CASE WHEN t.overridden THEN t.override_category END, t.category)';

/** The first recipient who is not the owner, for "who are we waiting on". Pure. */
export function waitingOn(row, ownerAddresses = []) {
  const mine = new Set(ownerAddresses.map((a) => a.toLowerCase()));
  const r = [...addressesOf(row?.to_addresses), ...addressesOf(row?.cc_addresses)].find((a) => !mine.has(a.email));
  return r ? { name: r.name || null, email: r.email } : null;
}

const daysSince = (date, now) => (date ? Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / DAY_MS)) : 0);

/** GET /work/waiting → [{ threadId, messageId, who, subject, askedAt, days, nudgeDraftAvailable, ... }] */
export async function listWaiting(userId, { now = new Date() } = {}) {
  const [cfg, owner, canDraft] = await Promise.all([getConfig(userId), ownerOf(userId), llmAvailable(userId).catch(() => false)]);
  const nudgeDraftAvailable = Boolean(canDraft) && cfg['ui.helpMeWrite'] !== false;
  const triage = await listTriage(userId, { view: 'waiting_on', limit: 200 });
  const ids = triage.items.map((i) => i.message.id);
  const { rows: addrRows } = ids.length
    ? await query('SELECT id, to_addresses, cc_addresses FROM messages WHERE id = ANY($1::uuid[])', [ids])
    : { rows: [] };
  const addrs = new Map(addrRows.map((r) => [r.id, r]));
  const out = new Map();
  for (const { message: m, triage: t } of triage.items) {
    const who = waitingOn(addrs.get(m.id), owner.addresses);
    const threadId = m.thread_key || m.id;
    if (out.has(threadId)) continue;
    out.set(threadId, {
      threadId, messageId: m.id, who: who?.name || who?.email || 'them', whoEmail: who?.email || null, subject: m.subject,
      askedAt: m.date, days: daysSince(m.date, now), nudgeDraftAvailable, reason: t?.reasons?.[0]?.label || t?.reason_label || null,
      source: 'triage', accountId: m.account_id,
    });
  }

  // Explicit watches that came due with nobody else writing since.
  const { rows: watches } = await query(
    `SELECT w.id, w.thread_key, w.message_id, w.anchor_at, w.days, w.due_at
       FROM hedwig_work_waiting w
      WHERE w.user_id = $1 AND w.resolved_at IS NULL AND w.due_at <= $2
        AND NOT EXISTS (
          SELECT 1 FROM messages r JOIN email_accounts ra ON ra.id = r.account_id
            LEFT JOIN folders rf ON rf.account_id = r.account_id AND rf.path = r.folder
           WHERE ra.user_id = $1 AND r.thread_key = w.thread_key AND NOT r.is_deleted AND r.date > w.anchor_at
             AND NOT ${outgoingSql('r', 'rf', '$3')})
      ORDER BY w.due_at LIMIT 200`,
    [userId, now, owner.addresses],
  );
  const latest = await latestOfThreads(userId, watches.map((w) => w.thread_key));
  const { rows: asked } = watches.length
    ? await query('SELECT id, subject, to_addresses, cc_addresses, date, account_id FROM messages WHERE id = ANY($1::uuid[])', [watches.map((w) => w.message_id).filter(Boolean)])
    : { rows: [] };
  const askedById = new Map(asked.map((r) => [r.id, r]));
  for (const w of watches) {
    const existing = out.get(w.thread_key);
    if (existing) { existing.remindAfterDays = w.days; continue; }
    const m = askedById.get(w.message_id) || latest.get(w.thread_key);
    if (!m) continue;
    const who = waitingOn(m, owner.addresses);
    out.set(w.thread_key, {
      threadId: w.thread_key, messageId: m.id, who: who?.name || who?.email || 'them', whoEmail: who?.email || null, subject: m.subject,
      askedAt: w.anchor_at, days: daysSince(w.anchor_at, now), nudgeDraftAvailable,
      reason: `No reply in ${w.days} day${w.days === 1 ? '' : 's'}, as you asked to be reminded`, source: 'watch', remindAfterDays: w.days,
      accountId: m.account_id,
    });
  }
  return [...out.values()].sort((a, b) => b.days - a.days);
}

/** The owner's latest message in a thread (the one a watch or a nudge is about). */
function lastMine(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].mine) return messages[i];
  return null;
}

/** POST /work/waiting { threadId, days } — remind me if no reply in N days. */
export async function addWatch(userId, body = {}, { now = new Date() } = {}) {
  const threadKey = threadKeyOf(body.threadId);
  const cfg = await getConfig(userId);
  const days = clampInt(body.days, clampInt(cfg['work.waitingDefaultDays'], 3, 1, 60), 1, 60);
  const messages = await loadThreadMessages(userId, threadKey);
  // At compose time the thread (or the sent copy) may not be synced yet: anchor at now.
  const mine = lastMine(messages);
  const anchor = mine?.date ? new Date(mine.date) : now;
  const due = new Date(anchor.getTime() + days * DAY_MS);
  const { rows } = await query(
    `INSERT INTO hedwig_work_waiting (user_id, thread_key, message_id, anchor_at, days, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, thread_key) WHERE resolved_at IS NULL
     DO UPDATE SET message_id = COALESCE(EXCLUDED.message_id, hedwig_work_waiting.message_id), anchor_at = EXCLUDED.anchor_at,
                   days = EXCLUDED.days, due_at = EXCLUDED.due_at
     RETURNING id, thread_key, message_id, anchor_at, days, due_at`,
    [userId, threadKey, mine?.id || null, anchor, days, due],
  );
  const w = rows[0];
  return { watch: { id: Number(w.id), threadId: w.thread_key, messageId: w.message_id, anchorAt: w.anchor_at, days: w.days, dueAt: w.due_at } };
}

/** POST /work/waiting/:threadId/resolve — stop waiting (triage's items in the thread and any watch). */
export async function resolveWaiting(userId, threadId) {
  const threadKey = threadKeyOf(threadId);
  const { rows } = await query(
    `SELECT t.message_id FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
      WHERE t.user_id = $1 AND m.thread_key = $2 AND t.resolved_at IS NULL AND ${EFFECTIVE} = 'waiting_on'`,
    [userId, threadKey],
  );
  for (const r of rows) await resolveTriage(userId, r.message_id);
  const watches = await query(
    `UPDATE hedwig_work_waiting SET resolved_at = NOW(), resolved_reason = 'user'
      WHERE user_id = $1 AND thread_key = $2 AND resolved_at IS NULL`,
    [userId, threadKey],
  );
  const resolved = rows.length + (watches.rowCount || 0);
  if (!resolved) throw httpError(404, 'Not waiting on that thread');
  return { ok: true, resolved };
}

/** POST /work/waiting/:threadId/nudge — a follow-up in the owner's voice, returned (never sent). */
export async function nudge(userId, threadId, { now = new Date() } = {}) {
  const threadKey = threadKeyOf(threadId);
  const cfg = await getConfig(userId);
  if (cfg['ui.helpMeWrite'] === false) throw httpError(403, 'Help me write is off in your settings');
  const owner = await ownerOf(userId);
  const messages = await loadThreadMessages(userId, threadKey, { addresses: owner.addresses });
  if (!messages.length) throw httpError(404, 'Thread not found');
  const { rows: tri } = await query(
    `SELECT t.message_id FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
      WHERE t.user_id = $1 AND m.thread_key = $2 AND ${EFFECTIVE} = 'waiting_on' ORDER BY m.date DESC LIMIT 1`,
    [userId, threadKey],
  );
  const ask = messages.find((m) => m.id === tri[0]?.message_id) || lastMine(messages);
  if (!ask) throw httpError(409, 'You have not written in this thread, so there is nothing to follow up');
  const who = waitingOn(ask, owner.addresses);
  const voice = who ? await voiceWith(userId, who.email, { n: clampInt(cfg['work.voiceSamples'], 5, 0, 20), addresses: owner.addresses }) : null;
  const { data, provenance } = await runPrompt('work.nudge', {
    today: todayLine(cfg, now), user: owner, who: who ? (who.name ? `${who.name} <${who.email}>` : who.email) : 'them',
    days: daysSince(ask.date, now), subject: ask.subject, text: newTextOf(ask, clampInt(cfg['work.storyMessageChars'], 1500, 200, 10000)), voice,
  }, { userId, feature: 'work', lane: 'interactive' });
  const text = String(data?.draft || '').trim();
  if (!text) throw httpError(502, 'The model returned an empty draft');
  const subject = ask.subject || '';
  return {
    draft: text,
    provenance,
    reply: { inReplyToMessageId: ask.id, to: who ? [{ name: who.name, email: who.email }] : [], subject: /^re:/i.test(subject) ? subject : `Re: ${subject}` },
  };
}
