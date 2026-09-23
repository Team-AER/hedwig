import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import express from 'express';
import { mockGateway } from '../testing/mockGateway.js';

// ── Fake database: settings (real config.js on top), onboarding counts, users ─────────────────────
const USER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const ACC1 = '22222222-2222-4222-8222-222222222222';
const ACC2 = '44444444-4444-4444-8444-444444444444';
const db = {};
function resetDb() {
  Object.assign(db, {
    calls: [], system: {}, users: new Map(), admins: new Set([ADMIN]),
    accounts: [], sorted: [], summary: {}, summaryRows: [],
  });
}
resetDb();

async function fakeQuery(sql, params = []) {
  db.calls.push({ sql, params });
  if (/SELECT value FROM system_settings WHERE key = 'hedwig_config'/.test(sql)) return { rows: [{ value: db.system }] };
  if (/INSERT INTO system_settings/.test(sql)) { db.system = JSON.parse(params[0]); return { rows: [] }; }
  if (/SELECT settings FROM hedwig_user_settings/.test(sql)) return { rows: db.users.has(params[0]) ? [{ settings: db.users.get(params[0]) }] : [] };
  if (/INSERT INTO hedwig_user_settings/.test(sql)) { db.users.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
  if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: params[0] }] };
  if (/SELECT is_admin FROM users/.test(sql)) return { rows: [{ is_admin: db.admins.has(params[0]) }] };
  if (/FROM email_accounts a LEFT JOIN hedwig_index_coverage/.test(sql)) return { rows: db.accounts };
  if (/SELECT account_id, COUNT\(\*\)::int AS n FROM hedwig_sort/.test(sql)) return { rows: db.sorted };
  if (/AS rescue_candidates/.test(sql)) return { rows: [db.summary] };
  if (/FROM users u ORDER BY u\.username/.test(sql)) return { rows: db.summaryRows };
  if (/FROM hedwig_ai_calls WHERE user_id = \$1 AND created_at/.test(sql)) return { rows: [{ feature: 'sort', tokens: '1234' }] };
  return { rows: [], rowCount: 0 };
}

vi.mock('../../services/db.js', () => ({ pool: {}, query: vi.fn((sql, params) => fakeQuery(sql, params)) }));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
const screener = { senders: [] };
vi.mock('../sort/senders.js', () => ({ screenerList: vi.fn(async () => screener) }));
vi.mock('../sort/service.js', () => ({ decide: vi.fn(async (userId, body) => (body.all ? { decided: 3, moved: 7, logIds: [1, 2, 3] } : { decided: 1, moved: 2, logId: 9 })) }));

const gw = mockGateway();
const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const envBefore = { ...process.env };
process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;

const config = await import('../config.js');
const status = await import('./status.js');
const routing = await import('./routing.js');
const { decide } = await import('../sort/service.js');
const onboarding = (await import('./index.js')).default;
const profileModule = (await import('../profile/index.js')).default;
const { requireAuth, requireAdmin } = await import('../../middleware/auth.js');
const { listPrompts } = await import('../prompts/index.js');

beforeEach(() => {
  resetDb();
  config.invalidateConfigCache();
  screener.senders = [];
  gw.reset().install();
  vi.mocked(decide).mockClear();
});
afterAll(() => {
  gw.restore();
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  Object.assign(process.env, envBefore);
});

const sender = (key, count, over = {}) => ({ key, scope: 'address', display: key.split('@')[0], address: key, count, proposed: 'reading', reason: 'A newsletter', confidence: 0.7, inSpam: false, ...over });

describe('onboarding status', () => {
  it('assembles accounts, summary, top senders and readiness', () => {
    const out = status.assembleStatus({
      accounts: [
        { account_id: ACC1, name: 'Personal', email_address: 'me@x.example', indexed: 950, total: 1000, bodies: 400, folders: 3 },
        { account_id: ACC2, name: null, email_address: 'work@x.example', indexed: 100, total: 1000, bodies: 0, folders: 2 },
      ],
      sorted: new Map([[ACC1, 900], [ACC2, 10]]),
      summary: { sorted: 852, people_senders: 11, reading_senders: 30, records_senders: 25, people: 40, reading: 300, records: 500, spam: 12, rescue_candidates: 2 },
      senders: [sender('a@x.example', 3), sender('b@x.example', 9, { inSpam: true, proposed: 'records' }), sender('c@x.example', 9), sender('d@x.example', 1)],
      readyShare: 0.9,
      topSenders: 3,
    });
    expect(out.accounts).toEqual([
      { accountId: ACC1, name: 'Personal', email: 'me@x.example', enabled: true, indexed: 950, total: 1000, sorted: 900, bodies: 400, bodyShare: null, bodyReasons: null, done: true },
      { accountId: ACC2, name: 'work@x.example', email: 'work@x.example', enabled: true, indexed: 100, total: 1000, sorted: 10, bodies: 0, bodyShare: null, bodyReasons: null, done: false },
    ]);
    expect(out.summary).toEqual({
      sorted: 852, peopleSenders: 11, readingSenders: 30, recordsSenders: 25, people: 40, reading: 300, records: 500, spam: 12, rescueCandidates: 2, senders: 4,
    });
    expect(out.bodies).toBeNull();
    // With the index's real-body numbers, each account reports those, not the ledger's fetched count.
    const withBodies = status.assembleStatus({
      accounts: [{ account_id: ACC1, indexed: 10, total: 10, bodies: 10, folders: 1 }], sorted: { [ACC1]: 10 }, summary: {}, senders: [],
      bodies: { real: 8, indexable: 10, share: 0.8, reasons: { no_text: 2 }, byAccount: [{ accountId: ACC1, real: 8, indexable: 10, share: 0.8, reasons: { no_text: 2 } }] },
    });
    expect(withBodies.accounts[0]).toMatchObject({ bodies: 8, bodyShare: 0.8, bodyReasons: { no_text: 2 } });
    expect(withBodies.bodies).toEqual({ real: 8, indexable: 10, share: 0.8, reasons: { no_text: 2 } });
    expect(out.topSenders.map((s) => [s.key, s.count, s.proposed, s.inSpam])).toEqual([
      ['b@x.example', 9, 'records', true], ['c@x.example', 9, 'reading', false], ['a@x.example', 3, 'reading', false],
    ]);
    expect(out.ready).toBe(false);
    // An account whose coverage rows do not exist yet is never done.
    expect(status.assembleStatus({ accounts: [{ account_id: ACC1, indexed: 0, total: 0, folders: 0 }], sorted: {}, summary: {}, senders: [] }).ready).toBe(false);
    expect(status.assembleStatus({ accounts: [{ account_id: ACC1, indexed: 10, total: 10, folders: 1 }], sorted: { [ACC1]: 10 }, summary: {}, senders: [] }).ready).toBe(true);
    // A disabled account is listed, never done, and does not hold the others back; alone it is not ready.
    const withDisabled = status.assembleStatus({ accounts: [{ account_id: ACC1, indexed: 10, total: 10, folders: 1 }, { account_id: ACC2, enabled: false, indexed: 0, total: 50, folders: 1 }], sorted: { [ACC1]: 10 }, summary: {}, senders: [] });
    expect([withDisabled.ready, withDisabled.accounts[1].done]).toEqual([true, false]);
    expect(status.assembleStatus({ accounts: [{ account_id: ACC2, enabled: false, indexed: 5, total: 5, folders: 1 }], sorted: { [ACC2]: 5 }, summary: {}, senders: [] }).ready).toBe(false);
  });

  it('reads the queries and the Screener for GET /onboarding/status, accepts proposals and dismisses', async () => {
    db.accounts = [{ account_id: ACC1, name: 'Personal', email_address: 'me@x.example', indexed: 10, total: 10, bodies: 10, folders: 1 }];
    db.sorted = [{ account_id: ACC1, n: 10 }];
    db.summary = { people: 4, reading: 3, records: 2, spam: 1, rescue_candidates: 1 };
    screener.senders = [sender('news@x.example', 5)];
    const out = await status.onboardingStatus(USER);
    expect(out).toMatchObject({ ready: true, done: false, summary: { people: 4, rescueCandidates: 1, senders: 1 }, topSenders: [{ key: 'news@x.example', count: 5, proposed: 'reading' }] });
    expect(db.calls.find((c) => /hedwig_index_coverage/.test(c.sql)).params).toEqual([USER]);

    expect(await status.acceptProposals(USER, { all: true })).toEqual({ decided: 3, moved: 7, logIds: [1, 2, 3] });
    expect(decide).toHaveBeenCalledWith(USER, { all: true });
    expect(await status.acceptProposals(USER, { senders: [{ key: 'news@x.example', scope: 'address', decision: 'reading' }] })).toEqual({ decided: 1, moved: 2, logIds: [9] });
    await expect(status.acceptProposals(USER, {})).rejects.toMatchObject({ status: 400 });

    expect(await status.dismissOnboarding(USER)).toEqual({ ok: true, done: true });
    expect(db.users.get(USER)).toEqual({ 'onboarding.done': true });
    config.invalidateConfigCache();
    expect((await status.onboardingStatus(USER)).done).toBe(true);
    await status.dismissOnboarding(USER, { done: false });
    expect(db.users.get(USER)).toEqual({});
  });
});

describe('routing table', () => {
  const cfg = () => config.getConfig(null);

  it('lists every prompt feature with tier, escalation, cadence and budget', async () => {
    const table = routing.buildRoutingTable(await listPrompts(), await cfg());
    const f = Object.fromEntries(table.features.map((x) => [x.feature, x]));
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['ask', 'cards', 'labels', 'profile', 'sort', 'work']));
    expect(f.spam).toBeUndefined(); // spam.reflex is charged to sort
    expect(f.sort).toMatchObject({
      tier: 'reflex', override: 'auto', defaultTier: 'reflex', tierKey: 'routing.sort.tier', escalateBelow: 0.6, escalateKey: 'sort.escalateBelow',
      budget: 2000000, budgetKey: 'llm.tokenBudget.sort', cadence: 'Each new message; history 200 messages a minute',
    });
    expect(f.sort.prompts.map((p) => p.id)).toEqual(expect.arrayContaining(['sort.reflex', 'sort.screener', 'spam.reflex']));
    expect(f.sort.escalate.map((e) => e.key)).toEqual(['sort.escalateBelow', 'spam.phishingEscalateBelow']);
    expect(f.ask).toMatchObject({ defaultTier: 'mixed', tier: 'mixed', escalateKey: null, budgetKey: 'llm.tokenBudget.ask' });
    expect(f.profile).toMatchObject({ tier: 'reasoning', budget: 200000, cadence: 'Weekly, Sunday at 4:00' });
    expect(table.models).toEqual({ reflex: GEMMA, reasoning: QWEN });
  });

  it('maps PUT bodies onto config keys and rejects what it cannot map', async () => {
    const table = routing.buildRoutingTable(await listPrompts(), await cfg());
    expect(routing.routingPatch({ sort: { tier: 'reasoning', escalateBelow: 0.5, budget: 1234.4 }, profile: { tier: null, budget: null } }, table)).toEqual({
      'routing.sort.tier': 'reasoning', 'sort.escalateBelow': 0.5, 'llm.tokenBudget.sort': 1234, 'routing.profile.tier': null, 'llm.tokenBudget.profile': null,
    });
    expect(() => routing.routingPatch({ nope: { tier: 'reflex' } }, table)).toThrow(/unknown feature nope/);
    expect(() => routing.routingPatch({ ask: { escalateBelow: 0.4 } }, table)).toThrow(/ask has no escalation rule/);
    expect(() => routing.routingPatch({ sort: { tier: 'fast' } }, table)).toThrow(/tier must be auto, reflex or reasoning/);
    expect(() => routing.routingPatch({ sort: { escalateBelow: 2 } }, table)).toThrow(/between 0 and 1/);
    expect(() => routing.routingPatch({ sort: { model: 'x' } }, table)).toThrow(/unknown field model/);

    const out = await routing.updateRouting({ labels: { tier: 'reflex', budget: 5000 } });
    expect(db.system).toEqual({ 'routing.labels.tier': 'reflex', 'llm.tokenBudget.labels': 5000 });
    expect(out.changed).toEqual(['routing.labels.tier', 'llm.tokenBudget.labels']);
    const labels = out.features.find((x) => x.feature === 'labels');
    expect(labels).toMatchObject({ override: 'reflex', tier: 'reflex', budget: 5000 });
    expect(labels.prompts.every((p) => p.effectiveTier === 'reflex')).toBe(true);

    // Non-admin copy: read-only, with the user's spend today.
    const mine = await routing.routingTable({ userId: USER });
    expect(mine.readOnly).toBe(true);
    expect(mine.features.find((x) => x.feature === 'sort').usedToday).toBe(1234);
  });
});

describe('model bounds', () => {
  it('lets users pick role models only from the admin-enabled subset of the catalog', async () => {
    await expect(config.saveUserConfig(USER, { 'llm.models.fast': QWEN })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not one of the models enabled/) });
    await expect(config.saveUserConfig(USER, { 'llm.baseUrl': 'http://evil.example' })).rejects.toMatchObject({ status: 400 });

    await expect(routing.setEnabledModels({ models: [QWEN, 'made/up-model'] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/made\/up-model/) });
    const enabled = await routing.setEnabledModels({ models: [QWEN, QWEN] });
    expect(enabled.models).toEqual([QWEN]);
    expect(enabled.catalog.map((m) => m.id)).toEqual([GEMMA, QWEN]); // bge-m3 is embeddings only
    expect(enabled.defaults.fast).toBe(GEMMA);

    await config.saveUserConfig(USER, { 'llm.models.fast': QWEN });
    expect((await config.getConfig(USER))['llm.models.fast']).toBe(QWEN);
    expect((await config.getConfig(null))['llm.models.fast']).toBe(GEMMA);
    expect((await config.describeConfig(USER)).find((f) => f.key === 'llm.models.fast')).toMatchObject({ value: QWEN, source: 'user' });

    // The admin takes the model away: the override stops applying.
    await routing.setEnabledModels({ models: [] });
    expect((await config.getConfig(USER))['llm.models.fast']).toBe(GEMMA);
    expect(config.resolveField(config.SCHEMA.find((f) => f.key === 'llm.models.long'), { user: { 'llm.models.long': 'x' }, system: { 'llm.models.enabled': ['x'] }, env: {} })).toBe('x');
    expect(config.resolveField(config.SCHEMA.find((f) => f.key === 'llm.models.long'), { user: { 'llm.models.long': 'x' }, system: {}, env: {} })).toBe(QWEN);
  });
});

describe('household', () => {
  it('summarises users with counts only', async () => {
    db.summaryRows = [{ id: USER, username: 'demo', display_name: 'Demo', is_admin: false, accounts: 2, indexed: '450', total: '600', sorted: '400', questions_answered: 3, tokens_today: '9000' }];
    expect(await routing.usersSummary()).toEqual({ users: [{ userId: USER, username: 'demo', displayName: 'Demo', isAdmin: false, accounts: 2, indexed: 450, total: 600, indexedPct: 75, sorted: 400, questionsAnswered: 3, tokensToday: 9000 }] });
    const sql = db.calls.find((c) => /FROM users u/.test(c.sql)).sql;
    expect(sql).not.toMatch(/subject|body_text|snippet|from_email/);
  });

  describe('routes behind requireAuth/requireAdmin, as mountHedwig mounts them', () => {
    let server; let base; let as = USER;
    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.session = { userId: as }; next(); });
      const user = express.Router(); user.use(requireAuth);
      const adm = express.Router(); adm.use(requireAuth, requireAdmin);
      for (const m of [profileModule, onboarding]) { m.routes(user); m.adminRoutes?.(adm); }
      app.use('/api/hedwig/admin', adm);
      app.use('/api/hedwig', user);
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
    });
    afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

    it('rejects non-admins on /admin/* and serves the read-only table to them', async () => {
      gw.restore(); // real fetch for the local server
      try {
        as = USER;
        for (const [method, path] of [['GET', '/admin/routing'], ['PUT', '/admin/routing'], ['GET', '/admin/models/enabled'], ['PUT', '/admin/models/enabled'], ['GET', '/admin/users/summary']]) {
          const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' ? '{}' : undefined });
          expect([path, res.status]).toEqual([path, 403]);
        }
        const mine = await fetch(`${base}/routing`);
        expect(mine.status).toBe(200);
        expect((await mine.json()).readOnly).toBe(true);
        as = ADMIN;
        const res = await fetch(`${base}/admin/routing`);
        expect(res.status).toBe(200);
        expect((await res.json()).features.length).toBeGreaterThan(4);
      } finally {
        gw.install();
      }
    });
  });
});
