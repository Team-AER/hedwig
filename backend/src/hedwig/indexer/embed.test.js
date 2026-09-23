import { describe, it, expect, vi, beforeEach } from 'vitest';

// embedPending's failure handling: split a batch only for input errors; back off on outages.
const db = vi.hoisted(() => ({ calls: [], state: new Map() }));
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ');
    db.calls.push({ sql: text, params });
    if (/SELECT value FROM hedwig_state/.test(text)) return { rows: db.state.has(params[0]) ? [{ value: db.state.get(params[0]) }] : [] };
    if (/INSERT INTO hedwig_state/.test(text)) { db.state.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    if (/SELECT c\.id, c\.user_id, c\.message_id, c\.text FROM hedwig_chunks/.test(text)) {
      return { rows: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, user_id: 'u1', message_id: `m${i + 1}`, text: `chunk ${i + 1}` })) };
    }
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ 'index.embedBatch': 4 })) }));
vi.mock('./recipe.js', () => ({ currentRecipe: async () => ({ vectors: true, version: 'v1', full: 'v1:bge-m3' }) }));
const embed = vi.hoisted(() => vi.fn());
vi.mock('../embeddings.js', async (importOriginal) => ({ ...(await importOriginal()), embed }));

const { embedPending, isInputError, embedBackoffMs } = await import('./store.js');
const { EmbeddingError } = await import('../embeddings.js');

const vectors = (n) => ({ model: 'bge-m3', dims: 3, vectors: Array.from({ length: n }, () => [1, 0, 0]) });
const ids = ['m1', 'm2', 'm3', 'm4'];

beforeEach(() => {
  db.calls.length = 0;
  db.state.clear();
  embed.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('embedPending failures', () => {
  it('classifies only 400/413/422 as input errors', () => {
    expect([400, 413, 422].map((status) => isInputError({ status }))).toEqual([true, true, true]);
    expect([401, 404, 408, 429, 500, 503, undefined].map((status) => isInputError({ status }))).toEqual(Array(7).fill(false));
    expect(embedBackoffMs(1)).toBe(30_000);
    expect(embedBackoffMs(3)).toBe(120_000);
    expect(embedBackoffMs(20)).toBe(15 * 60_000);
    expect(embedBackoffMs(1, 7)).toBe(7000);
  });

  it('on a 503 it does not retry chunk by chunk; it backs off, and skips sweeps and live calls until then', async () => {
    embed.mockRejectedValue(new EmbeddingError('embeddings 503: overloaded', { status: 503 }));
    await expect(embedPending({ messageIds: ids })).rejects.toThrow(/503/);
    expect(embed).toHaveBeenCalledTimes(1); // the old code retried 4 more times, one chunk each
    const backoff = db.state.get('index.embedBackoff');
    expect(backoff).toMatchObject({ failures: 1 });
    expect(Date.parse(backoff.until) - Date.now()).toBeGreaterThan(25_000);
    // The sweep (no ids) and the live pipeline step (ids) both skip while backed off.
    embed.mockReset();
    expect(await embedPending()).toBe(0);
    expect(await embedPending({ messageIds: ids })).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('honours Retry-After on a 429 and grows the backoff on repeated outages', async () => {
    embed.mockRejectedValue(new EmbeddingError('embeddings 429', { status: 429, retryAfterSec: 90 }));
    await expect(embedPending({ messageIds: ids })).rejects.toThrow(/429/);
    expect(Date.parse(db.state.get('index.embedBackoff').until) - Date.now()).toBeGreaterThan(85_000);
    db.state.set('index.embedBackoff', { ...db.state.get('index.embedBackoff'), until: new Date(Date.now() - 1).toISOString() });
    embed.mockRejectedValue(new EmbeddingError('embeddings request failed: ECONNREFUSED'));
    await expect(embedPending({ messageIds: ids })).rejects.toThrow(/ECONNREFUSED/);
    expect(db.state.get('index.embedBackoff')).toMatchObject({ failures: 2 });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('on a 400 it splits the batch and marks only the message whose chunk is bad', async () => {
    embed.mockImplementation(async (texts) => {
      if (texts.includes('chunk 3')) throw new EmbeddingError('embeddings 400: input too long', { status: 400 });
      return vectors(texts.length);
    });
    expect(await embedPending({ messageIds: ids })).toBe(3);
    expect(embed).toHaveBeenCalledTimes(5); // the batch, then one per chunk
    const marked = db.calls.find((c) => /UPDATE hedwig_index_msg SET error = LEFT/.test(c.sql));
    expect(marked.params[0]).toEqual(['m3']);
    expect(db.state.get('index.embedBackoff')).toBeUndefined();
  });

  it('an outage met while splitting stops the split and backs off', async () => {
    let n = 0;
    embed.mockImplementation(async () => {
      n++;
      if (n === 1) throw new EmbeddingError('embeddings 400: bad input', { status: 400 });
      throw new EmbeddingError('embeddings 502', { status: 502 });
    });
    await expect(embedPending({ messageIds: ids })).rejects.toThrow(/502/);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(db.state.get('index.embedBackoff')).toMatchObject({ failures: 1 });
  });

  it('clears the backoff after a successful run', async () => {
    db.state.set('index.embedBackoff', { until: new Date(Date.now() - 1).toISOString(), failures: 3 });
    embed.mockImplementation(async (texts) => vectors(texts.length));
    expect(await embedPending({ messageIds: ids })).toBe(4);
    expect(db.state.get('index.embedBackoff')).toBeNull();
  });
});

describe('embedPending vector insert race', () => {
  it('joins on hedwig_chunks so a re-chunked message cannot violate the foreign key, and retries once on 23503', async () => {
    embed.mockImplementation(async (texts) => vectors(texts.length));
    const { query } = await import('../../services/db.js');
    let inserts = 0;
    const real = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO hedwig_chunk_vectors/.test(sql)) {
        inserts++;
        expect(sql).toMatch(/JOIN hedwig_chunks c ON c\.id = x\.id/);
        if (inserts === 1) { const e = new Error('violates foreign key constraint'); e.code = '23503'; throw e; }
      }
      return real(sql, params);
    });
    expect(await embedPending({ messageIds: ids })).toBe(4);
    expect(inserts).toBe(2);
    query.mockImplementation(real);
  });
});
