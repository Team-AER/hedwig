// Integration: insights and the agent's read tools against the seeded dev database.
//   cd backend && set -a && . ./.env.hedwig-dev && set +a && node scripts/hedwig-seed.mjs
//   HEDWIG_IT=1 npx vitest run src/hedwig/insights src/hedwig/agent
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('insights and agent tools against the dev database', () => {
  let query;
  let pool;
  let userId;

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    const { rows } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('computes the overview for the seeded mailbox', async () => {
    const { overview } = await import('./service.js');
    const o = await overview(userId, { days: 30 });
    expect(o.volume).toHaveLength(30);
    const received = o.volume.reduce((n, d) => n + d.received, 0);
    const sent = o.volume.reduce((n, d) => n + d.sent, 0);
    expect(received).toBeGreaterThan(20);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(o.byAccount.map((a) => a.account.name).sort()).toEqual(['Gmail · personal', 'Outlook · work', 'prafiles.in']);
    expect(o.byAccount.reduce((n, a) => n + a.received, 0)).toBe(received);
    expect(o.topSenders[0]).toMatchObject({ email: expect.any(String), count: expect.any(Number) });
    // The seeded visa thread: Priya wrote 21 days ago, the reply went out 15 days ago.
    expect(o.responseTime.median_hours).toBeCloseTo(144, 0);
    expect(o.ai).toMatchObject({ calls: expect.any(Number) });
  });

  it('never counts another user\'s mail', async () => {
    const { overview } = await import('./service.js');
    const o = await overview('00000000-0000-4000-8000-000000000000', { days: 30 });
    expect(o.volume.every((d) => d.received === 0 && d.sent === 0)).toBe(true);
    expect(o.byAccount).toEqual([]);
    expect(o.topSenders).toEqual([]);
  });

  it('generates cards idempotently within a day', async () => {
    const { generateCards } = await import('./service.js');
    const first = await generateCards(userId);
    const second = await generateCards(userId);
    expect(second.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    const owe = first.find((c) => c.data.key === 'owe_replies');
    expect(owe?.sources.length).toBeGreaterThan(0);
  });

  it('writes a deterministic briefing citing real messages', async () => {
    const { composeBriefing } = await import('./briefing.js');
    const composed = await composeBriefing(userId, { useModel: false });
    expect(composed.data.generated_by).toBe('deterministic');
    expect(composed.body).toMatch(/### Needs you/);
    expect(composed.sources.length).toBeGreaterThan(0);
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND m.id = ANY($2::uuid[])',
      [userId, composed.sources],
    );
    expect(rows[0].n).toBe(composed.sources.length);

    const weekly = await composeBriefing(userId, { period: 'week', useModel: false });
    expect(weekly.body).toMatch(/this week/);
  });

  it('agent read tools stay inside the user\'s mail', async () => {
    const { readTools } = await import('../agent/tools/read.js');
    const { fallbackTools } = await import('../agent/tools/fallbacks.js');
    const tool = (name) => [...readTools, ...fallbackTools].find((t) => t.name === name);
    const accounts = await tool('list_accounts').handler({}, { userId });
    expect(accounts).toHaveLength(3);

    const { rows } = await query(
      `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE a.user_id = $1 AND m.subject = 'Invoice 2041'`,
      [userId],
    );
    const msg = await tool('read_message').handler({ messageId: rows[0].id }, { userId });
    expect(msg).toMatchObject({ subject: 'Invoice 2041', from: expect.stringContaining('marta@kowalski-design.example') });
    expect(msg.text).toContain('€1,840');
    const thread = await tool('get_thread').handler({ messageId: rows[0].id }, { userId });
    expect(thread.messages.map((m) => m.from_user)).toEqual([false, true, false]);

    await expect(tool('read_message').handler({ messageId: rows[0].id }, { userId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toThrow('message not found');

    const found = await tool('search_mail').handler({ q: 'invoice', limit: 5 }, { userId });
    expect(found.results.some((r) => r.id === rows[0].id)).toBe(true);
  });
});
