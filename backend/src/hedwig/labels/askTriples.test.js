// One thread whose Ask-triple output is unusable is that thread rejected; it must not fail the
// nightly job (a failed attempt re-runs the whole judge first).
import { describe, it, expect, vi } from 'vitest';

const U = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql) => {
    if (/WITH mine AS/.test(sql)) return { rows: [{ account_id: ACC, thread_key: 't1' }, { account_id: ACC, thread_key: 't2' }] };
    if (/DISTINCT ON \(m\.account_id, m\.thread_key/.test(sql)) {
      return { rows: ['t1', 't2'].map((t, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, account_id: ACC, thread_key: t, date: new Date(), from_email: 'a@b.c', subject: t, body_text: 'hello there' })) };
    }
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ enabled: true, 'labels.askTriplesPerNight': 2 })) }));
vi.mock('../triage/store.js', () => ({ userAddresses: vi.fn(async () => new Map([[U, new Set(['me@x.y'])]])) }));
vi.mock('./judge.js', () => ({ ownerLine: vi.fn(async () => 'Me') }));
const stored = vi.hoisted(() => ({ labels: null }));
vi.mock('./store.js', () => ({ upsertLabels: vi.fn(async (u, l) => { stored.labels = l; }) }));
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('./runtime.js', () => ({
  recordCorrection: vi.fn(),
  runPrompt: vi.fn(async () => {
    calls.n++;
    throw Object.assign(new Error('prompt ask.generate: invalid output'), { name: 'PromptOutputError' });
  }),
}));

const { askTriplesForUser } = await import('./askTriples.js');

describe('askTriplesForUser', () => {
  it('rejects a thread whose output is unusable and goes on to the next', async () => {
    const stats = await askTriplesForUser(U, { day: '2026-09-24' });
    expect(calls.n).toBe(2); // both threads tried; each rejected, no throw
    expect(stats).toMatchObject({ threads: 2, rejected: 2, answerable: 0, partial: false });
    expect(stored.labels).toEqual([]);
  });
});
