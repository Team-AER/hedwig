// Retraining: the sorting heads retrain nightly (at triage.retrainHour, like triage's own model)
// when there are new labels; after triage's model or the heads retrain, recent classifier-layer
// decisions are re-sorted so the new model shows up without waiting for new mail.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { getState, setState } from '../state.js';
import { trainHeads, loadHeads, headsStale } from './classifier.js';
import { engineStamp } from './version.js';

async function enqueueResort(userId, reason) {
  return enqueue('sort.resort', { sinceDays: 7, layers: ['classifier'], reason }, { userId, dedupeKey: `sort.resort:${userId}`, priority: 7 });
}

export async function retrainSortDue(now = new Date()) {
  const { rows } = await query(
    `SELECT s.user_id,
            COUNT(*) FILTER (WHERE s.layer IN ('user','rule') OR (s.layer IN ('reflex','reasoning') AND s.confidence >= 0.8))::int AS labels,
            MAX(s.decided_at) FILTER (WHERE s.layer IN ('user','rule','reflex','reasoning')) AS last_label,
            (SELECT MIN(m.trained_at) FROM hedwig_sort_models m WHERE m.user_id = s.user_id) AS trained_at,
            (SELECT t.trained_at FROM hedwig_triage_models t WHERE t.user_id = s.user_id) AS triage_trained_at
       FROM hedwig_sort s WHERE NOT s.own GROUP BY s.user_id`,
  );
  let trained = 0;
  for (const r of rows) {
    try {
      const cfg = await getConfig(r.user_id);
      if (!cfg.enabled || !cfg['sort.enabled']) continue;
      // Triage retrained its needs-you model: refresh needs_you on recent classifier decisions.
      if (r.triage_trained_at) {
        const seen = await getState(`sort.triageSeen:${r.user_id}`, null);
        if (!seen?.at || new Date(seen.at) < new Date(r.triage_trained_at)) {
          await setState(`sort.triageSeen:${r.user_id}`, { at: new Date(r.triage_trained_at).toISOString() });
          if (seen?.at) await enqueueResort(r.user_id, 'triage retrained');
        }
      }
      if (r.labels < cfg['sort.classifierMinSamples']) continue;
      const due = new Date(now);
      due.setHours(cfg['triage.retrainHour'], 0, 0, 0);
      if (now < due) continue;
      // Heads from an older engine retrain once that engine's re-sort has finished, so they learn
      // from the new decisions rather than the old ones.
      const stale = r.trained_at ? headsStale(await loadHeads(r.user_id)) : false;
      if (stale) {
        const resort = await getState(`sort.engineVersion:${r.user_id}`, null);
        if (resort?.version !== engineStamp() || !resort?.doneAt) continue;
      }
      if (!stale && r.trained_at && new Date(r.trained_at) >= due) continue;
      if (!stale && r.trained_at && r.last_label && new Date(r.last_label) <= new Date(r.trained_at)) continue;
      const res = await trainHeads(r.user_id);
      if (Object.values(res).some((h) => h.ok)) {
        trained++;
        await enqueueResort(r.user_id, 'heads retrained');
      }
    } catch (err) {
      console.warn(`[hedwig] sort: retrain failed for ${r.user_id}:`, err.message);
    }
  }
  return trained;
}
