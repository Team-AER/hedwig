import { runTriage } from '../triage/classify.js';
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { emailContent } from '../../services/emailContent.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { indexMessages, embedPending } from '../indexer/store.js';
import { sortRows, runReflexJob } from '../sort/engine.js';
import { runCardsJob } from '../cards/extract.js';
import { summariseMessages, summariseThreads } from '../work/summaries.js';
import { loadThreadMessages, ownerOf } from '../work/util.js';
import { runExtraction } from '../context/extract.js';
import { runEmbedStep } from '../context/embed.js';
import { enqueue } from '../jobs.js';
import { normaliseRows } from './store.js';

export async function contentRepairStatus() {
  return (await query(`SELECT repair_state,state,changed,COUNT(*)::int AS messages FROM hedwig_email_content GROUP BY 1,2,3 ORDER BY 1,2`)).rows;
}

/** Each successful stage is checkpointed; a failed model call leaves the previous usable output. */
export async function repairMessage({ messageId, userId }) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, c.content_hash,c.repair_progress,c.repair_state,
       h.extracted_at,h.embedded_at,
       EXISTS(SELECT 1 FROM hedwig_work_tldr t WHERE t.message_id=m.id) AS had_tldr,
       EXISTS(SELECT 1 FROM hedwig_work_stories w WHERE w.user_id=a.user_id AND w.thread_key=m.thread_key) AS had_story
     FROM messages m JOIN email_accounts a ON a.id=m.account_id
     LEFT JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
     JOIN hedwig_email_content c ON c.message_id=m.id AND c.user_id=a.user_id
     LEFT JOIN hedwig_msg h ON h.message_id=m.id
     WHERE m.id=$1 AND a.user_id=$2 AND NOT m.is_deleted`, [messageId,userId],
  );
  if (!rows.length) return { skipped: 'gone' };
  const row = rows[0]; const expectedHash = emailContent(row).hash;
  if (expectedHash !== row.content_hash) { await normaliseRows(rows); return { status: 'partial', note: 'body changed; projection refreshed, retry required' }; }
  if (row.repair_state === 'done') return { skipped: 'already repaired' };
  await decorate(rows);
  const cfg = await getConfig(userId);
  const progress = row.repair_progress || {};
  const stage = async (name, fn) => {
    if (progress[name] === expectedHash) return;
    await fn();
    await query(`UPDATE hedwig_email_content SET repair_progress=repair_progress || jsonb_build_object($3::text,$4::text),repair_state='running',repair_error=NULL
      WHERE message_id=$1 AND user_id=$2 AND content_hash=$4`, [messageId,userId,name,expectedHash]);
    progress[name] = expectedHash;
  };
  try {
    await stage('index', async () => {
      await indexMessages(rows);
      await embedPending({ messageIds:[messageId],maxChunks:256 });
      const indexed=(await query('SELECT error FROM hedwig_index_msg WHERE message_id=$1',[messageId])).rows[0];
      if (indexed?.error) throw new Error(indexed.error);
      if (row.embedded_at) await runEmbedStep(rows);
    });
    const spam = row.special_use === '\\Junk' || /(^|[/.])(spam|junk|bulk mail)$/i.test(row.folder || '');
    const within = !cfg['analysis.historyDays'] || !row.date || Date.now()-new Date(row.date).getTime() < cfg['analysis.historyDays']*86400000;
    if (cfg.enabled && !spam && within) {
      await stage('triage', () => runTriage(rows,{ repair:true }));
      await stage('sort', async () => {
        await sortRows(rows, { historical:true,allowReflex:false,repair:true });
        if (cfg['llm.baseUrl'] && row.date && Date.now()-new Date(row.date).getTime() < cfg['sort.reflexMaxAgeDays']*86400000) {
          const result = await runReflexJob({ messageIds:[messageId],repair:true },{ user_id:userId });
          if (result?.missing) throw new Error('sort repair returned incomplete evidence');
        }
      });
      await stage('cards', async () => {
        const result = await runCardsJob({ userId,messageIds:[messageId] });
        if (result?.status === 'partial') throw new Error(`card repair partial: ${result.note}`);
      });
      if (row.had_story || row.had_tldr) await stage('summary', async () => {
        const owner = await ownerOf(userId);
        if (row.had_story && row.thread_key) {
          const messages = await loadThreadMessages(userId,row.thread_key,{ addresses:owner.addresses });
          const results = await summariseThreads(userId,[{ threadKey:row.thread_key,messages }],{ cfg,owner,save:true,source:'content-repair' });
          if (!results[0]?.ok) throw new Error('story repair produced no usable summary');
        }
        if (row.had_tldr) {
          const result = await summariseMessages(userId,rows,{ cfg,owner });
          if (result.failed || !result.written) throw new Error('TL;DR repair produced no usable summary');
        }
      });
      if (row.extracted_at) await stage('extraction', () => runExtraction({ messageId,repair:true,recheck:true }));
    }
    await stage('dependencies', async () => {
      // Historical answers remain historical; flag their evidence instead of silently rewriting them.
      await query(`UPDATE hedwig_ask_log SET evidence_stale=true WHERE user_id=$1 AND sources @> $2::jsonb`,[userId,JSON.stringify([messageId])]);
      // Only the machine-generated gist is invalidated; every other plugin annotation survives.
      await query(`UPDATE messages SET plugin_annotations=jsonb_set(plugin_annotations,'{gtd}',(plugin_annotations->'gtd')-'gist')
        WHERE id=$1 AND plugin_annotations->'gtd' ? 'gist'`,[messageId]);
      await query(`UPDATE hedwig_entities e SET summary_at=NULL WHERE e.user_id=$1 AND e.id IN (SELECT entity_id FROM hedwig_message_entities WHERE message_id=$2)`,[userId,messageId]);
      await query(`UPDATE hedwig_topics t SET summary_at=NULL WHERE t.user_id=$1 AND t.id IN (SELECT topic_id FROM hedwig_topic_members WHERE message_id=$2)`,[userId,messageId]);
      if (!spam) await enqueue('content.repairDependencies',{ userId },{ userId,dedupeKey:`content:dependencies:${userId}`,priority:9 });
    });
    await query(`UPDATE hedwig_email_content SET repair_state='done',auto_repair=false,repaired_at=NOW(),repair_error=NULL WHERE message_id=$1 AND user_id=$2 AND content_hash=$3`,[messageId,userId,expectedHash]);
    return { repaired:messageId,hash:expectedHash };
  } catch (err) {
    await query(`UPDATE hedwig_email_content SET repair_state='failed',repair_error=$3 WHERE message_id=$1 AND user_id=$2`,[messageId,userId,String(err.message).slice(0,1000)]);
    throw err;
  }
}

export async function enqueueContentRepairs({ messageIds = null, limit = 100, newlyChangedOnly = false } = {}) {
  const { rows } = await query(`SELECT c.message_id,c.user_id,c.content_hash FROM hedwig_email_content c JOIN messages m ON m.id=c.message_id
    WHERE c.changed AND c.repair_state<>'done' AND NOT m.is_deleted AND ($1::uuid[] IS NULL OR c.message_id=ANY($1)) AND (NOT $3::boolean OR (c.auto_repair AND c.repair_state='pending'))
    ORDER BY m.date DESC NULLS LAST LIMIT $2`,[messageIds,limit,newlyChangedOnly]);
  let enqueued = 0;
  for (const row of rows) {
    const id = await enqueue('content.repair',{ messageId:row.message_id,userId:row.user_id },{
      userId:row.user_id,dedupeKey:`content:repair:${row.message_id}:${row.content_hash}`,priority:9,maxAttempts:8,
    });
    if (id) enqueued++;
  }
  return { candidates:rows.length,enqueued };
}
