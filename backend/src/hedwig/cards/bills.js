// Bills: who the owner pays again and again, and what is due. Built at read time from receipts,
// invoices (a merchant's own mail or a card alert from the bank) and subscription cards. Charges are
// normalised (payee, the currency the sentence states when the field is empty, money in vs out) and
// grouped by payee (classifyPayees); each payee is a bill (a subscription, or an unpaid invoice), a
// candidate the owner is asked about ("Might be bills"), or one-off spending. The owner's answers are
// a subscription card of their own (Track) and feedback under the payee ("Not a bill").
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { senderName } from './detect/orders.js';
import { CADENCES, currencyFromText, merchantKey, normAmount, normCurrency, normDate, payeeKey } from './kinds.js';
import { addCadence, classifyPayees } from './subscriptions.js';
import { dismissCard, listCards, toCard, upsertCard } from './store.js';
import { cardMerchantKey, loadBlocks, recordFeedback } from './feedback.js';
import { relinkOrphans } from './relink.js';

const DAY = 86400_000;
const MONTHLY = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const round2 = (n) => Math.round(n * 100) / 100;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / DAY);

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

// Money coming in: a deposit, a refund, interest credited. "Payment received" on a shop's receipt is
// money going out (the shop received it), so "received" alone says nothing.
const IN_RE = /\b(credited|deposit(?:ed)?|refund(?:ed)?|cashback|reversal|reversed|(?:amount|money|funds?) received|received (?:from|in(?:to)? your))\b/i;
const OUT_RE = /\b(spent|debited|charged|purchased?|payment (?:of|to|made|for|received)|(?:amount|total) paid|paid (?:to|for|using|via|with|on)|ordered|your (?:order|receipt|invoice))\b/i;

/** 'in' for money coming in (a deposit, a refund), else 'out'. Pure. */
export function directionOf(card) {
  const f = card?.fields || {};
  const amount = Number(f.total ?? f.amount);
  if (Number.isFinite(amount) && amount < 0) return 'in';
  const quote = card?.sources?.total?.quote || card?.sources?.amount?.quote || '';
  if (OUT_RE.test(quote)) return 'out';
  if (IN_RE.test(quote)) return 'in';
  const subject = card?.message?.subject || '';
  return IN_RE.test(subject) && !OUT_RE.test(subject) ? 'in' : 'out';
}

/**
 * One receipt or invoice card as a charge. The payee falls back to the sender's name; the currency to
 * the one the amount's sentence (or any kept sentence) states. Pure.
 * @param {object} card API-shaped (store.toCard)
 * @param {{ live?: boolean, siblingKinds?: string[], snippet?: string }} [extra] live: the card's message still exists
 */
export function chargeOf(card, { live = true, siblingKinds = [], snippet = null } = {}) {
  const f = card.fields || {};
  const m = card.message || null;
  const merchant = f.merchant || f.issuer || (m && (m.from_name || m.from_email) ? senderName(m) : null);
  const amountSrc = card.sources?.total || card.sources?.amount || null;
  const quotes = Object.values(card.sources || {}).map((s) => (s && typeof s === 'object' ? s.quote : null)).filter(Boolean);
  const currency = f.currency || currencyFromText(amountSrc?.quote) || currencyFromText(quotes.join('\n')) || null;
  const amount = f.total ?? f.amount ?? null;
  return {
    cardId: card.id,
    kind: card.kind,
    layer: card.layer,
    messageId: live ? card.messageId || null : null,
    messageIds: card.messageIds || [],
    merchant,
    payee: payeeKey(merchant),
    amount: amount == null ? null : Number(amount),
    currency,
    currencyGuessed: !f.currency && Boolean(currency),
    date: f.date || f.issuedDate || (m?.date ? isoDay(m.date) : null),
    dueDate: f.dueDate || null,
    status: card.kind === 'invoice' ? (f.status || 'due') : 'paid',
    reference: f.orderNumber || f.invoiceNumber || null,
    direction: directionOf(card),
    orderNumber: card.kind === 'receipt' ? f.orderNumber || null : null,
    siblingKinds,
    subject: live ? m?.subject || null : null,
    from: live && m ? m.from_name || m.from_email || null : null,
    snippet,
    quote: amountSrc?.quote || null,
    sources: card.sources || {},
  };
}

/** A charge without a currency takes its payee's, when all the payee's other charges agree on one. Pure. */
export function fillCurrencies(charges) {
  const by = new Map();
  for (const c of charges) {
    if (!c.currency || !c.payee) continue;
    if (!by.has(c.payee)) by.set(c.payee, new Set());
    by.get(c.payee).add(c.currency);
  }
  return charges.map((c) => {
    if (c.currency || !c.payee) return c;
    const s = by.get(c.payee);
    return s?.size === 1 ? { ...c, currency: [...s][0], currencyGuessed: true } : c;
  });
}

const STATUS_RANK = { overdue: 0, late: 1, due_soon: 2, due: 3, upcoming: 4, unknown: 5, ended: 6 };

/**
 * Where a bill stands today. Pure.
 * - an unpaid invoice: overdue after its due date, due_soon within `dueDays`, due without a date;
 * - a subscription: late when the renewal date passed and no charge was seen yet, ended when it is
 *   long past (lapsed), unknown without a date (no cadence).
 */
export function billStatus({ nextDue, invoice = false, lapsed = false }, today, dueDays = 7) {
  if (lapsed) return 'ended';
  if (!nextDue) return invoice ? 'due' : 'unknown';
  const d = daysBetween(today, nextDue);
  if (d < 0) return invoice ? 'overdue' : 'late';
  return d <= dueDays ? 'due_soon' : 'upcoming';
}

const idOf = (payee, currency) => `${payee}|${currency || ''}`;

/**
 * The bills view, from charges and subscription cards. Pure.
 * @param {{ charges: object[], subscriptions: object[], now?: Date, oneOff?: Set<string>, known?: string[], minCharges?: number, dueDays?: number }} input
 * @returns {{ today, bills: object[], candidates: object[], totals: object[] }}
 */
export function buildBills({ charges: input, subscriptions = [], now = new Date(), oneOff = null, known = null, minCharges, dueDays = 7 }) {
  const today = isoDay(now);
  const charges = (input || []).map((c) => (c.payee ? c : { ...c, payee: payeeKey(c.merchant) }));
  const payees = classifyPayees(charges, { now, oneOff, known, minCharges });
  const blocked = (pk, names = []) => Boolean(oneOff?.has(pk) || names.some((n) => oneOff?.has(merchantKey(n))));
  const classified = (pk, currency) => payees.find((p) => p.payee === pk && (!currency || (p.currency || null) === currency))
    || payees.find((p) => p.payee === pk) || null;
  const latestLive = (pk) => charges.filter((c) => c.payee === pk && c.messageId).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]?.messageId || null;
  const bills = new Map();

  // The owner's own subscriptions, Reflex's and the finder's stored ones.
  for (const card of subscriptions) {
    const f = card.fields || {};
    const name = f.merchant || (card.message ? senderName(card.message) : null);
    const pk = payeeKey(name);
    if (!pk) continue;
    if (card.layer !== 'user' && blocked(pk, [name])) continue;
    const p = classified(pk, f.currency || null);
    const currency = f.currency || p?.currency || null;
    const cadence = f.cadence || p?.cadence || null;
    const lastPaid = [f.lastCharged, p?.lastCharged].filter(Boolean).sort().pop() || null;
    const ownNext = f.nextRenewal && card.sources?.nextRenewal?.via === 'user' ? f.nextRenewal : null;
    let nextDue = ownNext || (lastPaid && cadence ? addCadence(lastPaid, cadence) : f.nextRenewal || null);
    const lapsed = card.layer !== 'user' && Boolean(nextDue) && daysBetween(today, nextDue) < -45;
    if (lapsed) nextDue = null;
    const amount = f.amount ?? p?.amount ?? null;
    bills.set(idOf(pk, currency), {
      id: idOf(pk, currency), payee: pk, name: name || p?.merchant || pk, currency, amount, cadence, lastPaid, nextDue,
      charges: p?.charges ?? (Number(f.charges) || 0), cardId: card.id, layer: card.layer, lapsed, invoice: null,
      messageId: latestLive(pk) || card.messageId || null,
    });
  }

  // Subscriptions the finder sees that have no card yet.
  for (const p of payees) {
    if (p.verdict !== 'subscription' || bills.has(idOf(p.payee, p.currency)) || bills.has(idOf(p.payee, null))) continue;
    bills.set(idOf(p.payee, p.currency), {
      id: idOf(p.payee, p.currency), payee: p.payee, name: p.merchant, currency: p.currency, amount: p.amount, cadence: p.cadence,
      lastPaid: p.lastCharged, nextDue: p.nextRenewal, charges: p.charges, cardId: null, layer: 'derived', lapsed: p.lapsed, invoice: null,
      messageId: latestLive(p.payee),
    });
  }

  // Unpaid invoices: the next payment of their payee's bill, or a bill of their own.
  for (const c of charges) {
    if (c.kind !== 'invoice' || c.status === 'paid' || c.direction === 'in' || !c.payee) continue;
    if (blocked(c.payee, [c.merchant]) && !bills.has(idOf(c.payee, c.currency))) continue;
    const invoice = { cardId: c.cardId, reference: c.reference, dueDate: c.dueDate, amount: c.amount, currency: c.currency, status: c.status, messageId: c.messageId };
    const key = bills.has(idOf(c.payee, c.currency)) ? idOf(c.payee, c.currency) : bills.has(idOf(c.payee, null)) ? idOf(c.payee, null) : null;
    const existing = key ? bills.get(key) : null;
    if (existing && (!existing.invoice || String(c.dueDate || '9999') < String(existing.invoice.dueDate || '9999'))) {
      existing.invoice = invoice;
      continue;
    }
    if (existing) continue;
    const id = `${idOf(c.payee, c.currency)}|${c.cardId}`;
    bills.set(id, {
      id, payee: c.payee, name: c.merchant, currency: c.currency, amount: c.amount, cadence: null, lastPaid: null, nextDue: c.dueDate,
      charges: 0, cardId: null, layer: 'invoice', lapsed: false, invoice, messageId: c.messageId,
    });
  }

  const list = [...bills.values()].map((b) => {
    const nextDue = b.invoice?.dueDate || b.nextDue;
    const status = billStatus({ nextDue, invoice: Boolean(b.invoice), lapsed: b.lapsed }, today, dueDays);
    const amount = b.invoice?.amount ?? b.amount;
    return {
      ...b,
      amount: amount == null ? null : Number(amount),
      nextDue: nextDue || null,
      daysUntil: nextDue ? daysBetween(today, nextDue) : null,
      status,
      monthly: b.amount != null && MONTHLY[b.cadence] ? round2(Number(b.amount) * MONTHLY[b.cadence]) : null,
    };
  }).sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status])
    || String(a.nextDue || '9999').localeCompare(String(b.nextDue || '9999')) || a.name.localeCompare(b.name));

  const billed = new Set(list.map((b) => b.payee));
  const candidates = payees.filter((p) => p.verdict === 'candidate' && !billed.has(p.payee)).map((p) => ({
    id: idOf(p.payee, p.currency), payee: p.payee, name: p.merchant, currency: p.currency, amount: p.amount, cadence: p.cadence,
    lastPaid: p.lastCharged, charges: p.charges, reason: p.reason, evidence: p.evidence, messageId: latestLive(p.payee),
  })).sort((a, b) => String(b.lastPaid).localeCompare(String(a.lastPaid)));

  return { today, bills: list, candidates, totals: billTotals(list) };
}

/** Per currency: the monthly cost of the running bills and what is due within the window. Pure. */
export function billTotals(bills) {
  const by = new Map();
  for (const b of bills) {
    if (b.status === 'ended') continue;
    const cur = b.currency || null;
    const t = by.get(cur) || { currency: cur, monthly: 0, count: 0, due: 0, dueCount: 0 };
    t.count++;
    if (b.monthly != null && !b.invoice) t.monthly += b.monthly;
    if (['overdue', 'late', 'due_soon', 'due'].includes(b.status) && b.amount != null) { t.due += b.amount; t.dueCount++; }
    by.set(cur, t);
  }
  return [...by.values()].map((t) => ({ ...t, monthly: round2(t.monthly), due: round2(t.due) })).sort((a, b) => b.count - a.count);
}

// ── Reading ─────────────────────────────────────────────────────────────────

const CHARGE_SQL = `SELECT c.id, c.kind, c.fields, c.sources, c.confidence, c.layer, c.message_id, c.message_ids, c.event_at, c.created_at,
    c.updated_at, c.dismissed_at, c.user_edited, c.prompt_id, c.prompt_version, c.model, c.ai_call_id,
    m.id AS m_id, m.subject AS m_subject, m.from_name AS m_from_name, m.from_email AS m_from_email, m.date AS m_date,
    m.thread_key AS m_thread_key, LEFT(m.snippet, 300) AS snippet,
    ARRAY(SELECT DISTINCT k.kind FROM hedwig_cards k
           WHERE k.user_id = c.user_id AND k.id <> c.id AND k.dismissed_at IS NULL AND c.message_id IS NOT NULL
             AND (k.message_id = c.message_id OR c.message_id = ANY(k.message_ids))) AS sibling_kinds
   FROM hedwig_cards c LEFT JOIN messages m ON m.id = c.message_id AND NOT m.is_deleted
  WHERE c.user_id = $1 AND c.kind IN ('receipt', 'invoice') AND c.dismissed_at IS NULL
  ORDER BY c.updated_at DESC LIMIT 5000`;

/** The user's receipts and invoices as charges (currencies filled in). */
export async function loadCharges(userId) {
  const { rows } = await query(CHARGE_SQL, [userId]);
  return fillCurrencies(rows.map((r) => chargeOf(toCard(r), { live: Boolean(r.m_id), siblingKinds: r.sibling_kinds || [], snippet: r.snippet })));
}

async function context(userId) {
  const cfg = await getConfig(userId);
  const [charges, subscriptions, blocks] = await Promise.all([
    loadCharges(userId),
    listCards(userId, { kinds: ['subscription'], limit: 500 }),
    loadBlocks(userId),
  ]);
  return {
    cfg, charges, subscriptions, oneOff: blocks.oneOff,
    opts: { known: Array.isArray(cfg['cards.recurringPayees']) ? cfg['cards.recurringPayees'] : [], minCharges: cfg['cards.subscriptionMinCharges'], dueDays: cfg['cards.billDueDays'] },
  };
}

/** GET /cards/bills */
export async function bills(userId, { now = new Date() } = {}) {
  const ctx = await context(userId);
  return buildBills({ charges: ctx.charges, subscriptions: ctx.subscriptions, oneOff: ctx.oneOff, now, ...ctx.opts });
}

/** A payee key from a route parameter, or a 400. */
export function parsePayee(v) {
  const pk = payeeKey(String(v || '').slice(0, 200));
  if (!pk) throw httpError(400, 'invalid payee');
  return pk;
}

const chargeView = (c) => ({
  cardId: c.cardId, kind: c.kind, date: c.date, amount: c.amount, currency: c.currency, currencyGuessed: c.currencyGuessed,
  merchant: c.merchant, reference: c.reference, status: c.status, dueDate: c.dueDate, direction: c.direction,
  messageId: c.messageId, subject: c.subject, from: c.from, quote: c.quote, missing: !c.messageId,
});

/**
 * GET /cards/bills/:payee: the payee's bills or candidacy, its subscription card (for corrections) and
 * every charge, newest first. Charges whose mail moved are looked for first.
 */
export async function billDetail(userId, payee, { now = new Date() } = {}) {
  let ctx = await context(userId);
  const orphans = ctx.charges.filter((c) => c.payee === payee && !c.messageId).map((c) => c.cardId);
  if (orphans.length && await relinkOrphans(userId, { cardIds: orphans, limit: 50 }) > 0) ctx = await context(userId);
  const mine = ctx.charges.filter((c) => c.payee === payee);
  const cards = ctx.subscriptions.filter((s) => payeeKey(s.fields?.merchant || (s.message ? senderName(s.message) : '')) === payee);
  if (!mine.length && !cards.length) return null;
  const view = buildBills({ charges: ctx.charges, subscriptions: ctx.subscriptions, oneOff: ctx.oneOff, now, ...ctx.opts });
  const name = cards[0]?.fields?.merchant || mine.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]?.merchant || payee;
  return {
    payee,
    name,
    bills: view.bills.filter((b) => b.payee === payee),
    candidate: view.candidates.find((c) => c.payee === payee) || null,
    notBill: Boolean(ctx.oneOff?.has(payee)),
    card: cards[0] || null,
    charges: mine.map(chargeView).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
  };
}

// ── The owner's answers ─────────────────────────────────────────────────────

const keysOf = (payee, names) => [...new Set([payee, ...names.map(merchantKey)].filter(Boolean))];

/** Take back "Not a bill" / "Not a subscription" for a payee, and bring back the cards it hid. */
async function unblock(userId, payee, names) {
  await query(
    `DELETE FROM hedwig_card_feedback WHERE user_id = $1 AND kind = 'subscription'
        AND verdict IN ('not_recurring', 'not_this_kind') AND merchant_key = ANY($2::text[])`,
    [userId, keysOf(payee, names)],
  );
  const hidden = (await listCards(userId, { kinds: ['subscription'], includeDismissed: true, limit: 500 }))
    .filter((c) => c.dismissedAt && payeeKey(c.fields?.merchant) === payee).map((c) => c.id);
  if (hidden.length) {
    await query(
      `UPDATE hedwig_cards SET dismissed_at = NULL, dismissed_reason = NULL, updated_at = NOW()
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND dismissed_reason IN ('owner:not_recurring', 'owner:not_this_kind', 'not_recurring')`,
      [userId, hidden],
    );
  }
}

/**
 * POST /cards/bills/:payee/track { cadence?, amount?, currency?, nextDue?, name? }: the owner says this
 * payee is a bill. Their subscription card holds what they set (those fields never change under
 * them); the last charge and the count keep following the mail.
 */
export async function trackBill(userId, payee, body = {}, { now = new Date() } = {}) {
  const ctx = await context(userId);
  const mine = ctx.charges.filter((c) => c.payee === payee && c.direction !== 'in' && c.amount != null)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const latest = mine[0] || null;
  const amountIn = body.amount == null || body.amount === '' ? null : normAmount(body.amount);
  if (body.amount != null && body.amount !== '' && amountIn == null) throw httpError(400, 'invalid amount');
  if (body.cadence != null && !CADENCES.includes(body.cadence)) throw httpError(400, `cadence must be one of ${CADENCES.join(', ')}`);
  if (!latest && amountIn == null) throw httpError(404, 'No charges from this payee');
  const names = [...new Set(mine.map((c) => c.merchant).filter(Boolean))];
  const p = classifyPayees(mine, { now, known: ctx.opts.known }).find((x) => x.payee === payee);
  const cadence = body.cadence || p?.cadence || 'monthly';
  const name = String(body.name || '').trim().slice(0, 120) || latest?.merchant || payee;
  const currency = normCurrency(body.currency) || latest?.currency || null;
  const amount = amountIn ?? latest?.amount ?? null;
  const lastCharged = latest?.date || null;
  const ownNext = body.nextDue ? normDate(body.nextDue) : null;
  const nextRenewal = ownNext || (lastCharged ? addCadence(lastCharged, cadence) : null);
  const at = new Date(now).toISOString();
  const own = { via: 'user', at };
  const read = { via: 'derived', quote: `${mine.length} charges from ${name}${lastCharged ? `, last on ${lastCharged}` : ''}`, messageId: latest?.messageId || null };
  const fields = { merchant: name, cadence, ...(amount != null ? { amount } : {}), ...(currency ? { currency } : {}),
    ...(lastCharged ? { lastCharged } : {}), ...(nextRenewal ? { nextRenewal } : {}), charges: mine.length };
  const sources = {
    merchant: body.name ? own : read, cadence: own, amount: amountIn != null ? own : read, currency: body.currency ? own : read,
    lastCharged: read, nextRenewal: ownNext ? own : read, charges: read,
  };
  await unblock(userId, payee, names);
  const existing = (await listCards(userId, { kinds: ['subscription'], includeDismissed: true, limit: 500 }))
    .find((c) => payeeKey(c.fields?.merchant) === payee && (!c.fields?.currency || !currency || c.fields.currency === currency));
  let id = existing?.id || null;
  if (existing) {
    await query(
      `UPDATE hedwig_cards SET fields = $3, sources = $4, layer = 'user', user_edited = true, dismissed_at = NULL, dismissed_reason = NULL,
              confidence = 1, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [existing.id, userId, JSON.stringify(fields), JSON.stringify(sources)],
    );
  } else {
    const res = await upsertCard(userId, {
      kind: 'subscription', messageId: latest?.messageId || null, fields, sources, confidence: 1, layer: 'user',
      dedupeKey: `merchant:${payee}:${currency || ''}`,
    });
    id = res?.id || null;
    if (id) await query('UPDATE hedwig_cards SET user_edited = true, dismissed_at = NULL, dismissed_reason = NULL WHERE id = $1', [id]);
  }
  if (id) await recordFeedback(userId, { id, kind: 'subscription', fields, message: null }, { verdict: 'confirmed', merchantKey: payee, after: { fields } });
  return billDetail(userId, payee, { now });
}

/** POST /cards/bills/:payee/not-bill: never a bill again; its subscription cards are hidden. */
export async function notBill(userId, payee) {
  const ctx = await context(userId);
  const cards = ctx.subscriptions.filter((s) => payeeKey(s.fields?.merchant) === payee);
  const name = cards[0]?.fields?.merchant || ctx.charges.find((c) => c.payee === payee)?.merchant || payee;
  for (const c of cards) await dismissCard(userId, c.id, 'not_recurring');
  // Hiding a card already says it under the card's merchant key; the payee needs its own row only when that key differs.
  if (!cards.some((c) => cardMerchantKey(c) === payee)) {
    await recordFeedback(userId, { id: null, kind: 'subscription', fields: { merchant: name }, message: null }, { verdict: 'not_recurring', merchantKey: payee, before: { merchant: name } });
  }
  return { ok: true, payee, hidden: cards.map((c) => c.id) };
}

/** POST /cards/bills/:payee/restore: the undo of Not a bill. */
export async function restoreBill(userId, payee) {
  const ctx = await context(userId);
  const names = [...new Set(ctx.charges.filter((c) => c.payee === payee).map((c) => c.merchant).filter(Boolean))];
  await unblock(userId, payee, names);
  return { ok: true, payee };
}

/**
 * POST /cards/bills/:payee/untrack: the undo of Track. The owner's subscription card is hidden and
 * their confirmation withdrawn; what the finder sees in the mail stays.
 */
export async function untrackBill(userId, payee) {
  const cards = (await listCards(userId, { kinds: ['subscription'], limit: 500 }))
    .filter((c) => c.layer === 'user' && payeeKey(c.fields?.merchant) === payee);
  if (cards.length) {
    await query(
      `UPDATE hedwig_cards SET dismissed_at = NOW(), dismissed_reason = 'owner:untracked', updated_at = NOW() WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, cards.map((c) => c.id)],
    );
  }
  await query(
    `DELETE FROM hedwig_card_feedback WHERE user_id = $1 AND kind = 'subscription' AND verdict = 'confirmed' AND merchant_key = $2`,
    [userId, payee],
  );
  return { ok: true, payee, hidden: cards.map((c) => c.id) };
}
