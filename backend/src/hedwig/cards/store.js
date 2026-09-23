// Card storage: one row per thing (dedupe key), merged as more mail about it arrives. User edits win
// over anything Hedwig reads later; deadline cards are the commitments view (hedwig_cards_all).
import { query } from '../../services/db.js';
import { recordCorrection } from '../ledger/corrections.js';
import { CARD_KINDS, FIELDS, INTERNAL_FIELDS, dedupeKey, eventAt, normField, normFields } from './kinds.js';

const LAYER_RANK = { user: 6, schema_org: 5, ics: 5, pattern: 4, reasoning: 3, reflex: 2, derived: 1 };
const DELIVERY_ORDER = ['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

const time = (d) => (d ? new Date(d).getTime() : 0);

/**
 * Merge a newly detected card into the stored one. Pure.
 * - fields an edit set (sources[k].via === 'user') never change;
 * - a delivery takes the status of the latest mail and keeps the history;
 * - an event takes a higher calendar SEQUENCE (updates, cancellations);
 * - otherwise a newer message, or a more certain layer, fills or replaces fields.
 * @param {{ fields, sources, layer, confidence, messageIds: string[], messageDate?: string, sequence?: number }} old
 * @param {{ fields, sources, layer, confidence, messageId: string, messageDate?: string, sequence?: number }} next
 */
export function mergeCards(kind, old, next) {
  const fields = { ...old.fields };
  const sources = { ...old.sources };
  const edited = (k) => sources[k]?.via === 'user';
  const newer = time(next.messageDate) >= time(old.messageDate);
  const stronger = (LAYER_RANK[next.layer] || 0) >= (LAYER_RANK[old.layer] || 0);
  const seqUp = kind === 'event' && Number(next.sequence || 0) > Number(old.fields.sequence || 0);
  for (const [k, v] of Object.entries(next.fields)) {
    if (INTERNAL_FIELDS.has(k) || edited(k)) continue;
    const missing = fields[k] === undefined || fields[k] === null;
    if (kind === 'delivery' && k === 'status') continue;
    if (missing || seqUp || (newer && stronger) || (kind === 'delivery' && newer && ['expectedDate', 'expectedBy'].includes(k))) {
      fields[k] = v;
      if (next.sources[k]) sources[k] = next.sources[k];
    }
  }
  if (kind === 'event' && next.sequence != null) fields.sequence = Math.max(Number(old.fields.sequence || 0), Number(next.sequence || 0));
  if (kind === 'delivery' && next.fields.status) {
    const history = Array.isArray(old.fields.history) ? [...old.fields.history] : [];
    if (!history.some((h) => h.messageId === next.messageId && h.status === next.fields.status)) {
      history.push({ status: next.fields.status, at: next.messageDate || null, messageId: next.messageId });
    }
    history.sort((a, b) => time(a.at) - time(b.at));
    fields.history = history.slice(-20);
    if (!edited('status')) {
      const latest = history[history.length - 1];
      // Delivered is final unless a later mail says otherwise; out-of-order mail never moves it back.
      fields.status = latest.status;
      const idx = (s) => DELIVERY_ORDER.indexOf(s);
      const best = history.reduce((b, h) => (idx(h.status) > idx(b) ? h.status : b), latest.status);
      if (best === 'delivered' && latest.status !== 'exception') fields.status = 'delivered';
      const src = next.messageId === latest.messageId ? next.sources.status : null;
      if (src) sources.status = src;
    }
  }
  const messageIds = [...new Set([...(old.messageIds || []), next.messageId].filter(Boolean))];
  return {
    fields,
    sources,
    messageIds,
    confidence: Math.max(Number(old.confidence) || 0, Number(next.confidence) || 0),
    layer: stronger ? next.layer : old.layer,
  };
}

/**
 * Store one detected card (insert, or merge into the card for the same thing).
 * @param {string} userId
 * @param {{ kind, messageId, fields, sources, confidence, layer, sequence?, provenance?: { promptId, promptVersion, model, aiCallId } }} card
 * @param {{ messageDate?: string|Date }} [ctx]
 * @returns {Promise<{ id: string, created: boolean }|null>}
 */
export async function upsertCard(userId, card, { messageDate = null } = {}) {
  if (!CARD_KINDS.includes(card.kind) || card.kind === 'deadline') return null;
  const fields = normFields(card.kind, card.fields);
  if (card.kind === 'delivery' && Array.isArray(card.fields?.history)) fields.history = card.fields.history;
  if (!Object.keys(fields).length) return null;
  const sources = Object.fromEntries(Object.entries(card.sources || {}).filter(([k]) => k in fields));
  const key = card.dedupeKey || dedupeKey({ ...card, fields });
  const msgDate = messageDate ? new Date(messageDate).toISOString() : null;
  const p = card.provenance || {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows: found } = await query(
      `SELECT c.id, c.fields, c.sources, c.layer, c.confidence, c.message_ids, m.date AS message_date
         FROM hedwig_cards c LEFT JOIN messages m ON m.id = c.message_id
        WHERE c.user_id = $1 AND c.kind = $2 AND c.dedupe_key = $3`,
      [userId, card.kind, key],
    );
    const old = found[0];
    if (!old) {
      const initial = card.kind === 'delivery' && fields.status && !fields.history
        ? { ...fields, history: [{ status: fields.status, at: msgDate, messageId: card.messageId }] }
        : (card.kind === 'event' && card.sequence != null ? { ...fields, sequence: card.sequence } : fields);
      const { rows } = await query(
        `INSERT INTO hedwig_cards (user_id, message_id, message_ids, kind, dedupe_key, fields, sources, confidence, layer,
                                   prompt_id, prompt_version, model, ai_call_id, event_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
         RETURNING id`,
        [userId, card.messageId || null, card.messageId ? [card.messageId] : [], card.kind, key, JSON.stringify(initial), JSON.stringify(sources),
          card.confidence ?? null, card.layer, p.promptId || null, p.promptVersion || null, p.model || null, p.aiCallId || null,
          eventAt({ kind: card.kind, fields: initial }, msgDate)],
      );
      if (rows[0]) return { id: rows[0].id, created: true };
      continue; // someone inserted it meanwhile: merge
    }
    const merged = mergeCards(card.kind, {
      fields: old.fields || {}, sources: old.sources || {}, layer: old.layer, confidence: old.confidence,
      messageIds: old.message_ids || [], messageDate: old.message_date,
    }, { fields, sources, layer: card.layer, confidence: card.confidence, messageId: card.messageId, messageDate: msgDate, sequence: card.sequence });
    const fromModel = card.layer === 'reflex' || card.layer === 'reasoning';
    await query(
      `UPDATE hedwig_cards SET fields = $2, sources = $3, message_ids = $4::uuid[], confidence = $5, layer = $6, event_at = $7, updated_at = NOW(),
              prompt_id = CASE WHEN $8 THEN $9 ELSE prompt_id END, prompt_version = CASE WHEN $8 THEN $10 ELSE prompt_version END,
              model = CASE WHEN $8 THEN $11 ELSE model END, ai_call_id = CASE WHEN $8 THEN $12 ELSE ai_call_id END
        WHERE id = $1`,
      [old.id, JSON.stringify(merged.fields), JSON.stringify(merged.sources), merged.messageIds, merged.confidence, merged.layer,
        eventAt({ kind: card.kind, fields: merged.fields }, old.message_date), fromModel, p.promptId || null, p.promptVersion || null, p.model || null, p.aiCallId || null],
    );
    return { id: old.id, created: false };
  }
  return null;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const CARD_COLS = `c.id, c.kind, c.fields, c.sources, c.confidence, c.layer, c.message_id, c.message_ids, c.event_at, c.created_at,
  c.updated_at, c.dismissed_at, c.user_edited, c.prompt_id, c.prompt_version, c.model, c.ai_call_id,
  m.subject AS m_subject, m.from_name AS m_from_name, m.from_email AS m_from_email, m.date AS m_date, m.thread_key AS m_thread_key`;
const CARD_FROM = `FROM hedwig_cards_all c LEFT JOIN messages m ON m.id = c.message_id`;

export function toCard(r) {
  return {
    id: r.id,
    kind: r.kind,
    fields: r.fields || {},
    sources: r.sources || {},
    confidence: r.confidence == null ? null : Number(r.confidence),
    layer: r.layer,
    messageId: r.message_id,
    messageIds: r.message_ids || [],
    eventAt: r.event_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dismissedAt: r.dismissed_at,
    userEdited: Boolean(r.user_edited),
    provenance: { promptId: r.prompt_id, promptVersion: r.prompt_version, model: r.model, aiCallId: r.ai_call_id == null ? null : Number(r.ai_call_id) },
    message: r.message_id ? { id: r.message_id, subject: r.m_subject, from_name: r.m_from_name, from_email: r.m_from_email, date: r.m_date, thread_key: r.m_thread_key } : null,
  };
}

/**
 * The user's cards, newest first.
 * @param {{ kinds?: string[], since?: Date|string, limit?: number, includeDismissed?: boolean, messageId?: string }} [opts]
 */
export async function listCards(userId, { kinds = null, since = null, limit = 100, includeDismissed = false, messageId = null } = {}) {
  const params = [userId];
  const where = ['c.user_id = $1'];
  if (kinds?.length) { params.push(kinds); where.push(`c.kind = ANY($${params.length}::text[])`); }
  if (since) { params.push(new Date(since)); where.push(`GREATEST(c.updated_at, COALESCE(c.event_at, c.updated_at)) >= $${params.length}`); }
  if (!includeDismissed) where.push('c.dismissed_at IS NULL');
  if (messageId) { params.push(messageId); where.push(`(c.message_id = $${params.length} OR $${params.length} = ANY(c.message_ids))`); }
  where.push('(c.message_id IS NULL OR m.id IS NULL OR m.is_deleted = false)');
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const { rows } = await query(
    `SELECT ${CARD_COLS} ${CARD_FROM} WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(m.date, c.updated_at) DESC, c.id LIMIT $${params.length}`,
    params,
  );
  return rows.map(toCard);
}

export async function getCard(userId, id) {
  const { rows } = await query(`SELECT ${CARD_COLS} ${CARD_FROM} WHERE c.user_id = $1 AND c.id = $2`, [userId, id]);
  return rows[0] ? toCard(rows[0]) : null;
}

// ── Editing ─────────────────────────────────────────────────────────────────

/**
 * Validate an edit: only the kind's declared fields; null clears one. Pure.
 * @returns {{ set: object, clear: string[] }}
 */
export function validateEdit(kind, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'fields must be an object');
  const set = {};
  const clear = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in (FIELDS[kind] || {})) || INTERNAL_FIELDS.has(k)) throw httpError(400, `${k} is not a field of a ${kind} card`);
    if (v === null || v === '') { clear.push(k); continue; }
    const n = normField(kind, k, v);
    if (n === undefined) throw httpError(400, `invalid value for ${k}`);
    set[k] = n;
  }
  if (!Object.keys(set).length && !clear.length) throw httpError(400, 'nothing to update');
  return { set, clear };
}

/** Edit a card: a correction (kind 'card'). Deadline cards edit their commitment. */
export async function patchCard(userId, id, patch) {
  const card = await getCard(userId, id);
  if (!card) return null;
  const { set, clear } = validateEdit(card.kind, patch);
  const before = Object.fromEntries([...Object.keys(set), ...clear].map((k) => [k, card.fields[k] ?? null]));
  if (card.kind === 'deadline') {
    const { updateCommitment } = await import('../context/commitments.js');
    const cpatch = {};
    if ('what' in set) cpatch.what = set.what;
    if ('dueAt' in set) cpatch.due_at = set.dueAt;
    if (clear.includes('dueAt')) cpatch.due_at = null;
    if (!Object.keys(cpatch).length) throw httpError(400, 'only what and dueAt can be changed on a deadline');
    await updateCommitment(userId, id, cpatch);
  } else {
    const fields = { ...card.fields, ...set };
    for (const k of clear) delete fields[k];
    const sources = { ...card.sources };
    const at = new Date().toISOString();
    for (const k of Object.keys(set)) sources[k] = { via: 'user', at, before: card.fields[k] ?? null };
    for (const k of clear) sources[k] = { via: 'user', at, before: card.fields[k] ?? null, cleared: true };
    await query(
      `UPDATE hedwig_cards SET fields = $3, sources = $4, user_edited = true, event_at = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [id, userId, JSON.stringify(fields), JSON.stringify(sources), eventAt({ kind: card.kind, fields }, card.message?.date)],
    );
  }
  const after = { ...Object.fromEntries(clear.map((k) => [k, null])), ...set };
  await recordCorrection({
    userId, kind: 'card', targetId: id, before: { kind: card.kind, fields: before }, after: { kind: card.kind, fields: after },
    promptId: card.provenance.promptId, promptVersion: card.provenance.promptVersion,
  });
  return getCard(userId, id);
}

/** Hide a card. A deadline card dismisses its commitment. */
export async function dismissCard(userId, id) {
  const card = await getCard(userId, id);
  if (!card) return null;
  if (card.kind === 'deadline') {
    const { updateCommitment } = await import('../context/commitments.js');
    await updateCommitment(userId, id, { status: 'dismissed' });
  } else {
    await query('UPDATE hedwig_cards SET dismissed_at = COALESCE(dismissed_at, NOW()), updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId]);
  }
  await recordCorrection({
    userId, kind: 'card', targetId: id, before: { kind: card.kind, dismissed: false }, after: { kind: card.kind, dismissed: true },
    note: 'dismissed', promptId: card.provenance.promptId, promptVersion: card.provenance.promptVersion,
  });
  return { ok: true, id };
}
