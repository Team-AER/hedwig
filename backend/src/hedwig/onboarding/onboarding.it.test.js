// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/onboarding
// Stream I on the demo user, through the real routers (mountHedwig): the coverage and seeding hooks a
// new account relies on, "Sort the past", the memory profile (rebuild on the mock gateway, a user
// edit that pins a line, a second rebuild that keeps it), the routing table and model bounds, and the
// household summary. Everything it changes is put back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mockGateway } from '../testing/mockGateway.js';

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';

describe.skipIf(!process.env.HEDWIG_IT)('stream I on the seeded demo user', () => {
  const gw = mockGateway();
  let query; let pool; let invalidateConfigCache; let getState; let refreshCoverage; let profileService; let profileLines;
  let userId; let accountIds; let server; let base;
  let savedSystem = null; let savedUser = null;
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    process.env.HEDWIG_LLM_MODELS_FAST = GEMMA;
    process.env.HEDWIG_LLM_MODELS_LONG = QWEN;
    process.env.HEDWIG_LLM_FALLBACK_MODEL = '';
    gw.install();
    // Echo each fact back as a line citing it (numbers allowed), plus one line with an invented count.
    gw.on('profile.rebuild', (req) => {
      const facts = [...req.messages[1].content.matchAll(/^- (f\d+) \[(\w+)\]: (.+)$/gm)].map((m) => ({ id: m[1], kind: m[2], text: m[3] }));
      return {
        lines: [
          ...facts.map((f) => ({ kind: f.kind, text: f.text, evidence: [f.id] })),
          { kind: 'people', text: 'You replied to 4242 people last week.', evidence: facts.slice(0, 1).map((f) => f.id) },
        ],
      };
    });

    ({ query, pool } = await import('../../services/db.js'));
    ({ invalidateConfigCache } = await import('../config.js'));
    ({ getState } = await import('../state.js'));
    ({ refreshCoverage } = await import('../indexer/coverage.js'));
    profileService = await import('../profile/service.js');
    ({ profileLines } = await import('../profile/lines.js'));
    const { mountHedwig } = await import('../index.js');

    const { rows: u } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u[0].id;
    accountIds = (await query('SELECT id FROM email_accounts WHERE user_id = $1 ORDER BY created_at', [userId])).rows.map((r) => r.id);
    savedSystem = (await query("SELECT value FROM system_settings WHERE key = 'hedwig_config'")).rows[0]?.value ?? null;
    savedUser = (await query('SELECT settings FROM hedwig_user_settings WHERE user_id = $1', [userId])).rows[0]?.settings ?? null;
    await query('DELETE FROM hedwig_profile WHERE user_id = $1', [userId]);
    invalidateConfigCache();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId }; next(); });
    mountHedwig(app);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
  }, 60_000);

  afterAll(async () => {
    gw.restore();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!userId) return;
    await query('DELETE FROM hedwig_profile WHERE user_id = $1', [userId]);
    await query("DELETE FROM hedwig_jobs WHERE kind = 'profile.rebuild' AND user_id = $1", [userId]);
    await query('DELETE FROM hedwig_index_coverage WHERE account_id = ANY($1::uuid[])', [accountIds]);
    if (savedSystem === null) await query("DELETE FROM system_settings WHERE key = 'hedwig_config'");
    else await query("UPDATE system_settings SET value = $1 WHERE key = 'hedwig_config'", [JSON.stringify(savedSystem)]);
    if (savedUser === null) await query('DELETE FROM hedwig_user_settings WHERE user_id = $1', [userId]);
    else await query('UPDATE hedwig_user_settings SET settings = $2 WHERE user_id = $1', [userId, JSON.stringify(savedUser)]);
    invalidateConfigCache();
    await pool.end();
  }, 60_000);

  it('a new account gets coverage rows (A) and seeded sender decisions (C), and Sort the past reads them', async () => {
    await refreshCoverage({ accountIds });
    const { rows: cov } = await query('SELECT account_id, COUNT(*)::int AS n FROM hedwig_index_coverage WHERE account_id = ANY($1::uuid[]) GROUP BY 1', [accountIds]);
    expect(cov.length).toBe(accountIds.length);
    for (const id of accountIds) expect(await getState(`sort.seeded:${id}`, null)).toMatchObject({ at: expect.any(String) });

    const { status, body } = await api('GET', '/onboarding/status');
    expect(status).toBe(200);
    expect(body.accounts.map((a) => a.accountId).sort()).toEqual([...accountIds].sort());
    const { rows: sorted } = await query('SELECT account_id, COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 GROUP BY 1', [userId]);
    for (const r of sorted) expect(body.accounts.find((a) => a.accountId === r.account_id).sorted).toBe(r.n);
    for (const a of body.accounts) expect(a.total).toBeGreaterThan(0);
    const { rows: [people] } = await query("SELECT COUNT(*)::int AS n FROM hedwig_sort s JOIN messages m ON m.id = s.message_id WHERE s.user_id = $1 AND s.stream = 'people' AND NOT s.own AND NOT m.is_deleted", [userId]);
    expect(body.summary.people).toBe(people.n);
    const screener = await api('GET', '/sort/screener');
    expect(body.summary.senders).toBe(screener.body.senders.length);
    expect(body.topSenders.map((s) => s.key).sort()).toEqual(screener.body.senders.map((s) => s.key).sort());
    // The demo accounts are disabled (no IMAP in dev), so nothing is "ready" to show as done.
    expect(body.ready).toBe(false);
    expect(body.done).toBe(false);

    expect((await api('POST', '/onboarding/accept', {})).status).toBe(400);
    expect(await api('POST', '/onboarding/dismiss', {})).toEqual({ status: 200, body: { ok: true, done: true } });
    expect((await api('GET', '/onboarding/status')).body.done).toBe(true);
    await api('POST', '/onboarding/dismiss', { done: false });
  });

  it('rebuilds the profile from demo behaviour, keeps a pinned edit through the next rebuild', async () => {
    expect((await api('GET', '/profile')).body).toMatchObject({ version: 0, text: '', pinned: [] });
    const first = await profileService.rebuildProfile(userId);
    expect(first.status).toBe('done');
    const v1 = (await api('GET', '/profile')).body;
    expect(v1).toMatchObject({ version: 1, source: 'rebuild', pinned: [] });
    expect(v1.text).not.toContain('4242');
    expect(v1.provenance).toMatchObject({ promptId: 'profile.rebuild', model: QWEN, tier: 'reasoning' });
    expect(v1.provenance.droppedLines).toEqual([expect.objectContaining({ text: 'You replied to 4242 people last week.' })]);
    expect(v1.diff).toMatch(/^--- v0\n\+\+\+ v1 \(rebuild\)\n@@ -0,0 \+1,\d+ @@\n/);
    const { rows: [call] } = await query('SELECT feature, prompt_id, tier FROM hedwig_ai_calls WHERE id = $1', [v1.provenance.aiCallId]);
    expect(call).toEqual({ feature: 'profile', prompt_id: 'profile.rebuild', tier: 'reasoning' });

    const mine = 'Anything from my solicitor needs me the same day.';
    const put = await api('PUT', '/profile', { text: `${v1.text}\n${mine}` });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ version: 2, source: 'user', pinned: [mine] });
    expect(put.body.diff).toContain(`+${mine}\n`);

    const queued = await api('POST', '/profile/rebuild');
    expect(queued.status).toBe(202);
    const { rows: [job] } = await query("SELECT payload FROM hedwig_jobs WHERE kind = 'profile.rebuild' AND user_id = $1 AND done_at IS NULL", [userId]);
    expect(job.payload).toMatchObject({ userId, reason: 'manual' });
    // Run the job the worker would run: the pinned line leads the rebuilt version, verbatim.
    expect(await profileService.runRebuildJob(job.payload)).toMatchObject({ status: 'done', note: expect.stringMatching(/^v3: .*\(1 pinned\)/) });
    const latest = (await api('GET', '/profile')).body;
    expect(latest.text.split('\n')[0]).toBe(mine);
    expect(latest.pinned).toEqual([mine]);
    expect(await profileLines(userId)).toEqual(latest.text.split('\n'));
    const history = (await api('GET', '/profile/history')).body.versions;
    expect(history.map((v) => [v.version, v.source])).toEqual([[3, 'rebuild'], [2, 'user'], [1, 'rebuild']]);
  });

  it('routing table, model bounds and household summary for the admin; a read-only table for users', async () => {
    const table = await api('GET', '/admin/routing');
    expect(table.status).toBe(200);
    expect(table.body.features.find((f) => f.feature === 'profile')).toMatchObject({ tier: 'reasoning', budgetKey: 'llm.tokenBudget.profile' });

    const put = await api('PUT', '/admin/routing', { profile: { tier: 'reflex', budget: 150000 }, sort: { escalateBelow: 0.55 } });
    expect(put.status).toBe(200);
    expect(put.body.changed).toEqual(['routing.profile.tier', 'llm.tokenBudget.profile', 'sort.escalateBelow']);
    const mine = await api('GET', '/routing');
    expect(mine.body.readOnly).toBe(true);
    expect(mine.body.features.find((f) => f.feature === 'profile')).toMatchObject({ tier: 'reflex', budget: 150000 });
    expect(mine.body.features.find((f) => f.feature === 'sort').escalateBelow).toBe(0.55);
    expect((await api('PUT', '/admin/routing', { nope: { tier: 'reflex' } })).status).toBe(400);

    // The next rebuild follows the routing change onto the Reflex model.
    await query('DELETE FROM hedwig_profile WHERE user_id = $1', [userId]);
    await profileService.rebuildProfile(userId);
    expect(gw.callsFor('profile.rebuild').at(-1).model).toBe(GEMMA);

    expect((await api('PATCH', '/settings', { 'llm.models.fast': QWEN })).status).toBe(400);
    const enabled = await api('PUT', '/admin/models/enabled', { models: [QWEN] });
    expect(enabled.body.models).toEqual([QWEN]);
    expect((await api('PUT', '/admin/models/enabled', { models: ['not/in-catalog'] })).status).toBe(400);
    expect((await api('PATCH', '/settings', { 'llm.models.fast': QWEN })).status).toBe(200);
    expect((await api('PATCH', '/settings', { 'llm.models.fast': GEMMA })).status).toBe(400);
    expect((await api('GET', '/routing')).body).toMatchObject({ myModels: { fast: QWEN }, modelChoices: [QWEN] });

    const summary = await api('GET', '/admin/users/summary');
    const demo = summary.body.users.find((x) => x.userId === userId);
    const { rows: [n] } = await query('SELECT COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1', [userId]);
    expect(demo).toMatchObject({ username: 'demo', accounts: accountIds.length, sorted: n.n, isAdmin: true });
    expect(demo.tokensToday).toBeGreaterThan(0);
  });
});
