// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/profile
// Reads the demo user's profile evidence. It writes nothing and never calls the model gateway.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('profile evidence on the seeded demo mailbox', () => {
  let query; let pool; let userId;

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    const { rows } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('learns how the user writes from sent mail, not from saved drafts', async () => {
    const { getConfig } = await import('../config.js');
    const { gatherEvidence } = await import('./evidence.js');
    const ev = await gatherEvidence(userId, await getConfig(userId));
    expect(ev.counts.sent).toBeGreaterThan(0);
    // The seed saves a half-written reply to the clinic and an unfinished note about the cabin.
    const { rows: drafts } = await query(
      `SELECT m.body_text FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND f.special_use = '\\Drafts' AND NOT m.is_deleted AND m.date > NOW() - make_interval(days => $2)`,
      [userId, ev.days],
    );
    expect(drafts.length).toBeGreaterThan(0);
    const openings = ev.excerpts.map((e) => e.slice(0, 40));
    for (const d of drafts) expect(openings).not.toContain(d.body_text.slice(0, 40));
  });
});
