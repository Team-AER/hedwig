// Tier 2 degraded handling across the jobs that must not quietly run on the lighter model: the
// nightly judge, the profile rebuild and the briefing prose. reasoningTier() is mocked here; its own
// logic is covered by the pure tests at the bottom.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ routes: [], calls: [] }));
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ');
    db.calls.push(text);
    for (const [re, fn] of db.routes) if (re.test(text)) return fn(params, text);
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const tier = vi.hoisted(() => ({ state: { degraded: false, model: 'Qwen/Qwen3.8-Flash-Next', reason: null } }));
vi.mock('./tier.js', async (orig) => ({ ...(await orig()), reasoningTier: vi.fn(async () => tier.state) }));

const judge = vi.hoisted(() => ({ calls: [], result: null }));
vi.mock('./judge.js', () => ({
  judgeForUser: vi.fn(async (userId, opts) => { judge.calls.push(opts); return judge.result(opts); }),
}));
const ask = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./askTriples.js', () => ({
  askTriplesForUser: vi.fn(async () => { ask.calls++; return { answerable: 2, unanswerable: 1, rejected: 0, partial: false }; }),
  answerFeedback: vi.fn(),
}));

const cfg = vi.hoisted(() => ({
  enabled: true, 'llm.baseUrl': 'http://mock.invalid/v1', 'llm.models.long': 'Qwen/Qwen3.8-Flash-Next', 'llm.models.fast': 'gemma',
  'labels.judgeDeferHours': 18, 'labels.judgeSample': 100, 'profile.enabled': true, 'profile.deferHours': 24, 'profile.maxLines': 40,
  'profile.windowDays': 90, 'profile.fallbackDays': 365, 'profile.minCount': 2, 'profile.sentSamples': 0, 'profile.corrections': 0,
  'insights.timezone': 'UTC', 'insights.briefProseTier2Only': true, 'context.extractMinConfidence': 0.6, 'triage.waitingOnDays': 3,
  'context.freemailDomains': [],
}));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg })), saveUserConfig: vi.fn() }));
const llm = vi.hoisted(() => ({ chat: vi.fn(), calls: 0 }));
vi.mock('../llm.js', async (orig) => ({ ...(await orig()), chat: (...a) => { llm.calls++; return llm.chat(...a); } }));

const { runNightly } = await import('./index.js');
const { runRebuildJob } = await import('../profile/service.js');
const { composeBriefing } = await import('../insights/briefing.js');
const tierMod = await import('./tier.js');

const USER = '11111111-1111-4111-8111-111111111111';
const fresh = () => ({ created_at: new Date().toISOString() });
const old = () => ({ created_at: new Date(Date.now() - 30 * 3600_000).toISOString() });

beforeEach(() => {
  db.routes = [];
  db.calls.length = 0;
  judge.calls.length = 0;
  ask.calls = 0;
  llm.calls = 0;
  tier.state = { degraded: false, model: 'Qwen/Qwen3.8-Flash-Next', reason: null };
  judge.result = (opts) => ({ sampled: 10, judged: 10, silver: 6, proposed: 1, partial: false, mode: opts.mode, tier2Lost: false });
});

describe('nightly judge while Tier 2 is degraded', () => {
  it('healthy: dual judge, then Ask triples', async () => {
    const out = await runNightly({ userId: USER, day: '2026-09-24' }, fresh());
    expect(judge.calls[0].mode).toBe('dual');
    expect(ask.calls).toBe(1);
    expect(out.status).toBe('done');
  });

  it('degraded and still within labels.judgeDeferHours: deferred, nothing judged, no attempt spent', async () => {
    tier.state = { degraded: true, model: 'Qwen/Qwen3.8-Flash-Next', reason: 'no response within 45000 ms' };
    await expect(runNightly({ userId: USER, day: '2026-09-24' }, fresh())).rejects.toMatchObject({ code: 'job_deferred' });
    expect(judge.calls).toHaveLength(0);
    expect(ask.calls).toBe(0);
  });

  it('degraded past the wait: single-judge run on Tier 1, Ask triples skipped, marked partial', async () => {
    tier.state = { degraded: true, model: 'Qwen/Qwen3.8-Flash-Next', reason: 'timeout' };
    const out = await runNightly({ userId: USER, day: '2026-09-24' }, old());
    expect(judge.calls[0].mode).toBe('single');
    expect(ask.calls).toBe(0);
    expect(out.status).toBe('partial');
    expect(out.note).toMatch(/single, Tier 2 degraded/);
    expect(out.note).toMatch(/ask triples skipped/);
  });

  it('Tier 2 lost mid-run: keeps what it labelled and defers the rest', async () => {
    judge.result = (opts) => ({ sampled: 10, judged: 5, silver: 3, proposed: 0, partial: true, mode: opts.mode, tier2Lost: true });
    await expect(runNightly({ userId: USER, day: '2026-09-24' }, fresh())).rejects.toMatchObject({ code: 'job_deferred' });
    expect(ask.calls).toBe(0);
  });
});

describe('profile rebuild while Tier 2 is degraded', () => {
  it('waits (deferred) while within profile.deferHours', async () => {
    tier.state = { degraded: true, model: 'Qwen/Qwen3.8-Flash-Next', reason: 'timeout' };
    await expect(runRebuildJob({ userId: USER }, fresh())).rejects.toMatchObject({ code: 'job_deferred' });
  });

  it('after the wait it runs (and a profile written on the lighter model would be provisional)', async () => {
    tier.state = { degraded: true, model: 'Qwen/Qwen3.8-Flash-Next', reason: 'timeout' };
    const out = await runRebuildJob({ userId: USER }, old());
    expect(out).toEqual({ status: 'done', note: 'no evidence yet' });
  });
});

describe('briefing prose is a Tier 2 job', () => {
  it('Tier 2 degraded: the template, flagged, and no model call', async () => {
    tier.state = { degraded: true, model: 'Qwen/Qwen3.8-Flash-Next', reason: 'timeout' };
    const b = await composeBriefing(USER, { now: Date.parse('2026-09-24T07:00:00Z') });
    expect(llm.calls).toBe(0);
    expect(b.data).toMatchObject({ generated_by: 'deterministic', fallback: true, fallback_reason: 'tier2_degraded', model: null });
  });

  it('the fallback model answering is not Tier 2 prose: template, flagged', async () => {
    llm.chat.mockResolvedValueOnce({ content: 'A calm morning. One reply is owed to Priya about the visa form.', model: 'gemma', fellBack: true, lighterModel: true });
    const b = await composeBriefing(USER, { now: Date.parse('2026-09-24T07:00:00Z') });
    expect(llm.calls).toBe(1);
    expect(b.data).toMatchObject({ generated_by: 'deterministic', fallback: true, fallback_reason: 'tier2_degraded' });
  });

  it('Tier 2 answering: model prose with its model and prompt provenance', async () => {
    llm.chat.mockResolvedValueOnce({ content: 'A calm morning. One reply is owed to Priya about the visa form.', model: 'Qwen/Qwen3.8-Flash-Next', fellBack: false, lighterModel: false });
    const b = await composeBriefing(USER, { now: Date.parse('2026-09-24T07:00:00Z') });
    expect(b.data).toMatchObject({ generated_by: 'model', fallback: false, fallback_reason: null, model: 'Qwen/Qwen3.8-Flash-Next' });
    expect(llm.chat.mock.calls.at(-1)[0]).toMatchObject({ workflow: 'insights.briefing', prompt: { id: 'insights.briefing', tier: 'reasoning' } });
  });
});

describe('reasoningTier helpers (pure)', () => {
  it('reads the runtime tierStatus shape', () => {
    expect(tierMod.normaliseTierStatus({ reasoning: { degraded: true, model: 'Q', active: 'G', reason: 'timeout' } }))
      .toMatchObject({ degraded: true, model: 'Q', serving: 'G', reason: 'timeout', source: 'runtime' });
    expect(tierMod.normaliseTierStatus({ reasoning: { degraded: false, model: 'Q', active: 'Q' } }).degraded).toBe(false);
    expect(tierMod.normaliseTierStatus(null)).toBeNull();
  });
  it('from recent calls: degraded when the latest call to the Tier 2 model failed', () => {
    expect(tierMod.degradedFromCalls([])).toEqual({ degraded: false, reason: null });
    expect(tierMod.degradedFromCalls([{ ok: true }, { ok: false }]).degraded).toBe(false);
    expect(tierMod.degradedFromCalls([{ ok: false, error: 'no response within 45000 ms' }])).toMatchObject({ degraded: true, reason: 'no response within 45000 ms' });
  });
  it('lighter model: the runtime flag wins, then fellBack, then a non-reasoning tier or another model', () => {
    expect(tierMod.ranOnLighterModel({ lighterModel: false, fellBack: true })).toBe(false);
    expect(tierMod.ranOnLighterModel({ fellBack: true })).toBe(true);
    expect(tierMod.ranOnLighterModel({ tier: 'reflex' })).toBe(true);
    expect(tierMod.ranOnLighterModel({ model: 'gemma' }, 'qwen')).toBe(true);
    expect(tierMod.ranOnLighterModel({ model: 'qwen' }, 'qwen')).toBe(false);
    expect(tierMod.ranOnLighterModel(null)).toBe(false);
  });
});
