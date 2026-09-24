// Card feedback: what the owner told Hedwig about its cards (a corrected field, a dismissal, "Not a
// subscription", "Not a <kind>"), kept by merchant and sender in hedwig_card_feedback (h0022), and
// read back three ways: the subscription finder never derives a merchant the owner called one-off,
// the card job drops a kind the owner rejected for that merchant, and the cards.extract prompt is
// shown the owner's recent corrections for the sender it is reading.
import { query } from '../../services/db.js';
import { merchantKey } from './kinds.js';
import { senderName } from './detect/orders.js';

export const VERDICTS = ['not_this_kind', 'not_recurring', 'wrong_field', 'dismissed', 'confirmed'];
// Verdicts a restore (undo) takes back.
const NEGATIVE = ['not_this_kind', 'not_recurring', 'dismissed'];

// The field naming who a card is from, per kind.
const WHO = {
  receipt: ['merchant'], invoice: ['issuer'], subscription: ['merchant'], delivery: ['merchant', 'carrier'],
  travel: ['provider'], event: ['organizer'], code: ['service'], deadline: ['counterparty'],
};

/** Who a card is from, as a merchant key: its merchant / issuer / provider, else the sender's name. Pure. */
export function cardMerchantKey(card, message = card?.message) {
  const f = card?.fields || {};
  for (const k of WHO[card?.kind] || []) {
    const key = merchantKey(f[k]);
    if (key) return key;
  }
  const who = message ? senderName({ from_name: message.from_name, from_email: message.from_email }) : null;
  return merchantKey(who) || null;
}

const senderOf = (message) => (message?.from_email ? String(message.from_email).trim().toLowerCase() : null) || null;
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Keep one piece of feedback about a card.
 * @param {string} userId
 * @param {{ id, kind, fields, message? }} card API-shaped (store.toCard)
 * @param {{ verdict: string, field?: string, before?: any, after?: any, merchantKey?: string }} fb
 */
export async function recordFeedback(userId, card, { verdict, field = null, before = null, after = null, merchantKey: mk = undefined }) {
  if (!VERDICTS.includes(verdict)) throw Object.assign(new Error(`unknown verdict ${verdict}`), { status: 400 });
  const { rows } = await query(
    `INSERT INTO hedwig_card_feedback (user_id, card_id, kind, merchant_key, sender, verdict, field, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
    [userId, card.id || null, card.kind, mk === undefined ? cardMerchantKey(card) : mk, senderOf(card.message), verdict, field, json(before), json(after)],
  );
  return rows[0];
}

/** Take back what dismissing a card said (an undo), and optionally say the card is right. */
export async function withdrawFeedback(userId, card, { confirm = false } = {}) {
  await query(
    'DELETE FROM hedwig_card_feedback WHERE user_id = $1 AND card_id = $2 AND verdict = ANY($3::text[])',
    [userId, card.id, NEGATIVE],
  );
  if (confirm) await recordFeedback(userId, card, { verdict: 'confirmed', before: { fields: card.fields } });
}

/**
 * What the card job and the subscription finder must not make again for this user. Pure over rows.
 * @param {{ kind, merchant_key, sender, verdict }[]} rows
 * @returns {{ oneOff: Set<string>, notKind: Set<string> }} notKind holds `${kind}|${merchantKey}`
 */
export function blocksFrom(rows) {
  const oneOff = new Set();
  const notKind = new Set();
  for (const r of rows || []) {
    if (!r.merchant_key) continue;
    if (r.verdict === 'not_recurring') { oneOff.add(r.merchant_key); notKind.add(`subscription|${r.merchant_key}`); }
    if (r.verdict === 'not_this_kind') {
      notKind.add(`${r.kind}|${r.merchant_key}`);
      if (r.kind === 'subscription') oneOff.add(r.merchant_key);
    }
  }
  return { oneOff, notKind };
}

export async function loadBlocks(userId) {
  const { rows } = await query(
    `SELECT DISTINCT kind, merchant_key, verdict FROM hedwig_card_feedback
      WHERE user_id = $1 AND verdict IN ('not_recurring', 'not_this_kind') AND merchant_key IS NOT NULL`,
    [userId],
  );
  return blocksFrom(rows);
}

/** Is this detected card one the owner already said is wrong for its merchant? Pure. */
export function isBlocked(card, blocks, message = null) {
  if (!blocks?.notKind?.size) return false;
  const key = cardMerchantKey(card, message);
  return Boolean(key) && blocks.notKind.has(`${card.kind}|${key}`);
}

const clip = (v, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const article = (kind) => (/^[aeiou]/.test(kind) ? 'an' : 'a');

/** One feedback row as a line the cards.extract prompt shows the model. Pure. */
export function feedbackLine(r) {
  const kind = r.kind || 'card';
  const who = r.before?.merchant || r.before?.fields?.merchant || r.merchant_key || null;
  const card = `${article(kind)} ${kind} card${who ? ` for ${clip(who, 60)}` : ''}`;
  switch (r.verdict) {
    case 'not_recurring': return `${card}: the owner said this is not a subscription (separate one-off purchases).`;
    case 'not_this_kind': return `${card}: the owner said this mail is not ${article(kind)} ${kind}.`;
    case 'dismissed': return `${card}: the owner dismissed it.`;
    case 'confirmed': return `${card}: the owner confirmed it.`;
    case 'wrong_field': {
      const before = r.before && r.field ? r.before[r.field] : null;
      const after = r.after && r.field ? r.after[r.field] : null;
      const was = before == null ? 'empty' : clip(before);
      return after == null
        ? `${card}: ${r.field} was ${was}; the owner cleared it.`
        : `${card}: ${r.field} was ${was}; the owner corrected it to ${clip(after)}.`;
    }
    default: return `${card}: ${r.verdict}.`;
  }
}

/**
 * Up to `perItem` recent feedback lines for each message of a batch, by its sender address or the
 * merchant key of its sender's name.
 * @param {{ id: string, from_email?: string, from_name?: string }[]} rows
 * @returns {Promise<Map<string, string[]>>} message id → lines, newest first
 */
export async function feedbackForMessages(userId, rows, { perItem = 5 } = {}) {
  const out = new Map();
  const want = (rows || []).map((r) => ({
    id: r.id, sender: senderOf(r), key: merchantKey(senderName(r)) || null,
  }));
  const senders = [...new Set(want.map((w) => w.sender).filter(Boolean))];
  const keys = [...new Set(want.map((w) => w.key).filter(Boolean))];
  if (!senders.length && !keys.length) return out;
  const { rows: fb } = await query(
    `SELECT kind, merchant_key, sender, verdict, field, before, after, created_at FROM hedwig_card_feedback
      WHERE user_id = $1 AND (sender = ANY($2::text[]) OR merchant_key = ANY($3::text[]))
      ORDER BY created_at DESC LIMIT 200`,
    [userId, senders, keys],
  );
  for (const w of want) {
    const mine = fb.filter((r) => (w.sender && r.sender === w.sender) || (w.key && r.merchant_key === w.key)).slice(0, perItem);
    if (mine.length) out.set(w.id, mine.map(feedbackLine));
  }
  return out;
}

/** GET /cards/feedback: the owner's feedback, newest first, and how much there is. */
export async function listFeedback(userId, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const [{ rows }, count] = await Promise.all([
    query(
      `SELECT id, card_id, kind, merchant_key, sender, verdict, field, before, after, created_at FROM hedwig_card_feedback
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, n],
    ),
    feedbackCount(userId),
  ]);
  return {
    ...count,
    feedback: rows.map((r) => ({
      id: r.id, cardId: r.card_id, kind: r.kind, merchantKey: r.merchant_key, sender: r.sender, verdict: r.verdict,
      field: r.field, before: r.before, after: r.after, createdAt: r.created_at,
    })),
  };
}

/** How much feedback the owner has given: all of it, and in the last 7 days. */
export async function feedbackCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS recent
       FROM hedwig_card_feedback WHERE user_id = $1`,
    [userId],
  );
  return { count: rows[0]?.count ?? 0, recent: rows[0]?.recent ?? 0 };
}
