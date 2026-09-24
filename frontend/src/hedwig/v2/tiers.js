// The two model tiers as the user and the admin see them: their names ("Tier 1 Reflex (fast)",
// "Tier 2 Reasoning (long)"), what serves each one right now and the notice to show (GET /status),
// and whether an output came from the lighter model. Pure.
//
// /status carries `tiers.{ reflex, reasoning, agent }` ({ tier, label, role, model, fallback,
// active, degraded, lighterModel, reason, source, since, checkedAt, latencyMs }) and
// `tiers.notice` ({ level, tier, text, detail } | null) from backend/src/hedwig/llm.js
// tierStatus; the older `models.<fast|long|agent>.{ primary, fallback, active, degraded }` is read
// when `tiers` is missing.
import { tv } from './i18n.js';

export const ROLE_OF_TIER = { reflex: 'fast', reasoning: 'long' };

/** The PRD's names for the model roles. */
export function tierLabel(role) {
  if (role === 'fast' || role === 'reflex') return tv('hedwig.v2.tier.reflex', 'Tier 1 Reflex (fast)');
  if (role === 'long' || role === 'reasoning') return tv('hedwig.v2.tier.reasoning', 'Tier 2 Reasoning (long)');
  if (role === 'agent') return tv('hedwig.v2.tier.agent', 'Agent (tool calling)');
  if (role === 'embeddings') return tv('hedwig.v2.tier.embeddings', 'Embeddings');
  return String(role || '');
}

function isDegraded(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.degraded === true) return true;
  const s = String(t.state || t.status || '').toLowerCase();
  return s === 'degraded' || s === 'slow' || s === 'down' || s === 'fallback';
}

function tierEntry(status, tier) {
  const fromTiers = status?.tiers && typeof status.tiers === 'object' ? status.tiers[tier] : null;
  const fromModels = status?.models && typeof status.models === 'object' ? status.models[ROLE_OF_TIER[tier]] : null;
  const t = (fromTiers && typeof fromTiers === 'object') ? { ...(fromModels || {}), ...fromTiers } : fromModels;
  if (!t || typeof t !== 'object') return null;
  const primary = t.model || t.primary || null;
  const fallback = t.fallback || null;
  const degraded = isDegraded(t);
  return {
    primary, fallback, active: t.active || (degraded ? fallback : primary) || null, degraded,
    reason: t.reason || null, latencyMs: t.latencyMs ?? null, checkedAt: t.checkedAt || null, since: t.since || null,
  };
}

/** { reflex, reasoning } entries (or null), plus the two degraded flags. */
export function tierState(status) {
  const reflex = tierEntry(status, 'reflex');
  const reasoning = tierEntry(status, 'reasoning');
  return { reflex, reasoning, reflexDegraded: Boolean(reflex?.degraded), reasoningDegraded: Boolean(reasoning?.degraded) };
}

/**
 * The notice to show, or null: `tiers.notice` when /status has `tiers` (null there means all is
 * well, whatever older fields say); otherwise one built from `models.long.degraded`.
 * → { level, tier, text, detail } | null
 */
export function tierNotice(status) {
  if (status?.tiers && typeof status.tiers === 'object') {
    const n = status.tiers.notice;
    return n && typeof n === 'object' && typeof n.text === 'string' && n.text.trim()
      ? { level: n.level || 'warning', tier: n.tier || null, text: n.text.trim(), detail: typeof n.detail === 'string' ? n.detail : null }
      : null;
  }
  const t = tierState(status);
  if (!t.reasoningDegraded) return null;
  const who = t.reasoning?.active;
  return {
    level: 'warning',
    tier: 'reasoning',
    text: tv('hedwig.v2.tier.slow', 'Tier 2 is slow; answers use the lighter model'),
    detail: who ? tv('hedwig.v2.tier.slowTitle', '{{tier}} is not answering in time; {{model}} is standing in.', { tier: tierLabel('long'), model: who }) : null,
  };
}

/**
 * Did this output come from the lighter model? `prov` is whatever provenance the route returned
 * ({ lighter | lighterModel | fellBack, model, tier, ... }). An explicit boolean decides. Without it, a model id is only
 * compared when the output was meant for Tier 2 (`expected: 'reasoning'`, e.g. an Ask answer):
 * the Tier 2 fallback, when it is not the Tier 2 primary, means the lighter model answered.
 */
export function isLighter(prov, status, { expected = null } = {}) {
  if (!prov || typeof prov !== 'object') return false;
  // `lighter` (TL;DRs, storyMeta), `lighterModel` (Ask, tiers) and `fellBack` (runPrompt provenance).
  for (const k of ['lighter', 'lighterModel', 'fellBack']) {
    if (prov[k] === true) return true;
  }
  if ([prov.lighter, prov.lighterModel, prov.fellBack].some((v) => v === false)) return false;
  const want = prov.tier || expected;
  if (want !== 'reasoning' || !prov.model) return false;
  const r = tierState(status).reasoning;
  return Boolean(r?.primary && r.fallback && prov.model === r.fallback && prov.model !== r.primary);
}
