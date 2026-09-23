// The relevance floor in retrieve(): the evidence gate (cosine / full-text word share / rank) before
// fusion and the fused-score cut after it, against a mocked database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ fts: [], vec: [], calls: [] }));
const answer = (sql, params) => {
  db.calls.push({ sql, params });
  if (/ts_rank_cd/.test(sql)) return { rows: db.fts };
  if (/<=>/.test(sql)) return { rows: db.vec };
  return { rows: [] };
};
vi.mock('../../services/db.js', () => ({
  query: vi.fn(async (sql, params) => answer(sql, params)),
  pool: { connect: async () => ({ query: async (sql, params) => answer(sql, params), release() {} }) },
}));

const cfg = vi.hoisted(() => ({ values: {} }));
vi.mock('../config.js', async (orig) => {
  const real = await orig();
  return { ...real, getConfig: vi.fn(async () => cfg.values) };
});

const emb = vi.hoisted(() => ({ model: 'bge-m3' }));
vi.mock('../embeddings.js', async (orig) => {
  const real = await orig();
  return { ...real, embedQuery: vi.fn(async () => (emb.model ? { model: emb.model, dims: 1024, vector: new Array(1024).fill(0) } : null)) };
});
vi.mock('./recipe.js', () => ({
  VECTOR_DIMS: 1024,
  recipesFor: vi.fn(async () => ({ activeVersion: 'v1', targetVersion: 'v1', vecRecipe: 'v1:bge-m3', vectors: true })),
}));
vi.mock('./store.js', () => ({ tsConfig: vi.fn(async () => 'simple') }));
vi.mock('../state.js', () => ({ getState: vi.fn(async () => null) }));

const { SCHEMA } = await import('../config.js');
const { retrieve, admit } = await import('./retrieve.js');
const DEFAULTS = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));

const DATE = new Date('2026-09-20T12:00:00Z');
const chunk = (id, msg, extra = {}) => ({
  id, message_id: msg, thread_key: `t-${msg}`, kind: 'body', ordinal: 0, attachment_index: null, text: `chunk ${id}`,
  date: DATE, in_reply_to: null, account_id: 'acc', ...extra,
});
/** A vector hit at a given cosine similarity. */
const vhit = (id, msg, cos) => chunk(id, msg, { dist: 1 - cos });
/** A full-text hit with a rank and the share of query words it contains. */
const fhit = (id, msg, rank, coverage) => chunk(id, msg, { rank, coverage });

beforeEach(() => {
  db.fts = []; db.vec = []; db.calls = [];
  cfg.values = { ...DEFAULTS };
  emb.model = 'bge-m3';
});

describe('evidence gate defaults', () => {
  it('ships the tuned thresholds and keeps index.floor as the fused-score cut', () => {
    expect(DEFAULTS).toMatchObject({
      'index.floor': 0.02, 'index.minCosine': 0.5, 'index.minCosineHash': 0.4, 'index.minTermCoverage': 0.5, 'index.minFtsRank': 0.8,
    });
  });
});

describe('admit', () => {
  it('admits on either list and keeps an admitted chunk in both', () => {
    const out = admit({
      fts: [{ id: 'a', rank: 0.3, coverage: 1 }, { id: 'b', rank: 0.3, coverage: 0.2 }, { id: 'c', rank: 0.3, coverage: 0.1 }],
      vec: [{ id: 'b', cosine: 0.7 }, { id: 'c', cosine: 0.3 }, { id: 'd', cosine: 0.2 }],
    }, { minCosine: 0.5, minTermCoverage: 0.5, minFtsRank: 0.8 });
    expect(out.fts.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.vec.map((r) => r.id)).toEqual(['b']);
    expect(out.dropped).toBe(2);
  });
  it('is off with its defaults', () => {
    const lists = { fts: [{ id: 'a', rank: 0, coverage: 0 }], vec: [{ id: 'b', cosine: 0.01 }] };
    expect(admit(lists)).toMatchObject({ dropped: 0 });
  });
});

describe('retrieve relevance floor', () => {
  it('returns nothing, with floor: true, for an unrelated question', async () => {
    // "What did the plumber quote for the Bergen cabin?" on the demo mailbox: the best bge-m3 hits sit
    // near 0.44 and full text matches one word in four ("quote", "cabin").
    db.vec = [vhit(1, 'quote', 0.436), vhit(2, 'quote', 0.413), vhit(3, 'trip', 0.409)];
    db.fts = [fhit(3, 'trip', 0.615, 0.25), fhit(1, 'quote', 0.615, 0.25)];
    const res = await retrieve({ userId: 'u1', query: 'What did the plumber quote for the Bergen cabin?', expandThreads: false });
    expect(res).toEqual({ chunks: [], floor: true });
  });

  it('keeps a related question, dropping only the weak hits', async () => {
    db.vec = [vhit(10, 'visa', 0.636), vhit(11, 'visa', 0.63), vhit(12, 'laptop', 0.44)];
    db.fts = [fhit(10, 'visa', 0.762, 0.67), fhit(13, 'visa2', 0.722, 1), fhit(14, 'news', 0.375, 0.33)];
    const res = await retrieve({ userId: 'u1', query: 'When are the visa documents due?', expandThreads: false });
    expect(res.chunks.map((c) => c.chunkId)).toEqual([10, 11, 13]);
    expect(res.chunks[0]).toMatchObject({ messageId: 'visa', threadId: 't-visa', ftsRank: 1, vecRank: 1 });
    expect(res.chunks[0].score).toBeGreaterThan(res.chunks[2].score);
    expect(res.floor).toBe(true); // two weak hits were cut and fewer than `limit` came back
    const fts = db.calls.find((c) => /ts_rank_cd/.test(c.sql));
    expect(fts.params[5]).toEqual(['visa:*', 'documents:*', 'due:*']);
    expect(fts.sql).toMatch(/AS coverage/);
  });

  it('says floor: false when nothing was cut', async () => {
    db.vec = [vhit(10, 'visa', 0.636)];
    db.fts = [fhit(10, 'visa', 0.762, 0.67)];
    const res = await retrieve({ userId: 'u1', query: 'When are the visa documents due?', expandThreads: false });
    expect(res).toMatchObject({ floor: false, chunks: [{ chunkId: 10 }] });
  });

  it('passes a full-text-only hit with a strong rank, even with few of the words', async () => {
    emb.model = null; // no vectors: full text alone decides
    db.fts = [fhit(20, 'inv', 0.9, 0.25), fhit(21, 'noise', 0.62, 0.25)];
    const res = await retrieve({ userId: 'u1', query: 'Marta invoice March landing page', expandThreads: false });
    expect(res.chunks.map((c) => c.chunkId)).toEqual([20]);
    expect(res.chunks[0]).toMatchObject({ ftsRank: 1, vecRank: null });
  });

  it('passes a full-text-only hit that contains the words, even with a modest rank', async () => {
    // "Hetzner": bge-m3 only reaches 0.47, but the one query word is in the chunk.
    db.vec = [vhit(30, 'auction', 0.467)];
    db.fts = [fhit(30, 'auction', 0.545, 1)];
    const res = await retrieve({ userId: 'u1', query: 'Hetzner', expandThreads: false });
    expect(res).toMatchObject({ floor: false, chunks: [{ chunkId: 30, ftsRank: 1, vecRank: 1 }] });
  });

  it('uses the hash-provider cosine threshold for hash vectors', async () => {
    db.vec = [vhit(40, 'a', 0.42)];
    emb.model = 'hash-1024';
    expect((await retrieve({ userId: 'u1', query: 'zz', expandThreads: false })).chunks.map((c) => c.chunkId)).toEqual([40]);
    emb.model = 'bge-m3';
    expect(await retrieve({ userId: 'u1', query: 'zz', expandThreads: false })).toEqual({ chunks: [], floor: true });
  });

  it('still applies index.floor to fused scores', async () => {
    db.vec = [vhit(10, 'visa', 0.636), vhit(11, 'visa', 0.63)];
    db.fts = [fhit(10, 'visa', 0.762, 0.67)];
    cfg.values['index.floor'] = 1; // the max: nothing scores 1 unless first in both lists and sent this instant
    expect(await retrieve({ userId: 'u1', query: 'visa documents', expandThreads: false })).toEqual({ chunks: [], floor: true });
    cfg.values['index.floor'] = 0.6;
    expect((await retrieve({ userId: 'u1', query: 'visa documents', expandThreads: false })).chunks.map((c) => c.chunkId)).toEqual([10]);
  });

  it('turns a gate off at 0', async () => {
    db.vec = [vhit(1, 'x', 0.2)];
    db.fts = [fhit(2, 'y', 0.1, 0.1)];
    cfg.values['index.minCosine'] = 0;
    cfg.values['index.minTermCoverage'] = 0;
    const res = await retrieve({ userId: 'u1', query: 'anything at all', expandThreads: false });
    expect(res.chunks.map((c) => c.chunkId).sort()).toEqual([1, 2]);
    expect(res.floor).toBe(false);
  });

  it('reports no floor when neither search found anything', async () => {
    expect(await retrieve({ userId: 'u1', query: 'nothing', expandThreads: false })).toEqual({ chunks: [], floor: false });
  });
});
