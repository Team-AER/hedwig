import { describe,it,expect,beforeAll,afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('normalized content persistence',() => {
  let query; let pool; let normaliseRows; let normaliseSweep; let userId; let accountId; let id;
  const html='<p>Payment Received for order 1547718.</p><table><tr><th>Total</th><td>₹1,240</td></tr></table>';
  const notice='This is a HTML email and your email client software does not support HTML email!';
  beforeAll(async () => {
    ({ query,pool }=await import('../../services/db.js'));
    ({ normaliseRows,normaliseSweep }=await import('./store.js'));
    const result=await query("SELECT a.id,a.user_id FROM email_accounts a JOIN users u ON u.id=a.user_id WHERE u.username='demo' LIMIT 1");
    accountId=result.rows[0].id; userId=result.rows[0].user_id;
    const m=await query(`INSERT INTO messages(account_id,uid,folder,subject,date,body_text,body_html,snippet)
      VALUES($1,990001,'INBOX','HTML content regression',NOW(),$2,$3,$2) RETURNING id`,[accountId,notice,html]); id=m.rows[0].id;
  });
  afterAll(async () => { if(id) await query('DELETE FROM messages WHERE id=$1',[id]); await pool?.end(); });
  it('stores a searchable, scoped content projection and repairs the snippet',async () => {
    expect((await normaliseSweep({ messageIds:[id] })).processed).toBe(1);
    const c=(await query('SELECT * FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0];
    expect(c.user_id).toBe(userId); expect(c.text).toContain('Payment Received'); expect(c.changed).toBe(true); expect(c.repair_state).toBe('pending');
    const q=await query("SELECT message_id FROM hedwig_email_content WHERE user_id=$1 AND tsv @@ plainto_tsquery('english','payment')",[userId]);
    expect(q.rows.some((r) => r.message_id===id)).toBe(true);
    expect((await query('SELECT snippet FROM messages WHERE id=$1',[id])).rows[0].snippet).toContain('Payment Received');
  });
  it('is resumable and does not reset completed repair for unchanged content',async () => {
    await query("UPDATE hedwig_email_content SET repair_state='done' WHERE message_id=$1",[id]);
    expect((await normaliseSweep({ messageIds:[id] })).processed).toBe(0);
    await normaliseRows([{ id,user_id:userId,body_text:notice,body_html:html }]);
    expect((await query('SELECT repair_state FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0].repair_state).toBe('done');
  });
  it('invalidates changed bodies, keeps the old projection until replacement, and queues repair again',async () => {
    await query('UPDATE messages SET body_html=$2 WHERE id=$1',[id,'<p>Your order was delivered to reception.</p>']);
    const stale=(await query('SELECT version,text FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0];
    expect(stale.version).toBeNull(); expect(stale.text).toContain('Payment Received');
    await normaliseSweep({ messageIds:[id] });
    const fresh=(await query('SELECT * FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0];
    expect(fresh.text).toContain('delivered'); expect(fresh.repair_state).toBe('pending');
  });
  it('rejects a projection whose user does not own the message',async () => {
    await normaliseRows([{ id,user_id:'00000000-0000-0000-0000-000000000000',body_text:'Injected content' }]);
    expect((await query('SELECT text FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0].text).toContain('delivered');
    expect((await query('SELECT snippet FROM messages WHERE id=$1',[id])).rows[0].snippet).not.toContain('Injected');
  });
  it('builds searchable chunks in resumable batches before model regeneration',async () => {
    const { reindexContentBatch }=await import('./repair.js');
    const first=await reindexContentBatch({ messageIds:[id] });
    expect(first.processed).toBe(1);
    const chunks=(await query("SELECT text FROM hedwig_chunks WHERE message_id=$1 AND kind='body'",[id])).rows;
    expect(chunks.some((r) => r.text.includes('delivered'))).toBe(true);
    expect((await reindexContentBatch({ messageIds:[id] })).processed).toBe(0);
  },30000);
  it('rebuilds an invalidated index even when the content checkpoint is unchanged',async () => {
    const { repairMessage }=await import('./repair.js');
    const { currentRecipe }=await import('../indexer/recipe.js');
    await query("UPDATE messages SET folder='Spam' WHERE id=$1",[id]);
    await query("UPDATE hedwig_index_msg SET chunk_version=NULL,embed_recipe=NULL WHERE message_id=$1",[id]);
    try {
      expect(await repairMessage({messageId:id,userId})).toMatchObject({repaired:id});
      const indexed=(await query('SELECT chunk_version,embed_recipe FROM hedwig_index_msg WHERE message_id=$1',[id])).rows[0];
      const recipe=await currentRecipe();
      expect(indexed.chunk_version).toBe(recipe.version);
      if(recipe.vectors) expect(indexed.embed_recipe).toBe(recipe.full);
      // A later invalidation must also override a completed index-stage checkpoint.
      await query("UPDATE hedwig_email_content SET repair_state='pending' WHERE message_id=$1",[id]);
      await query('UPDATE hedwig_index_msg SET chunk_version=NULL,embed_recipe=NULL WHERE message_id=$1',[id]);
      expect(await repairMessage({messageId:id,userId})).toMatchObject({repaired:id});
      expect((await query('SELECT chunk_version FROM hedwig_index_msg WHERE message_id=$1',[id])).rows[0].chunk_version).toBe(recipe.version);
    } finally {
      await query("UPDATE messages SET folder='INBOX' WHERE id=$1",[id]);
    }
  },30000);
  it('keeps completed repair when a metadata refetch confirms no additional evidence',async () => {
    const { captureMailboxMetadata }=await import('../../services/emailMetadataStore.js');
    await query("UPDATE hedwig_email_content SET repair_state='done' WHERE message_id=$1",[id]);
    await captureMailboxMetadata(accountId,990001,'INBOX','<p>Your order was delivered to reception.</p>',{recordEmpty:true});
    await normaliseSweep({messageIds:[id]});
    expect((await query('SELECT repair_state FROM hedwig_email_content WHERE message_id=$1',[id])).rows[0].repair_state).toBe('done');
  });
  it('repairs malformed topic-summary JSON and preserves the prior summary on repeated invalid output',async () => {
    const { mockGateway }=await import('../testing/mockGateway.js');
    const config=await import('../config.js');
    const { _resetPrompts }=await import('../prompts/index.js');
    const { _resetLlmState }=await import('../llm.js');
    const { summarizeTopic }=await import('../context/summaries.js');
    const { repairContext }=await import('./index.js');
    const gw=mockGateway();
    const oldBase=process.env.HEDWIG_LLM_BASE_URL; const oldCatalog=process.env.HEDWIG_LLM_CATALOG_URL;
    process.env.HEDWIG_LLM_BASE_URL=gw.baseUrl; process.env.HEDWIG_LLM_CATALOG_URL=gw.catalogUrl;
    config.invalidateConfigCache(); _resetLlmState(); _resetPrompts(); gw.install();
    const topic=(await query("INSERT INTO hedwig_topics(user_id,label,summary) VALUES($1,'HTML regression','Prior usable summary') RETURNING id",[userId])).rows[0].id;
    await query('INSERT INTO hedwig_topic_members(topic_id,message_id) VALUES($1,$2)',[topic,id]);
    let calls=0;
    const response=() => ++calls===1 ? { wrong:'shape' } : { summary:'The order was delivered to reception [1].' };
    gw.on('context.summarise',response); gw.on('context.summary',response);
    try {
      expect(await repairContext({userId:'00000000-0000-0000-0000-000000000000',topicId:topic})).toEqual({refreshed:false});
      expect(calls).toBe(0);
      expect(await repairContext({userId,topicId:topic})).toEqual({refreshed:true});
      expect(calls).toBe(2);
      const saved=(await query('SELECT summary,summary_sources FROM hedwig_topics WHERE id=$1',[topic])).rows[0];
      expect(saved.summary).toContain('delivered'); expect(saved.summary_sources).toEqual([id]);
      gw.on('context.summarise',{ wrong:'still invalid' });
      await expect(summarizeTopic(topic,{userId,force:true,suppressHooks:true})).rejects.toMatchObject({code:'invalid_output'});
      expect((await query('SELECT summary FROM hedwig_topics WHERE id=$1',[topic])).rows[0].summary).toBe(saved.summary);
    } finally {
      await query('DELETE FROM hedwig_topics WHERE id=$1',[topic]); gw.restore();
      if(oldBase==null) delete process.env.HEDWIG_LLM_BASE_URL; else process.env.HEDWIG_LLM_BASE_URL=oldBase;
      if(oldCatalog==null) delete process.env.HEDWIG_LLM_CATALOG_URL; else process.env.HEDWIG_LLM_CATALOG_URL=oldCatalog;
      config.invalidateConfigCache(); _resetLlmState(); _resetPrompts();
    }
  });
  it('repairs non-JSON extraction and never marks malformed objects as completed',async () => {
    const { mockGateway }=await import('../testing/mockGateway.js');
    const config=await import('../config.js');
    const { _resetPrompts }=await import('../prompts/index.js');
    const { _resetLlmState }=await import('../llm.js');
    const { runExtraction }=await import('../context/extract.js');
    const gw=mockGateway();const oldBase=process.env.HEDWIG_LLM_BASE_URL;const oldCatalog=process.env.HEDWIG_LLM_CATALOG_URL;
    const key=`html_regression_${id.replaceAll('-','')}`;
    process.env.HEDWIG_LLM_BASE_URL=gw.baseUrl;process.env.HEDWIG_LLM_CATALOG_URL=gw.catalogUrl;
    config.invalidateConfigCache();_resetLlmState();_resetPrompts();gw.install();
    await query('INSERT INTO hedwig_msg(message_id,user_id,account_id) VALUES($1,$2,$3) ON CONFLICT(message_id) DO NOTHING',[id,userId,accountId]);
    gw.on('context.extract',['Here are the extracted facts.',{commitments:[],facts:[{key,value:'Delivered to reception',confidence:0.95}],resolves:[]}]);
    try {
      await runExtraction({messageId:id,repair:true,recheck:true});
      expect(gw.callsFor('context.extract')).toHaveLength(2);
      const fact=(await query('SELECT value FROM hedwig_facts WHERE user_id=$1 AND source_message_id=$2 AND key=$3',[userId,id,key])).rows[0];
      expect(fact?.value).toBe('Delivered to reception');
      const before=(await query('SELECT extracted_at FROM hedwig_msg WHERE message_id=$1',[id])).rows[0].extracted_at;
      gw.on('context.extract',{wrong:'shape'});
      await expect(runExtraction({messageId:id,repair:true,recheck:true})).rejects.toMatchObject({code:'invalid_output'});
      expect((await query('SELECT extracted_at FROM hedwig_msg WHERE message_id=$1',[id])).rows[0].extracted_at).toEqual(before);
      expect((await query('SELECT value FROM hedwig_facts WHERE user_id=$1 AND source_message_id=$2 AND key=$3',[userId,id,key])).rows[0].value).toBe(fact.value);
    } finally {
      await query('DELETE FROM hedwig_facts WHERE user_id=$1 AND source_message_id=$2 AND key=$3',[userId,id,key]);gw.restore();
      if(oldBase==null)delete process.env.HEDWIG_LLM_BASE_URL;else process.env.HEDWIG_LLM_BASE_URL=oldBase;
      if(oldCatalog==null)delete process.env.HEDWIG_LLM_CATALOG_URL;else process.env.HEDWIG_LLM_CATALOG_URL=oldCatalog;
      config.invalidateConfigCache();_resetLlmState();_resetPrompts();
    }
  });
  it('captures inert metadata from the raw mailbox body without putting it into display HTML',async () => {
    const { captureMailboxMetadata }=await import('../../services/emailMetadataStore.js');
    await captureMailboxMetadata(accountId,990001,'INBOX','<script type="application/ld+json">{"@type":"Order","orderNumber":"1547718"}</script>');
    expect((await query('SELECT data FROM hedwig_email_metadata WHERE message_id=$1',[id])).rows[0].data[0].node.orderNumber).toBe('1547718');
    expect((await query('SELECT body_html FROM messages WHERE id=$1',[id])).rows[0].body_html).not.toContain('ld+json');
  });
});
