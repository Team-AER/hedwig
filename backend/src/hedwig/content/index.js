import { tokenize } from '../../services/spamTokenizer.js';
import { retrainUser as retrainSpam } from '../../services/spamModelStore.js';
import { retrainUser as retrainTriage } from '../triage/learning.js';
import { METADATA_JOB,metadataHandler } from './metadata.js';
import { query } from '../../services/db.js';
import { defineStep } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { normaliseRows, normaliseSweep } from './store.js';
import { repairMessage, contentRepairStatus, enqueueContentRepairs } from './repair.js';
import { summarizeEntity, summarizeTopic } from '../context/summaries.js';
import { rebuildProfile } from '../profile/service.js';
import { generateBriefing } from '../insights/briefing.js';
import { judgeForUser } from '../labels/judge.js';

export async function repairDependencies({ userId }) {
  const failures=[];
  const refresh=async (name,fn) => {
    try { return await fn(); } catch (err) {
      if (['budget_exceeded','lane_busy','tier_degraded','job_deferred'].includes(err.code)) throw err;
      failures.push(`${name}: ${err.message}`);
      return null;
    }
  };
  const { rows:training }=await query('SELECT id,subject,body_text,body_html FROM spam_training_log WHERE user_id=$1 AND body_html IS NOT NULL',[userId]);
  for (const record of training) {
    const counts=Object.create(null);
    for(const token of tokenize({ subject:record.subject,body:record.body_text,bodyHtml:record.body_html })) counts[token]=(counts[token]||0)+1;
    await query('UPDATE spam_training_log SET token_counts=$3 WHERE id=$1 AND user_id=$2',[record.id,userId,JSON.stringify(counts)]);
  }
  await retrainSpam(userId);
  await retrainTriage(userId);
  const { rows:entities } = await query('SELECT id FROM hedwig_entities WHERE user_id=$1 AND summary_at IS NULL AND summary IS NOT NULL',[userId]);
  for (const e of entities) await refresh(`entity ${e.id}`, () => summarizeEntity(e.id,{ userId,force:true,suppressHooks:true }));
  const { rows:topics } = await query('SELECT id FROM hedwig_topics WHERE user_id=$1 AND summary_at IS NULL AND summary IS NOT NULL',[userId]);
  for (const t of topics) await refresh(`topic ${t.id}`, () => summarizeTopic(t.id,{ userId,force:true,suppressHooks:true }));
  const { rows:profile } = await query('SELECT user_id FROM hedwig_profile WHERE user_id=$1 LIMIT 1',[userId]);
  if (profile.length) await refresh('profile', () => rebuildProfile(userId));
  await refresh('labels', async () => {
    const result=await judgeForUser(userId);
    if (result.partial) throw new Error('label refresh returned partial output');
    return result;
  });
  await refresh('briefing', () => generateBriefing(userId,{ period:'day' }));
  if (failures.length) throw new Error(`dependency refresh incomplete: ${failures.join('; ').slice(0,850)}`);
  return { refreshed:true };
}

export default {
  name:'content',
  api({ imapManager }) { defineJob(METADATA_JOB,metadataHandler(imapManager),{ timeoutMs:90000 }); },
  worker() {
    defineStep({ name:'content',order:5,backfill:true,spam:true,run:normaliseRows });
    defineSchedule({ name:'content.normalise',everySec:10,run:async () => { await normaliseSweep(); await enqueueContentRepairs({ newlyChangedOnly:true }); } });
    defineJob('content.repair',repairMessage,{ timeoutMs:15*60_000,needsGateway:true });
    defineJob('content.repairDependencies',repairDependencies,{ timeoutMs:15*60_000,needsGateway:true });
  },
  adminRoutes(r) { r.get('/content/health',async (_req,res) => res.json(await contentRepairStatus())); },
};
