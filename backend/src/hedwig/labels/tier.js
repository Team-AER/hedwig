// Is Tier 2 (the reasoning model) serving right now? Read by the jobs that must not quietly run on
// the lighter model: the nightly judge (its two opinions must come from two different models), Ask
// triples, the profile rebuild and the Brief's prose. Ask reads it to label a lighter-model answer.
//
// Sources, in order:
//   1. llm.tierStatus(userId) when the runtime provides it (its answer wins);
//   2. llm.activeModels(): the primary of the `long` role is in its fallback cooldown in this process;
//   3. hedwig_ai_calls, so the worker and the API agree: the latest call to the Tier 2 model in the
//      last tier.windowMin minutes failed (the gateway gave no answer, timed out, 5xx).
// No recent call at all counts as healthy: the next call finds out.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import * as llm from '../llm.js';

const WINDOW_MIN = 30;

/** Read an export without tripping over test mocks that do not define it. */
function llmExport(name) {
  try { return llm[name]; } catch { return undefined; }
}

/** Accept whichever shape the runtime's tierStatus uses for the reasoning tier. Pure. */
export function normaliseTierStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const t = status.reasoning || status.long || status.tier2 || status[2] || status['2'] || null;
  if (!t || typeof t !== 'object') return null;
  const state = typeof t.state === 'string' ? t.state : typeof t.status === 'string' ? t.status : null;
  const degraded = typeof t.degraded === 'boolean' ? t.degraded
    : state ? !['ok', 'healthy', 'up', 'serving'].includes(state) : Boolean(t.lighterModel);
  return {
    degraded,
    model: t.primary || t.model || null,
    serving: t.active || t.serving || t.model || null,
    reason: t.reason || t.error || state || null,
    source: 'runtime',
  };
}

/** Decide from the latest calls to the Tier 2 model (newest first). Pure. */
export function degradedFromCalls(calls) {
  if (!calls?.length) return { degraded: false, reason: null };
  const [latest] = calls;
  if (latest.ok) return { degraded: false, reason: null };
  return { degraded: true, reason: String(latest.error || 'no answer').slice(0, 120), since: latest.created_at || null };
}

/**
 * @returns {Promise<{ degraded: boolean, model: string|null, serving: string|null, fallback: string|null, reason: string|null, source: string }>}
 */
export async function reasoningTier(userId = null) {
  const tierStatus = llmExport('tierStatus');
  if (typeof tierStatus === 'function') {
    try {
      let status = await tierStatus(userId);
      // Just after a worker start nothing has probed Tier 2 yet, and "never checked" reads as
      // healthy: a judge run would then wait out llm.timeoutMs on a model that is not answering.
      // Probe once (bounded by llm.probe.timeoutMs) before believing it.
      const probeModels = llmExport('probeModels');
      if (status?.reasoning && !status.reasoning.degraded && !status.reasoning.checkedAt && status.probe?.enabled && typeof probeModels === 'function') {
        await probeModels();
        status = await tierStatus(userId);
      }
      const n = normaliseTierStatus(status);
      if (n) return { fallback: null, ...n };
    } catch { /* fall through to our own reading */ }
  }
  const cfg = await getConfig(userId);
  const primary = cfg['llm.models.long'] || null;
  const fallback = cfg['llm.fallbackModel'] && cfg['llm.fallbackModel'] !== primary ? cfg['llm.fallbackModel'] : null;
  const activeModels = llmExport('activeModels');
  if (typeof activeModels === 'function') {
    try {
      const long = (await activeModels(userId))?.long;
      if (long?.degraded) return { degraded: true, model: primary, serving: long.active || fallback, fallback, reason: 'in fallback cooldown', source: 'cooldown' };
    } catch { /* ignore */ }
  }
  if (!primary) return { degraded: false, model: null, serving: null, fallback, reason: null, source: 'none' };
  try {
    const { rows } = await query(
      `SELECT ok, error, created_at FROM hedwig_ai_calls
        WHERE model = $1 AND created_at > NOW() - make_interval(mins => $2::int)
        ORDER BY created_at DESC LIMIT 3`,
      [primary, WINDOW_MIN],
    );
    const d = degradedFromCalls(rows);
    return { degraded: d.degraded, model: primary, serving: d.degraded ? fallback : primary, fallback, reason: d.reason, source: 'calls' };
  } catch {
    return { degraded: false, model: primary, serving: primary, fallback, reason: null, source: 'unknown' };
  }
}

/**
 * Did a call's provenance come from the lighter model? runPrompt's provenance (fellBack, tier,
 * model) or a chat/chatStream result (fellBack, model). Pure.
 */
export function ranOnLighterModel(provenance, tier2Model = null) {
  if (!provenance) return false;
  if (typeof provenance.lighterModel === 'boolean') return provenance.lighterModel;
  if (provenance.fellBack) return true;
  if (provenance.tier && provenance.tier !== 'reasoning') return true;
  return Boolean(tier2Model && provenance.model && provenance.model !== tier2Model);
}
