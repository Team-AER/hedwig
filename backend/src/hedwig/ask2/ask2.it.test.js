// Ask on the chunk index over the seeded demo mailbox (scripts/hedwig-seed.mjs), with the mock
// gateway (no live model) and hash embeddings (HEDWIG_EMBEDDINGS_PROVIDER=hash in .env.hedwig-dev).
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/ask2
// Also runs D's ask eval (labels/eval.js runSuite('ask')) against this pipeline with the mock.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

describe.skipIf(!process.env.HEDWIG_IT)('Ask on the index (demo mailbox)', () => {
  let query; let pool; let userId; let ask; let history; let feedback; let config;
  let builtEntities = false;
  const gw = mockGateway();
  const asked = [];
  const ENV = ['HEDWIG_LLM_BASE_URL', 'HEDWIG_LLM_CATALOG_URL', 'HEDWIG_LLM_FALLBACK_MODEL', 'HEDWIG_INDEX_FLOOR'];
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    config = await import('../config.js');
    config.invalidateConfigCache();
    const u = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u.rows[0].id;
    // Make sure every demo message is chunked and embedded (the indexer IT test may have reset them).
    const pipeline = await import('../pipeline.js');
    const store = await import('../indexer/store.js');
    const { rows } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS} FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND m.is_deleted = false
          AND NOT EXISTS (SELECT 1 FROM hedwig_chunks c WHERE c.message_id = m.id)`,
      [userId],
    );
    if (rows.length) await store.indexMessages(await pipeline.decorate(rows));
    await store.drain(() => store.embedPending({ maxChunks: 256 }), { budgetMs: 30_000, maxRounds: 50 });
    // "from Thomas" resolves through the context engine's people (hedwig_entities). After a fresh
    // seed they exist only if the context IT test happened to run first, so build them here when
    // missing (and remove them again afterwards) instead of depending on the file order.
    const { rows: [known] } = await query("SELECT COUNT(*)::int AS n FROM hedwig_entities WHERE user_id = $1 AND kind <> 'self'", [userId]);
    if (!known.n) {
      const { runEntitiesStep } = await import('../context/entities.js');
      const { rows: all } = await query(
        `SELECT ${pipeline.MESSAGE_COLUMNS} FROM messages m JOIN email_accounts a ON a.id = m.account_id
           LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
          WHERE a.user_id = $1 AND m.is_deleted = false ORDER BY m.date DESC`,
        [userId],
      );
      await runEntitiesStep(await pipeline.decorate(all));
      builtEntities = true;
    }

    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    process.env.HEDWIG_LLM_FALLBACK_MODEL = '';
    config.invalidateConfigCache();
    gw.install();
    gw.on('ask.plan', { text: '', people: [], after: null, before: null, folders: [], hasAttachment: null, latest: false });
    // The mock answers from the evidence it is shown, citing the message that states the fee.
    gw.on('ask.answer', (req) => {
      const evidence = req.messages.at(-1).content;
      if (/zanzibar/i.test(evidence.split('Question:').pop())) return "I couldn't find anything about that in your mail.";
      const m = /\[(\d+)\] From: Thomas Reed[^\n]*\n[^[]*£1,450/.exec(evidence);
      return m ? `The solicitor's fee is £1,450 plus the government fee [${m[1]}].` : "I couldn't find that in your mail.";
    });
    gw.on('ask.verify', (req) => ({ supported: /1,450/.test(req.text), answerable: true, quote: '£1,450', sourceId: 'c1', reason: 'stated' }));
    ({ answerQuestion: ask } = await import('./answer.js'));
    ({ askHistory: history, answerFeedback: feedback } = await import('./history.js'));
  }, 90_000);

  afterAll(async () => {
    gw.restore();
    for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    config.invalidateConfigCache();
    if (asked.length) {
      await query("DELETE FROM hedwig_corrections WHERE user_id = $1 AND kind = 'answer' AND target_id = ANY($2::text[])", [userId, asked]).catch(() => {});
      await query("DELETE FROM hedwig_labels WHERE user_id = $1 AND suite = 'ask' AND target_id = ANY($2::text[])", [userId, asked.map((id) => `asklog:${id}`)]).catch(() => {});
      await query('DELETE FROM hedwig_ask_log WHERE id = ANY($1::uuid[])', [asked]);
    }
    await query("DELETE FROM hedwig_labels WHERE user_id = $1 AND suite = 'ask' AND evidence->>'rule' = 'ask2-it'", [userId]).catch(() => {});
    if (builtEntities) await query('DELETE FROM hedwig_entities WHERE user_id = $1', [userId]);
    await pool?.end();
  });

  it('answers from the chunk index with a checked citation, and logs the plan', async () => {
    const events = [];
    const out = await ask(userId, 'What is the solicitor fee from Thomas?', { onEvent: (e) => events.push(e) });
    asked.push(out.askLogId);
    expect(events.map((e) => e.type)[0]).toBe('sources');
    expect(events.at(-1)).toMatchObject({ type: 'done', unsupported: false, askLogId: out.askLogId });
    expect(out.answer).toMatch(/£1,450 plus the government fee \[\d+\]/);
    const cited = out.sources.find((s) => s.n === out.citations[0]);
    expect(cited.message.from_email).toBe('thomas@reedlaw.example');
    const { rows: [log] } = await query('SELECT plan, sources, citations, unsupported, prompt_id, model FROM hedwig_ask_log WHERE id = $1', [out.askLogId]);
    expect(log.plan).toMatchObject({ people: ['thomas@reedlaw.example'], via: 'rules', retrieval: { via: 'index' } });
    expect(log.prompt_id).toBe('ask.answer');
    expect(log.unsupported).toBe(false);
    expect(log.sources.length).toBe(out.sources.length);
    expect(gw.callsFor('ask.plan')).toHaveLength(0); // the rules found a person: no Reflex plan
  });

  it('returns saved answers with their sources, and records "wrong answer" feedback', async () => {
    const list = await history(userId, { limit: 5 });
    const saved = list.find((h) => h.id === asked[0]);
    expect(saved.answer).toMatch(/£1,450/);
    expect(saved.sources.length).toBeGreaterThan(0);
    expect(saved.sources[0]).toMatchObject({ n: 1, message: { id: expect.any(String), subject: expect.any(String) } });
    const res = await feedback(userId, asked[0], { wrong: true, note: 'the fee changed' });
    expect(res.feedback).toMatchObject({ wrong: true, note: 'the fee changed' });
    const { rows: corr } = await query("SELECT after FROM hedwig_corrections WHERE user_id = $1 AND kind = 'answer' AND target_id = $2", [userId, asked[0]]);
    expect(corr[0].after).toEqual({ wrong: true });
    const { rows: labels } = await query("SELECT grade, source FROM hedwig_labels WHERE user_id = $1 AND suite = 'ask' AND target_id = $2", [userId, `asklog:${asked[0]}`]);
    expect(labels[0]).toEqual({ grade: 'gold', source: 'correction' });
  });

  it('carries sources into a follow-up', async () => {
    const out = await ask(userId, 'and how long does it take?', { followUpOf: asked[0], onEvent: () => {} });
    asked.push(out.askLogId);
    const prev = (await history(userId, { limit: 10 })).find((h) => h.id === asked[0]);
    expect(out.sources.slice(0, prev.sources.length).map((s) => s.message.id)).toEqual(prev.sources.map((s) => s.message.id).slice(0, 8));
    const { rows: [log] } = await query('SELECT follow_up_of FROM hedwig_ask_log WHERE id = $1', [out.askLogId]);
    expect(log.follow_up_of).toBe(asked[0]);
  });

  it('answers "nothing relevant" with no model call when nothing clears the relevance floor', async () => {
    process.env.HEDWIG_INDEX_FLOOR = '0.99';
    config.invalidateConfigCache();
    const before = gw.callsFor('ask.answer').length;
    const out = await ask(userId, 'What did the plumber quote for the Bergen cabin?', { onEvent: () => {} });
    asked.push(out.askLogId);
    delete process.env.HEDWIG_INDEX_FLOOR;
    config.invalidateConfigCache();
    expect(out.notFound).toBe(true);
    expect(out.sources).toEqual([]);
    expect(gw.callsFor('ask.answer').length).toBe(before);
  });

  it("scores through D's ask eval with the mock gateway", async () => {
    const { upsertLabels } = await import('../labels/store.js');
    const { rows: src } = await query(
      `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND m.subject = 'Sponsorship application – fees and timeline'`,
      [userId],
    );
    await query("DELETE FROM hedwig_labels WHERE user_id = $1 AND suite = 'ask'", [userId]);
    await upsertLabels(userId, [
      { suite: 'ask', targetId: 'ask:it-fee', grade: 'silver', source: 'generated', label: { question: 'What does Thomas Reed charge for the sponsorship application?', answer: '£1,450 plus the government fee', sourceIds: [src[0].id], answerable: true }, evidence: { rule: 'ask2-it' } },
      { suite: 'ask', targetId: 'ask:it-none', grade: 'silver', source: 'generated', label: { question: 'When is my ferry to Zanzibar?', answerable: false, sourceIds: [] }, evidence: { rule: 'ask2-it' } },
    ]);
    const { runSuite } = await import('../labels/eval.js');
    const res = await runSuite('ask', { userId });
    expect(res.nSilver).toBe(2);
    expect(res.silver).toMatchObject({ sourceRecall: 1, faithfulness: 1, notFoundRate: 1, fakeNotFound: 0 });
    // The eval's own questions are not kept in the user's history.
    const { rows } = await query("SELECT COUNT(*)::int AS n FROM hedwig_ask_log WHERE user_id = $1 AND question LIKE '%Zanzibar%'", [userId]);
    expect(rows[0].n).toBe(0);
  }, 60_000);
});
