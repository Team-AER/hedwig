import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { fuse, cut, buildOrQuery, phraseOf, recencyPrior, normalizeFilters, whereSql, RRF_K } = await import('./retrieve.js');

const NOW = Date.parse('2026-09-23T12:00:00Z');
const r = (id, extra = {}) => ({ id, messageId: `m-${id}`, kind: 'body', date: '2026-09-23T12:00:00Z', ...extra });

describe('fuse (weighted RRF)', () => {
  it('rewards chunks both retrievers rank well and records both ranks', () => {
    const out = fuse({ fts: [r('a'), r('b'), r('c')], vec: [r('c'), r('b'), r('d')] }, { weights: { fts: 1, vec: 1, recency: 0 }, now: NOW });
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd']);
    const c = out[0];
    expect(c).toMatchObject({ ftsRank: 3, vecRank: 1 });
    const norm = 2 / (RRF_K + 1);
    expect(c.score).toBeCloseTo((1 / 63 + 1 / 61) / norm, 10);
    expect(out.find((x) => x.id === 'd')).toMatchObject({ ftsRank: null, vecRank: 3 });
  });
  it('normalises so first in both lists and brand new scores 1', () => {
    const out = fuse({ fts: [r('a')], vec: [r('a')] }, { weights: { fts: 1, vec: 1, recency: 0.3 }, now: NOW });
    expect(out[0].score).toBeCloseTo(1, 10);
  });
  it('applies the fts/vec weights', () => {
    const w = fuse({ fts: [r('a')], vec: [r('b')] }, { weights: { fts: 2, vec: 1, recency: 0 }, now: NOW });
    expect(w[0].id).toBe('a');
    expect(w[0].score / w[1].score).toBeCloseTo(2, 10);
  });
  it('lets the recency prior break ties toward newer mail', () => {
    const old = r('old', { date: '2024-09-23T12:00:00Z' });
    const fresh = r('new');
    const out = fuse({ fts: [old], vec: [fresh] }, { weights: { fts: 1, vec: 1, recency: 0.3 }, now: NOW, halfLifeDays: 180 });
    expect(out[0].id).toBe('new');
  });
  it('down-weights quoted history by kind', () => {
    const out = fuse({ fts: [r('q', { kind: 'quote' }), r('b')], vec: [] }, { weights: { fts: 1, vec: 1, recency: 0 }, kindWeights: { quote: 0.35 }, now: NOW });
    expect(out.map((x) => x.id)).toEqual(['b', 'q']);
  });
  it('ignores repeats within one list', () => {
    const out = fuse({ fts: [r('a'), r('a'), r('b')], vec: [] }, { weights: { fts: 1, vec: 0, recency: 0 }, now: NOW });
    expect(out.find((x) => x.id === 'b').ftsRank).toBe(2);
  });
});

describe('cut (floor, per-message cap)', () => {
  const scored = [
    { id: '1', messageId: 'A', score: 0.9 }, { id: '2', messageId: 'A', score: 0.8 }, { id: '3', messageId: 'A', score: 0.7 },
    { id: '4', messageId: 'A', score: 0.6 }, { id: '5', messageId: 'B', score: 0.5 }, { id: '6', messageId: 'C', score: 0.01 },
  ];
  it('caps chunks per message', () => {
    expect(cut(scored, { limit: 10, floor: 0, perMessage: 3 }).chunks.map((x) => x.id)).toEqual(['1', '2', '3', '5', '6']);
  });
  it('drops chunks under the floor and says so when that left fewer than asked', () => {
    const res = cut(scored, { limit: 10, floor: 0.02 });
    expect(res.chunks.map((x) => x.id)).toEqual(['1', '2', '3', '5']);
    expect(res.floor).toBe(true);
    expect(cut(scored, { limit: 2, floor: 0.02 }).floor).toBe(false);
    expect(cut([], { limit: 5, floor: 0.02 })).toEqual({ chunks: [], floor: false });
  });
});

describe('query building', () => {
  it('ORs content words as prefixes, drops stopwords, cannot break tsquery syntax', () => {
    expect(buildOrQuery("When is the visa form due? (& | !) 'x'")).toBe('visa:* | form:* | due:*');
    expect(buildOrQuery('the what')).toBe('the:* | what:*');
    expect(buildOrQuery('!!')).toBe('');
  });
  it('boosts phrases of two or more words only', () => {
    expect(phraseOf('invoice 2041')).toBe('invoice 2041');
    expect(phraseOf('invoice')).toBe('');
  });
  it('halves the recency prior every half-life', () => {
    expect(recencyPrior('2026-09-23T12:00:00Z', { now: NOW })).toBeCloseTo(1, 10);
    expect(recencyPrior('2026-03-27T12:00:00Z', { now: NOW, halfLifeDays: 180 })).toBeCloseTo(0.5, 2);
    expect(recencyPrior(null, { now: NOW })).toBe(0);
  });
});

describe('filters', () => {
  const recipes = { activeVersion: 'v1', targetVersion: 'v1' };
  it('rejects bad dates', () => {
    expect(() => normalizeFilters({ after: 'yesterday-ish' })).toThrow('invalid after');
  });
  it('always scopes to the user, hides spam unless asked, and parameterises everything', () => {
    const params = ['user'];
    const sql = whereSql(normalizeFilters({ people: ['Priya.Nair@Vantage.example', 'Thomas'], folders: ['INBOX'], hasAttachment: true, threadId: 't1' }), recipes, params);
    expect(sql).toContain('c.user_id = $1');
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('c.spam = false');
    expect(params).toEqual(['user', 'v1', ['priya.nair@vantage.example'], '%thomas%', ['INBOX'], true, 't1']);
    expect(sql).not.toContain('Priya');
    const withSpam = whereSql(normalizeFilters({ includeSpam: true }), recipes, ['user']);
    expect(withSpam).not.toContain('c.spam = false');
  });
  it('reads the old recipe plus new chunks of uncovered messages mid-rebuild', () => {
    const params = ['user'];
    const sql = whereSql(normalizeFilters({}), { activeVersion: 'v1', targetVersion: 'v2' }, params);
    expect(params).toEqual(['user', 'v1', 'v2']);
    expect(sql).toMatch(/c\.recipe = \$2 OR \(c\.recipe = \$3 AND NOT EXISTS/);
  });
});
