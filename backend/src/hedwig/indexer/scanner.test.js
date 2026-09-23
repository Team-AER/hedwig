// The pipeline scanner's history pass (pipeline.js), as rebuilt on the coverage ledger.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let history = [];
const inserted = [];
const historySql = [];
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    if (/JOIN hedwig_index_coverage c ON/.test(sql) && /h\.message_id IS NULL/.test(sql)) { historySql.push({ sql, params }); return { rows: history }; }
    if (/INSERT INTO hedwig_msg/.test(sql)) { inserted.push(params); return { rows: [] }; }
    return { rows: [] };
  }),
}));
vi.mock('./coverage.js', () => ({
  maybeRefreshCoverage: vi.fn(async () => null),
  historyPending: vi.fn(async () => true),
  resetCoverage: vi.fn(async () => 0),
  coverageSummary: vi.fn(async () => ({ folders: 2, done: 2, paused: 0, oldest_seen: null })),
}));

const pipeline = await import('../pipeline.js');
const { historyPending } = await import('./coverage.js');

const day = 86400_000;
const msg = (id, daysAgo, extra = {}) => ({ id, account_id: 'a', user_id: 'u', message_id: `<${id}@x>`, date: new Date(Date.now() - daysAgo * day).toISOString(), folder: 'INBOX', ...extra });

describe('scanner history pass', () => {
  const ran = { mail: [], spamOnly: [] };
  beforeEach(() => {
    pipeline._resetSteps();
    history = []; inserted.length = 0; historySql.length = 0; ran.mail = []; ran.spamOnly = [];
    pipeline.defineStep({ name: 'cheap', order: 10, backfill: true, run: async (rows, ctx) => { ran.mail.push({ ids: rows.map((r) => r.id), ctx }); } });
    pipeline.defineStep({ name: 'index', order: 60, backfill: true, spam: true, run: async (rows, ctx) => { if (ctx.spam) ran.spamOnly.push(rows.map((r) => r.id)); } });
  });

  it('keeps finding history after a tick on an empty database (the pipeline.backfill bug)', async () => {
    expect(await pipeline.scanOnce()).toEqual({ realtime: 0, backfill: 0 });
    // Mail from two years ago syncs later; nothing was marked done for good, so it is found.
    history = [msg('old', 730)];
    expect(await pipeline.scanOnce()).toEqual({ realtime: 0, backfill: 1 });
    expect(ran.mail.at(-1)).toMatchObject({ ids: ['old'], ctx: { historical: true } });
    // No date cursor bounds the query: absence alone decides.
    expect(historySql.at(-1).params).toEqual([50]);
    expect(historySql.at(-1).sql).not.toMatch(/m\.date </);
  });

  it('skips the history query when every folder is done', async () => {
    historyPending.mockResolvedValueOnce(false);
    history = [msg('x', 1)];
    expect(await pipeline.scanOnce()).toEqual({ realtime: 0, backfill: 0 });
    expect(historySql).toHaveLength(0);
  });

  it('marks spam-folder mail seen with skip_reason spam and runs only spam-capable steps on it', async () => {
    history = [msg('s1', 1, { coverage_spam: true, folder: 'Junk' }), msg('m1', 2)];
    await pipeline.scanOnce();
    const [ids, , , skips] = inserted.at(-1);
    expect(Object.fromEntries(ids.map((id, i) => [id, skips[i]]))).toEqual({ s1: 'spam', m1: null });
    expect(ran.spamOnly).toEqual([['s1']]);
    expect(ran.mail.flatMap((r) => r.ids)).toEqual(['m1']);
  });

  it('reports backfill done from the coverage ledger', async () => {
    const stats = await pipeline.pipelineStats();
    expect(stats.backfill).toMatchObject({ done: true });
  });
});
