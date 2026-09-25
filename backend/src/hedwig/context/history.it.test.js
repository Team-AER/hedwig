// The analysis catch-up over the seeded demo mailbox (scripts/hedwig-seed.mjs) in the dev DB: mail
// the scanner saw long ago gets the context steps once it is inside the user's analysis window.
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/context/history.it.test.js
// No model calls are made; extraction only enqueues jobs, which are removed afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('analysis catch-up over the demo mailbox', () => {
  let query;
  let pool;
  let userId;
  let ids;
  let config;
  let analysisCatchUp;

  const setWindow = async (days) => {
    await config.saveUserConfig(userId, { 'analysis.historyDays': days });
  };
  const counts = async (days) => (await query(
    `SELECT COUNT(*) FILTER (WHERE m.date >= NOW() - make_interval(days => $2::int))::int AS inside,
            COUNT(h.topic_at) FILTER (WHERE m.date >= NOW() - make_interval(days => $2::int))::int AS inside_done,
            COUNT(*) FILTER (WHERE m.date < NOW() - make_interval(days => $2::int))::int AS outside,
            COUNT(h.topic_at) FILTER (WHERE m.date < NOW() - make_interval(days => $2::int))::int AS outside_done
       FROM hedwig_msg h JOIN messages m ON m.id = h.message_id
      WHERE h.user_id = $1 AND h.skip_reason IS NULL AND NOT m.is_deleted`,
    [userId, days],
  )).rows[0];

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    config = await import('../config.js');
    ({ analysisCatchUp } = await import('./history.js'));
    const u = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u.rows[0].id;
    // As the scanner leaves history older than pipeline.backfillDays: seen an hour ago, cheap steps only.
    const { rows } = await query(
      `SELECT m.id, m.account_id FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND NOT m.is_deleted`,
      [userId],
    );
    ids = rows.map((r) => r.id);
    await query('DELETE FROM hedwig_msg WHERE user_id = $1', [userId]);
    await query(
      `INSERT INTO hedwig_msg (message_id, user_id, account_id, seen_at)
       SELECT x.id, $1, x.account_id, NOW() - INTERVAL '1 hour' FROM UNNEST($2::uuid[], $3::uuid[]) AS x(id, account_id)`,
      [userId, ids, rows.map((r) => r.account_id)],
    );
    // The demo accounts are disabled so the worker skips them; the catch-up only visits enabled ones.
    await query('UPDATE email_accounts SET enabled = true WHERE user_id = $1', [userId]);
  }, 60_000);

  afterAll(async () => {
    if (userId) {
      await config.saveUserConfig(userId, { 'analysis.historyDays': null });
      await query('UPDATE email_accounts SET enabled = false WHERE user_id = $1', [userId]);
      await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind LIKE 'context.%' AND done_at IS NULL", [userId]);
      await query("DELETE FROM hedwig_jobs WHERE kind = 'mail.fetchBody' AND done_at IS NULL AND payload->>'messageId' = ANY($1::text[])", [ids || []]);
    }
    await pool?.end();
  });

  it('analyzes only mail inside a narrowed window', async () => {
    await setWindow(60);
    await analysisCatchUp({ limit: 500 });
    const c = await counts(60);
    expect(c.inside).toBeGreaterThan(0);
    expect(c.outside).toBeGreaterThan(0);
    expect(c).toMatchObject({ inside_done: c.inside, outside_done: 0 });
  }, 60_000);

  it('widening to all mail brings in the rest, then has nothing left to do', async () => {
    await setWindow(0);
    await analysisCatchUp({ limit: 500 });
    const c = await counts(60);
    expect(c).toMatchObject({ inside_done: c.inside, outside_done: c.outside });
    expect(await analysisCatchUp({ limit: 500 })).toBe(0);
    const { rows: [e] } = await query('SELECT COUNT(*)::int AS n FROM hedwig_msg WHERE user_id = $1 AND embedded_at IS NULL AND skip_reason IS NULL', [userId]);
    expect(e.n).toBe(0);
  }, 60_000);
});
