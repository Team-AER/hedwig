// Runs the context pipeline over the seeded demo mailbox (scripts/hedwig-seed.mjs) in the dev DB.
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/context
// Only context-owned rows for the demo user are reset. No model calls are made.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('context engine over the demo mailbox', () => {
  let query;
  let pool;
  let userId;
  let rows;
  let pipeline;
  let service;

  const one = async (sql, params = [userId]) => (await query(sql, params)).rows[0];

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    pipeline = await import('../pipeline.js');
    const jobs = await import('../jobs.js');
    const schedule = await import('../schedule.js');
    const { invalidateConfigCache } = await import('../config.js');
    service = await import('./service.js');
    const context = (await import('./index.js')).default;
    pipeline._resetSteps();
    jobs._resetJobs();
    schedule._resetSchedules();
    invalidateConfigCache();
    await context.worker();

    const u = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u.rows[0].id;
    for (const table of ['hedwig_commitments', 'hedwig_facts', 'hedwig_topics', 'hedwig_embeddings', 'hedwig_entities', 'hedwig_ask_log']) {
      await query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
    ({ rows } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS} FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND m.is_deleted = false ORDER BY m.date DESC`,
      [userId],
    ));
    await query(
      `INSERT INTO hedwig_msg (message_id, user_id, account_id) SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[])
       ON CONFLICT (message_id) DO NOTHING`,
      [rows.map((r) => r.id), rows.map((r) => r.user_id), rows.map((r) => r.account_id)],
    );
    // Two batches, newest first, like the scanner.
    await pipeline.runSteps(rows.slice(0, 30));
    await pipeline.runSteps(rows.slice(30));
  }, 60_000);

  afterAll(async () => {
    if (userId) {
      await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind LIKE 'context.%' AND done_at IS NULL", [userId]);
      await query("DELETE FROM hedwig_jobs WHERE kind = 'mail.fetchBody' AND done_at IS NULL AND payload->>'messageId' = ANY($1::text[])", [rows.map((r) => r.id)]);
    }
    await pool?.end();
  });

  it('builds people, organisations and the self entity with correct counts', async () => {
    const priya = await one(
      `SELECT e.*, o.display_name AS org FROM hedwig_entities e LEFT JOIN hedwig_entities o ON o.id = e.org_id
        WHERE e.user_id = $1 AND e.primary_email = 'priya.nair@vantage.example'`,
    );
    expect(priya).toMatchObject({ kind: 'person', display_name: 'Priya Nair', message_count: 16, received_count: 15, sent_count: 1, is_bulk: false, org: 'Vantage' });
    const self = await one(
      `SELECT COUNT(DISTINCT e.id)::int AS entities, COUNT(*)::int AS addresses FROM hedwig_entity_addresses ea
         JOIN hedwig_entities e ON e.id = ea.entity_id WHERE ea.user_id = $1 AND e.kind = 'self'`,
    );
    expect(self).toEqual({ entities: 1, addresses: 3 });
    expect((await one("SELECT is_bulk FROM hedwig_entities WHERE user_id = $1 AND primary_email = 'notifications@github.com'")).is_bulk).toBe(true);
    expect(await one("SELECT COUNT(*)::int AS n FROM hedwig_entities WHERE user_id = $1 AND kind = 'org' AND domain = 'gmail.com'")).toEqual({ n: 0 });
  });

  it('is idempotent when a batch is processed again', async () => {
    const before = await one('SELECT SUM(message_count)::int AS m, SUM(received_count)::int AS r, SUM(sent_count)::int AS s FROM hedwig_entities WHERE user_id = $1');
    const topicsBefore = await one('SELECT COUNT(*)::int AS n, SUM(message_count)::int AS m FROM hedwig_topics WHERE user_id = $1');
    await pipeline.runSteps(rows.map((r) => ({ ...r })));
    expect(await one('SELECT SUM(message_count)::int AS m, SUM(received_count)::int AS r, SUM(sent_count)::int AS s FROM hedwig_entities WHERE user_id = $1')).toEqual(before);
    expect(await one('SELECT COUNT(*)::int AS n, SUM(message_count)::int AS m FROM hedwig_topics WHERE user_id = $1')).toEqual(topicsBefore);
  });

  it('embeds every message and keeps an HNSW index for the configured dimension', async () => {
    const { n, dims } = await one('SELECT COUNT(*)::int AS n, MIN(dims) AS dims FROM hedwig_embeddings WHERE user_id = $1');
    expect(n).toBe(rows.length);
    const idx = await one('SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2', ['hedwig_embeddings', `idx_hedwig_embeddings_hnsw_${dims}`]);
    expect(idx).toBeTruthy();
    expect(await one("SELECT COUNT(*)::int AS n FROM hedwig_msg WHERE user_id = $1 AND embedded_at IS NULL AND skip_reason IS NULL")).toEqual({ n: 0 });
  });

  it('groups a thread, including the sent reply, into one topic and leaves bulk and unanswered sent mail out', async () => {
    const visa = await query(
      `SELECT DISTINCT tm.topic_id FROM messages m JOIN email_accounts a ON a.id = m.account_id
         JOIN hedwig_topic_members tm ON tm.message_id = m.id WHERE a.user_id = $1 AND m.thread_id = '<visa-root@hedwig.test>'`,
      [userId],
    );
    expect(visa.rows).toHaveLength(1);
    const card = await service.getTopicCard(userId, visa.rows[0].topic_id);
    expect(card.timeline.map((t) => t.message.subject)).toEqual([
      'Visa sponsorship', 'Re: Visa sponsorship', 'Re: Visa sponsorship', 'Re: Visa sponsorship — final documents by 30 Sep',
    ]);
    expect(card.timeline[0].message.account).toMatchObject({ name: 'Outlook · work', color: '#2B5FAE' });
    expect(card.people.map((p) => p.primary_email)).toContain('priya.nair@vantage.example');
    const bulkInTopics = await one(
      `SELECT COUNT(*)::int AS n FROM hedwig_topic_members tm JOIN messages m ON m.id = tm.message_id
         JOIN hedwig_topics t ON t.id = tm.topic_id WHERE t.user_id = $1 AND m.is_bulk`,
    );
    expect(bulkInTopics).toEqual({ n: 0 });
    const laptop = await one(
      `SELECT COUNT(*)::int AS n FROM hedwig_topic_members tm JOIN messages m ON m.id = tm.message_id
         JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND m.subject = 'Laptop replacement request'`,
    );
    expect(laptop).toEqual({ n: 0 });
  });

  it('queues extraction for mail with real people only', async () => {
    const queued = await query(
      `SELECT m.subject FROM hedwig_jobs j JOIN messages m ON m.id = (j.payload->>'messageId')::uuid
        WHERE j.user_id = $1 AND j.kind = 'context.extract' AND j.done_at IS NULL`,
      [userId],
    );
    const subjects = queued.rows.map((r) => r.subject);
    expect(subjects).toContain('Re: Visa sponsorship — final documents by 30 Sep');
    expect(subjects.some((s) => /Money Stuff|CI failed|order has shipped/.test(s))).toBe(false);
  });

  it('finds the visa thread with hybrid search, and only for its owner', async () => {
    const { results } = await service.searchMessages(userId, { q: 'visa sponsorship documents', limit: 5 });
    expect(results.slice(0, 3).every((r) => /visa sponsorship/i.test(r.subject))).toBe(true);
    expect(results[0]).toHaveProperty('score');
    expect(results[0].account).toHaveProperty('color');
    const priya = await one("SELECT id FROM hedwig_entities WHERE user_id = $1 AND primary_email = 'priya.nair@vantage.example'");
    const scoped = await service.searchMessages(userId, { q: 'offsite', entityId: priya.id, limit: 5 });
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(scoped.results.every((r) => r.from_email === 'priya.nair@vantage.example' || r.from_email === 'prakhar@vantage.example')).toBe(true);
    const stranger = '00000000-0000-4000-8000-000000000000';
    expect((await service.searchMessages(stranger, { q: 'visa sponsorship' })).results).toEqual([]);
    expect(await service.getEntityCard(stranger, priya.id)).toBeNull();
  });

  it('serves entity cards, topic lists and message context', async () => {
    const card = await service.resolveEntityByEmail(userId, 'Priya.Nair@vantage.example');
    expect(card.entity).toMatchObject({ kind: 'person', display_name: 'Priya Nair', org: { display_name: 'Vantage' } });
    expect(card.stats).toMatchObject({ messages: 16, you_sent: 1, they_sent: 15 });
    expect(card.stats.accounts.map((a) => a.name)).toEqual(['Outlook · work']);
    expect(card.recent.length).toBeGreaterThan(0);
    const topics = await service.listTopics(userId, { limit: 50 });
    expect(topics.some((t) => /visa sponsorship/i.test(t.label))).toBe(true);
    const msg = await one("SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND m.message_id = '<visa-6@hedwig.test>'");
    const ctx = await service.getMessageContext(userId, msg.id);
    expect(ctx.sender.entity.primary_email).toBe('priya.nair@vantage.example');
    expect(ctx.topic).toBeTruthy();
    expect(ctx.related.every((m) => m.thread_key !== '<visa-root@hedwig.test>')).toBe(true);
  });
});
