import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { rrfMerge, buildOrTsQuery, diversify } = await import('./search.js');

describe('rrfMerge', () => {
  it('rewards documents ranked well by several retrievers', () => {
    const out = rrfMerge([{ ids: ['a', 'b', 'c'] }, { ids: ['c', 'b', 'd'] }]);
    // c (ranks 3 and 1) edges out b (2 and 2); both beat a and d, found by one retriever each.
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(out[0].score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(out[1].score).toBeCloseTo(2 / 62, 10);
    expect(out[2].score).toBeCloseTo(1 / 61, 10);
  });
  it('applies weights, ignores repeats within a list and handles empty lists', () => {
    const out = rrfMerge([{ ids: ['a', 'a', 'b'], weight: 1 }, { ids: [], weight: 1 }, { ids: ['b'], weight: 0.5 }]);
    expect(out.find((r) => r.id === 'a').score).toBeCloseTo(1 / 61, 10);
    expect(out.find((r) => r.id === 'b').score).toBeCloseTo(1 / 62 + 0.5 / 61, 10);
    expect(rrfMerge([])).toEqual([]);
  });
  it('breaks ties deterministically', () => {
    expect(rrfMerge([{ ids: ['z'] }, { ids: ['y'] }]).map((r) => r.id)).toEqual(['y', 'z']);
  });
});

describe('buildOrTsQuery', () => {
  it('keeps only words, so user text cannot break tsquery syntax', () => {
    expect(buildOrTsQuery("When are the visa docs due? (& | !) 'x'")).toBe('when | are | the | visa | docs | due');
    expect(buildOrTsQuery('Überweisung 2041')).toBe('überweisung | 2041');
    expect(buildOrTsQuery('!!')).toBe('');
  });
});

describe('diversify', () => {
  const r = (id, thread) => ({ id, thread_key: thread });
  const results = [r('1', 'a'), r('2', 'a'), r('3', 'a'), r('4', 'a'), r('5', 'b'), r('6', 'c'), r('7', 'd'), r('8', 'b')];
  it('keeps relevance but pushes further messages of one thread behind other threads', () => {
    // effective ranks: 1→0, 2→3, 3→6, 4 dropped (4th of a), 5→4, 6→5, 7→6, 8→9
    expect(diversify(results, 3).map((x) => x.id)).toEqual(['1', '2', '5']);
    expect(diversify(results, 5).map((x) => x.id)).toEqual(['1', '2', '3', '5', '6']);
  });
  it('caps messages per thread', () => {
    expect(diversify(results, 20).map((x) => x.id)).toEqual(['1', '2', '3', '5', '6', '7', '8']);
    expect(diversify(results, 20, { perThread: 1 }).map((x) => x.id)).toEqual(['1', '5', '6', '7']);
  });
  it('treats a message without a thread key as its own thread', () => {
    expect(diversify([{ id: 'x' }, { id: 'y' }], 2).map((x) => x.id)).toEqual(['x', 'y']);
  });
});
