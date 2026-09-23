// Layer 3: Reflex (sort.reflex on the Tier-1 model), escalating to the reasoning tier for low
// confidence or suspected phishing. Input assembly and output normalisation are pure and exported
// for tests; runReflex() makes the calls through sort/deps.js.
import { addressesOf } from '../text.js';
import { runSortPrompt } from './deps.js';

const STREAM_SYNONYMS = {
  people: 'people', person: 'people', personal: 'people', human: 'people', direct: 'people',
  reading: 'reading', read: 'reading', newsletter: 'reading', newsletters: 'reading', updates: 'reading', promotions: 'reading',
  records: 'records', record: 'records', receipt: 'records', receipts: 'records', notification: 'records', notifications: 'records', transactional: 'records',
};
const SPAM_VALUES = new Set(['clean', 'suspected', 'phishing']);
export const REASON_MAX = 90;

/** Plain, second-person, at most `max` characters. */
export function cleanReason(text, max = REASON_MAX) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const wrapped = /^["'“‘](.*)["'”’]$/s.exec(s);
  if (wrapped && !/["“”]/.test(wrapped[1])) s = wrapped[1].trim();
  s = s.replace(/\bthe user's\b/gi, 'your').replace(/\bthe user\b/gi, 'you').replace(/\buser's\b/gi, 'your');
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    s = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
  }
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function clip(text, max) {
  const s = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** "the user is in To" etc. */
export function recipientRole(row, userAddresses) {
  const to = addressesOf(row.to_addresses).map((a) => a.email);
  const cc = addressesOf(row.cc_addresses).map((a) => a.email);
  if (to.some((e) => userAddresses.has(e))) return to.length > 1 ? `in To with ${to.length - 1} other${to.length > 2 ? 's' : ''}` : 'the only person in To';
  if (cc.some((e) => userAddresses.has(e))) return 'in Cc only';
  return 'not in To or Cc (Bcc, an alias or a list)';
}

/** One line of sender history for the prompt. */
export function historyLine(sender, { decision = null, wroteTo = false } = {}) {
  const parts = [];
  const received = Number(sender?.received || 0);
  if (received <= 1) parts.push('first message from them');
  else {
    parts.push(`${received} messages received`);
    parts.push(`you replied to ${Number(sender.replied || 0)}`);
    parts.push(`opened ${Number(sender.opened || 0)}`);
    const ignored = Number(sender.archived_unread || 0) + Number(sender.deleted_unread || 0);
    if (ignored) parts.push(`left ${ignored} unread`);
  }
  if (wroteTo) parts.push('you have written to them');
  if (decision) parts.push(`you put this sender in ${decision}`);
  return parts.join(', ');
}

/** "<subject>" from x: Hedwig said a, the user chose b (note). Lenient about the stored shape. */
export function correctionLine(c) {
  const before = c?.before && typeof c.before === 'object' ? c.before : {};
  const after = c?.after && typeof c.after === 'object' ? c.after : {};
  // Only what the user changed, plus the stream for context.
  const changed = (k) => after[k] !== undefined && after[k] !== null && JSON.stringify(after[k]) !== JSON.stringify(before[k]);
  const desc = (o, all) => {
    const bits = [];
    if (o.stream && (all || changed('stream') || changed('bundle'))) bits.push(o.bundle ? `${o.stream}/${o.bundle}` : o.stream);
    else if (o.bundle && (all || changed('bundle'))) bits.push(`bundle ${o.bundle}`);
    if (o.needsYou !== undefined && o.needsYou !== null && (all ? changed('needsYou') : changed('needsYou'))) bits.push(o.needsYou ? 'needs you' : 'does not need you');
    if (o.spam && changed('spam')) bits.push(`spam: ${o.spam}`);
    if (o.decision && (all || changed('decision'))) bits.push(o.decision);
    return bits.join(', ');
  };
  const a = desc(after, false);
  if (!a) return null;
  const what = [after.subject || before.subject ? `"${clip(after.subject || before.subject, 80)}"` : null,
    after.from || before.from ? `from ${after.from || before.from}` : null].filter(Boolean).join(' ') || `a ${c.kind || 'message'}`;
  const b = desc(before, true);
  return clip(`${what}: ${b ? `Hedwig said ${b}; ` : ''}the user chose ${a}${c.note ? ` (${c.note})` : ''}`, 260);
}

/**
 * One message as the prompt sees it.
 * @param {object} row
 * @param {object} parts   { newText, quoted, attachments } (A's messageParts or the local split)
 * @param {object} ctx     { index, userAddresses, sender, decision, wroteTo, signals, cfg }
 */
export function reflexItem(row, parts, { index, userAddresses = new Set(), sender = null, decision = null, wroteTo = false, signals = [], cfg = {} }) {
  const newMax = cfg['sort.newTextChars'] ?? 2500;
  const quotedMax = cfg['sort.quotedChars'] ?? 600;
  const atts = [...(parts?.attachments || []).map((a) => a?.filename), ...(Array.isArray(row.attachments) ? row.attachments.map((a) => a?.filename || a?.name) : [])]
    .filter(Boolean);
  return {
    id: `m${index + 1}`,
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : String(row.from_email || 'unknown'),
    role: recipientRole(row, userAddresses),
    subject: clip(row.subject, 200),
    date: row.date ? new Date(row.date).toISOString().slice(0, 16).replace('T', ' ') : null,
    history: historyLine(sender, { decision, wroteTo }),
    signals: signals.map((s) => (typeof s === 'string' ? s : s.label)).filter(Boolean).slice(0, 8),
    attachments: [...new Set(atts)].slice(0, 5),
    newText: clip(parts?.newText || row.snippet || '', newMax),
    quoted: quotedMax ? clip(parts?.quoted || '', quotedMax) : '',
  };
}

/** Variables for the sort.reflex prompt. */
export function buildReflexVars({ user, items, corrections = [], bundles = [], rules = [], now = null }) {
  return {
    user: { name: user?.name || null, addresses: [...(user?.addresses || [])].slice(0, 10) },
    now,
    bundles: bundles.filter((b) => b.enabled !== false).map((b) => ({ key: b.key, name: b.name, hint: b.hint || b.description || '' })),
    rules,
    corrections: corrections.map(correctionLine).filter(Boolean).slice(0, 10),
    items,
  };
}

function toConfidence(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1 && n <= 100) n /= 100;
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}

const bool = (v) => v === true || v === 'true' || v === 1 || v === 'yes';

/**
 * Validate and repair Reflex output. Unknown ids are ignored; ids with no usable entry come back
 * in `missing`.
 * @returns {{ results: Map<string, object>, missing: string[] }}
 */
export function normaliseReflex(data, ids, bundles = [], ruleIds = []) {
  const known = new Set(ids);
  const bundleByKey = new Map(bundles.map((b) => [String(b.key).toLowerCase(), b.key]));
  const bundleByName = new Map(bundles.map((b) => [String(b.name).toLowerCase(), b.key]));
  const rules = new Set(ruleIds.map(String));
  const results = new Map();
  const list = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id ?? '').trim();
    if (!known.has(id) || results.has(id)) continue;
    const stream = STREAM_SYNONYMS[String(e.stream ?? '').trim().toLowerCase()];
    if (!stream) continue;
    const b = String(e.bundle ?? '').trim().toLowerCase();
    let bundle = bundleByKey.get(b) || bundleByName.get(b) || null;
    if (stream === 'people') bundle = null;
    const needsYou = bool(e.needs_you ?? e.needsYou);
    const spamRaw = String(e.spam ?? 'clean').trim().toLowerCase();
    results.set(id, {
      stream,
      bundle,
      needsYou,
      needsYouReason: needsYou ? cleanReason(e.needs_you_reason ?? e.needsYouReason ?? '') || null : null,
      spam: SPAM_VALUES.has(spamRaw) ? spamRaw : spamRaw === 'spam' ? 'suspected' : 'clean',
      confidence: toConfidence(e.confidence),
      reason: cleanReason(e.reason) || null,
      matches: (Array.isArray(e.matches) ? e.matches : []).map(String).filter((r) => rules.has(r)),
    });
  }
  return { results, missing: ids.filter((id) => !results.has(id)) };
}

/** Needs escalation to the reasoning tier? */
export function needsEscalation(r, cfg) {
  if (!r) return true;
  if (r.confidence < (cfg['sort.escalateBelow'] ?? 0.6)) return true;
  return r.spam === 'phishing' && r.confidence < (cfg['spam.phishingEscalateBelow'] ?? 0.8);
}

/**
 * Run Reflex over prepared items and escalate the unsure ones.
 * @param {string} userId
 * @param {{ items: object[], messageIds: string[], user, bundles, rules, corrections, now }} batch
 *        items[i] belongs to messageIds[i]
 * @param {object} cfg
 * @returns {Promise<Map<string, object>>} messageId → normalised result with layer and provenance
 */
export async function runReflex(userId, batch, cfg) {
  const { items, messageIds } = batch;
  const idToMessage = new Map(items.map((it, i) => [it.id, messageIds[i]]));
  const ruleIds = (batch.rules || []).map((r) => r.id);
  const out = new Map();
  const call = async (subset, escalate) => {
    const vars = buildReflexVars({ ...batch, items: subset });
    const { data, provenance } = await runSortPrompt('sort.reflex', vars, { userId, lane: 'background', escalate });
    // The tier that actually answered: runPrompt's last retry runs on the other tier, so an
    // escalated call can end on Reflex and a Reflex call on the reasoning model.
    const tier = provenance?.tier || (escalate ? 'reasoning' : 'reflex');
    const layer = tier === 'reasoning' ? 'reasoning' : 'reflex';
    const norm = normaliseReflex(data, subset.map((s) => s.id), batch.bundles || [], ruleIds);
    for (const [id, r] of norm.results) out.set(idToMessage.get(id), { ...r, layer, provenance: provenance || null });
    return norm;
  };
  const first = await call(items, false);
  const unsure = items.filter((it) => {
    const r = out.get(idToMessage.get(it.id));
    return first.missing.includes(it.id) || (r && r.layer === 'reflex' && needsEscalation(r, cfg));
  });
  if (unsure.length) {
    try {
      await call(unsure, true);
    } catch (err) {
      console.warn(`[hedwig] sort: escalation to the reasoning model failed for ${unsure.length} message(s): ${err.message}`);
    }
  }
  return out;
}
