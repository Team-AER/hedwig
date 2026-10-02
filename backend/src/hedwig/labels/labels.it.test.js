// Integration: behaviour labels, questions, the eval harness and the Brief against the seeded dev
// database. No model calls: the judge is covered by the unit tests with the mock gateway.
//   cd backend && set -a && . ./.env.hedwig-dev && set +a && node scripts/hedwig-migrate.mjs && node scripts/hedwig-seed.mjs
//   HEDWIG_IT=1 npx vitest run src/hedwig/labels
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('labels against the dev database', () => {
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

  it('derives behaviour labels from the seeded mailbox, idempotently', async () => {
    const { behaviourForUser } = await import('./behaviour.js');
    const { getConfig } = await import('../config.js');
    const { userAddresses } = await import('../pipeline.js');
    const cfg = { ...(await getConfig(userId)), 'labels.windowDays': 3650 };
    const addrs = (await userAddresses([userId])).get(userId);
    const first = await behaviourForUser(userId, addrs, cfg);
    const { rows: [{ n: afterFirst }] } = await query("SELECT COUNT(*)::int AS n FROM hedwig_labels WHERE user_id = $1 AND source = 'behaviour'", [userId]);
    const second = await behaviourForUser(userId, addrs, cfg);
    const { rows: [{ n: afterSecond }] } = await query("SELECT COUNT(*)::int AS n FROM hedwig_labels WHERE user_id = $1 AND source = 'behaviour'", [userId]);
    expect(second).toBe(first);
    expect(afterSecond).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it('takes neither a reply nor a recipient from a saved draft', async () => {
    // The seed keeps an unsent reply to the clinic in Drafts; the user never wrote to them.
    const { behaviourForUser } = await import('./behaviour.js');
    const { getConfig } = await import('../config.js');
    const { userAddresses } = await import('../pipeline.js');
    await behaviourForUser(userId, (await userAddresses([userId])).get(userId), { ...(await getConfig(userId)), 'labels.windowDays': 3650 });
    const { rows } = await query(
      `SELECT l.evidence->>'rule' AS rule FROM hedwig_labels l JOIN messages m ON l.target_id = m.id::text
        WHERE l.user_id = $1 AND l.source = 'behaviour' AND m.thread_key = '<doc-root@hedwig.test>'`,
      [userId],
    );
    expect(rows.map((r) => r.rule)).not.toContain('reply');
    expect(rows.map((r) => r.rule)).not.toContain('sent_to');
  });

  it('computes question evidence from real counts', async () => {
    const { gatherEvidence, templateQuestion } = await import('./questions.js');
    const { rows: [m] } = await query(
      `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1 WHERE m.from_email IS NOT NULL ORDER BY m.date DESC LIMIT 1`,
      [userId],
    );
    const ev = await gatherEvidence(userId, m.id);
    expect(ev.senderCount).toBeGreaterThanOrEqual(1);
    expect(templateQuestion('needs_you', ev)).toMatch(/\?$/);
  });

  it('scores suites without recording and serves the Brief', async () => {
    const { runSuite } = await import('./eval.js');
    for (const suite of ['sort', 'needs_you', 'spam', 'rescue', 'retrieval']) {
      const r = await runSuite(suite, { userId });
      expect(r).toHaveProperty('silver');
      expect(r).toHaveProperty('gold');
    }
    const { compileBrief } = await import('../insights/briefing.js');
    const brief = await compileBrief(userId);
    expect(typeof brief.headline).toBe('string');
    for (const k of ['needsYou', 'waitingOn', 'cards', 'reading', 'questions']) expect(Array.isArray(brief[k])).toBe(true);
    expect(Object.keys(brief.today).sort()).toEqual(['blocked', 'bundled', 'entries', 'rescued', 'screened', 'undoable']);
  });
});
