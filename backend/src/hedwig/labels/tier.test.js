// reasoningTier() right after a worker start: nothing has probed Tier 2 yet, and "never checked"
// must not read as healthy (a judge run would wait out llm.timeoutMs on a model that is down).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ pool: {}, query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ enabled: true, 'llm.models.long': 'qwen', 'llm.fallbackModel': 'gemma' })) }));

const state = vi.hoisted(() => ({ probed: false, probes: 0, probeEnabled: true }));
const reasoning = () => (state.probed
  ? { degraded: true, model: 'qwen', active: 'gemma', reason: 'no answer within 10000 ms', checkedAt: '2026-09-24T05:00:00.000Z' }
  : { degraded: false, model: 'qwen', active: 'qwen', reason: null, checkedAt: null });
vi.mock('../llm.js', () => ({
  tierStatus: vi.fn(async () => ({ reasoning: reasoning(), probe: { enabled: state.probeEnabled } })),
  probeModels: vi.fn(async () => { state.probes++; state.probed = true; return { models: [] }; }),
  activeModels: vi.fn(async () => ({ long: { degraded: false } })),
}));

const { reasoningTier } = await import('./tier.js');

beforeEach(() => { state.probed = false; state.probes = 0; state.probeEnabled = true; });

describe('reasoningTier before the first probe', () => {
  it('probes once before believing a Tier 2 that was never checked', async () => {
    const t = await reasoningTier('u1');
    expect(state.probes).toBe(1);
    expect(t).toMatchObject({ degraded: true, model: 'qwen', serving: 'gemma', source: 'runtime' });
  });

  it('does not probe again once a verdict exists', async () => {
    state.probed = true;
    await reasoningTier('u1');
    expect(state.probes).toBe(0);
  });

  it('does not probe when the probe is turned off', async () => {
    state.probeEnabled = false;
    const t = await reasoningTier('u1');
    expect(state.probes).toBe(0);
    expect(t.degraded).toBe(false);
  });
});
