import { query } from '../../services/db.js';
import { captureMailboxMetadata } from '../../services/emailMetadataStore.js';
import { guardedFetch,bodyRateFor,providerOf } from '../core/mailYield.js';
import { enqueue } from '../jobs.js';
import { getConfig } from '../config.js';

export const METADATA_JOB='content.fetchMetadata';

export function metadataHandler(imapManager) {
  return async ({ messageId,userId }) => {
    const { rows }=await query(`SELECT m.uid,m.folder,m.account_id,a.* FROM messages m JOIN email_accounts a ON a.id=m.account_id
      WHERE m.id=$1 AND a.user_id=$2 AND a.enabled AND NOT m.is_deleted`,[messageId,userId]);
    if(!rows.length) return;
    const row=rows[0];const account={ ...row,id:row.account_id };
    const { html }=await guardedFetch({ imapManager,account,kind:METADATA_JOB,messageId },() => imapManager.fetchMessageBody(account,row.uid,row.folder));
    await captureMailboxMetadata(account.id,row.uid,row.folder,html,{ recordEmpty:true });
  };
}

/** Refetch only changed transactional mail whose pre-sanitization metadata is unavailable. */
export async function enqueueMetadataRefresh({ messageIds=null,limit=10000 }={}) {
  const cfg=await getConfig();
  const { rows }=await query(`SELECT m.id,a.id AS account_id,a.user_id,a.imap_host,a.oauth_provider
    FROM hedwig_email_content c JOIN messages m ON m.id=c.message_id JOIN email_accounts a ON a.id=m.account_id
    LEFT JOIN hedwig_email_metadata em ON em.message_id=m.id
    WHERE c.changed AND em.message_id IS NULL AND a.enabled AND NOT m.is_deleted AND m.body_html IS NOT NULL
      AND m.subject ~* '(order|invoice|receipt|booking|reservation|shipment|delivery|ticket|payment)'
      AND ($1::uuid[] IS NULL OR m.id=ANY($1)) ORDER BY m.date DESC NULLS LAST LIMIT $2`,[messageIds,limit]);
  const until=new Map(); let queued=0;
  for(const row of rows) {
    const host=row.imap_host || row.account_id;
    const rate=bodyRateFor(cfg,{ host,provider:providerOf(row) });
    const at=Math.max(Date.now(),until.get(host)||0); until.set(host,at+1000/Math.max(0.01,rate));
    const id=await enqueue(METADATA_JOB,{ messageId:row.id,userId:row.user_id,host },{
      userId:row.user_id,dedupeKey:`content:metadata:${row.id}`,runAt:new Date(at),priority:8,maxAttempts:3,
    });
    if(id)queued++;
  }
  return { candidates:rows.length,queued };
}
