// Worker schedules for the runtime: the job health gate, the model probe, the reaper, reconcile,
// the rebuild-based retry of failed work, and transcript pruning. Registered once from core's
// worker() hook.
//
//   runtime.healthGate    jobs.healthGateSec (60 s)     catalog unreachable → gateway jobs deferred
//   runtime.probeModels   llm.probe.everySec (60 s)     each model answers a tiny completion, or is
//                                                       degraded and its calls go to the fallback;
//                                                       a degraded model every degradedEverySec (300 s)
//   runtime.reapStuck     300 s                          running past timeout → queued again
//   runtime.reconcile     jobs.reconcileEverySec (15 min) failed → resolved when the work exists
//   runtime.retryFailed   jobs.retryEverySec (1 h)       failed kinds with rebuild() re-enqueued
//   runtime.pruneTranscripts 6 h
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { defineSchedule } from '../schedule.js';
import { healthGate, reapStuck, reconcile, retryFailed } from '../jobs.js';
import { probeModels } from '../llm.js';
import { setDefaultLane } from './context.js';

/** Null out prompt/output text older than llm.transcriptDays. */
export async function pruneTranscripts() {
  const cfg = await getConfig();
  const { rowCount } = await query(
    `UPDATE hedwig_ai_calls SET prompt_text = NULL, output_text = NULL
      WHERE created_at < NOW() - ($1 || ' days')::interval AND (prompt_text IS NOT NULL OR output_text IS NOT NULL)`,
    [String(cfg['llm.transcriptDays'])],
  );
  return { pruned: rowCount || 0 };
}

/**
 * The hourly retry: reconcile first (so work that exists is resolved, not retried), then re-enqueue
 * failed rows of kinds with rebuild() that failed at least one retry period ago.
 */
export async function scheduledRetry() {
  const cfg = await getConfig();
  const rec = await reconcile();
  const out = await retryFailed(null, { rebuildOnly: true, olderThanSec: Math.max(600, (cfg['jobs.retryEverySec'] ?? 3600) - 60), max: cfg['jobs.retryMaxPerRun'] ?? 200 });
  if (out.enqueued || out.resolved || rec.resolved) {
    console.log(`[hedwig] scheduled retry: ${rec.resolved + out.resolved} resolved, ${out.retried} retried, ${out.enqueued} enqueued`);
  }
  return { ...out, resolved: rec.resolved + out.resolved };
}

// The probe schedule's tick; llm.js probeModels decides per model whether a probe is due.
const PROBE_TICK_SEC = 15;

export async function registerRuntimeSchedules() {
  // Everything the worker runs on its own is background work.
  setDefaultLane('background');
  const cfg = await getConfig().catch(() => null);
  defineSchedule({ name: 'runtime.healthGate', everySec: cfg?.['jobs.healthGateSec'] ?? 60, run: () => healthGate() });
  defineSchedule({ name: 'runtime.reapStuck', everySec: 300, run: () => reapStuck() });
  defineSchedule({ name: 'runtime.reconcile', everySec: cfg?.['jobs.reconcileEverySec'] ?? 900, run: () => reconcile() });
  // Ticks every PROBE_TICK_SEC; probeModels decides per model whether a probe is due (every
  // llm.probe.everySec, a degraded model only every llm.probe.degradedEverySec).
  defineSchedule({ name: 'runtime.probeModels', everySec: PROBE_TICK_SEC, run: () => probeModels() });
  // jobs.retryEverySec is read when the worker starts (a change applies after a worker restart).
  defineSchedule({ name: 'runtime.retryFailed', everySec: cfg?.['jobs.retryEverySec'] ?? 3600, run: () => scheduledRetry() });
  defineSchedule({ name: 'runtime.pruneTranscripts', everySec: 6 * 3600, run: () => pruneTranscripts() });
}
