// Single-judge silver labels (the Reflex model's own verdict while Tier 2 was down) are counted but
// never scored: scoring them would grade the sorting model against itself and could pass a gate.
import { describe, it, expect, vi } from 'vitest';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const U = '11111111-1111-4111-8111-111111111111';

vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql) => {
    if (/FROM hedwig_labels/.test(sql)) {
      return { rows: [
        { id: 1, user_id: U, suite: 'sort', target_id: A, label: { stream: 'people' }, grade: 'silver', source: 'judge', evidence: { singleJudge: true }, created_at: new Date() },
        { id: 2, user_id: U, suite: 'sort', target_id: B, label: { stream: 'reading' }, grade: 'silver', source: 'judge', evidence: {}, created_at: new Date() },
        { id: 3, user_id: U, suite: 'sort', target_id: C, label: { stream: 'records' }, grade: 'gold', source: 'question', evidence: {}, created_at: new Date() },
      ] };
    }
    if (/FROM messages m/.test(sql)) return { rows: [A, B, C].map((id) => ({ id, mid: null })) };
    if (/FROM hedwig_sort/.test(sql)) return { rows: [{ message_id: A, stream: 'people' }, { message_id: B, stream: 'people' }, { message_id: C, stream: 'records' }] };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('./runtime.js', () => ({ runPrompt: vi.fn(), runReflex: vi.fn(), retrieve: vi.fn(), tableExists: vi.fn(async () => true) }));

const { runSuite } = await import('./eval.js');

describe('eval: single-judge silver labels', () => {
  it('are counted apart and kept out of the silver metrics', async () => {
    const r = await runSuite('sort', { userId: U });
    expect(r.nSilverSingleJudge).toBe(1);
    expect(r.nSilver).toBe(1); // only B; A (Reflex agreeing with itself) is not scored
    expect(r.nGold).toBe(1);
  });
});
