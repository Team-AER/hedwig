import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));
vi.mock('../hooks.js', () => ({ HEDWIG_HOOKS: { onContextBuilt: 'hedwig.onContextBuilt' }, runHedwigHook: vi.fn(async () => {}) }));

const { mapCitations, extractCitations } = await import('./summaries.js');

describe('mapCitations', () => {
  const ids = ['m1', 'm2', 'm3', 'm4'];
  it('renumbers citations in order of first use and returns the cited message ids', () => {
    expect(mapCitations('Docs are due 30 Sep [3]. The solicitor is engaged [1][3].', ids)).toEqual({
      text: 'Docs are due 30 Sep [1]. The solicitor is engaged [2][1].',
      sources: ['m3', 'm1'],
    });
  });
  it('splits grouped citations and drops ones that point nowhere', () => {
    expect(mapCitations('A [2, 4]. B [9]. C [0][2].', ids)).toEqual({ text: 'A [1][2]. B. C [1].', sources: ['m2', 'm4'] });
  });
  it('copes with no citations', () => {
    expect(mapCitations('Nothing cited.', ids)).toEqual({ text: 'Nothing cited.', sources: [] });
  });
});

describe('extractCitations', () => {
  it('returns the valid source numbers an answer used', () => {
    expect(extractCitations('Due 30 Sep [3]. Engaged [1, 3]. Bogus [7].', 4)).toEqual([1, 3]);
    expect(extractCitations('', 4)).toEqual([]);
  });
});
