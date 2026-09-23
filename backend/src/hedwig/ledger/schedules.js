// Worker schedules for the runtime: the job health gate, the reaper, reconcile, and transcript
// pruning. Registered once from core's worker() hook.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { defineSchedule } from '../schedule.js';
import { healthGate, reapStuck, reconcile } from '../jobs.js';
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

export async function registerRuntimeSchedules() {
  // Everything the worker runs on its own is background work.
  setDefaultLane('background');
  const cfg = await getConfig().catch(() => null);
  defineSchedule({ name: 'runtime.healthGate', everySec: cfg?.['jobs.healthGateSec'] ?? 60, run: () => healthGate() });
  defineSchedule({ name: 'runtime.reapStuck', everySec: 300, run: () => reapStuck() });
  defineSchedule({ name: 'runtime.reconcile', everySec: cfg?.['jobs.reconcileEverySec'] ?? 900, run: () => reconcile() });
  defineSchedule({ name: 'runtime.pruneTranscripts', everySec: 6 * 3600, run: () => pruneTranscripts() });
}
