import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// A tiny fake of the tables coverage.js touches, routed on SQL text.
const state = new Map();
const calls = [];
let folders = [];
let counts = [];
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM hedwig_state WHERE key/.test(sql)) return { rows: state.has(params[0]) ? [{ value: state.get(params[0]) }] : [] };
    if (/INSERT INTO hedwig_state/.test(sql)) { state.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    if (/FROM email_accounts a JOIN folders f/.test(sql)) return { rows: folders };
    if (/GROUP BY c.account_id, c.folder, c.state/.test(sql)) return { rows: counts };
    if (/UPDATE hedwig_index_coverage\s+SET state = CASE/.test(sql)) return { rowCount: 3, rows: [] };
    if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ due: 0 }] };
    return { rows: [], rowCount: 0 };
  }),
}));

const { classifyFolder, coverageState, coverageError, rulesOf, rulesHash, refreshCoverage } = await import('./coverage.js');
const { invalidateConfigCache } = await import('../config.js');

const DEFAULT_RULES = { excludeSpecialUse: ['\\All', '\\Drafts', '\\Flagged', '\\Important', '\\Junk', '\\Trash'], excludeFolders: [], indexSpam: true };

describe('classifyFolder', () => {
  it('includes normal folders and excludes trash, drafts and All Mail', () => {
    expect(classifyFolder('INBOX', null, DEFAULT_RULES)).toEqual({ included: true, spam: false });
    expect(classifyFolder('Sent', '\\Sent', DEFAULT_RULES)).toEqual({ included: true, spam: false });
    expect(classifyFolder('[Gmail]/All Mail', '\\All', DEFAULT_RULES).included).toBe(false);
    expect(classifyFolder('Trash', null, DEFAULT_RULES).included).toBe(false);
    expect(classifyFolder('INBOX/Drafts', null, DEFAULT_RULES).included).toBe(false);
  });
  it('includes the server spam folder, flagged, even though \\Junk is an excluded special-use', () => {
    expect(classifyFolder('Junk', '\\Junk', DEFAULT_RULES)).toEqual({ included: true, spam: true });
    expect(classifyFolder('[Gmail]/Spam', null, DEFAULT_RULES)).toEqual({ included: true, spam: true });
    expect(classifyFolder('Junk', '\\Junk', { ...DEFAULT_RULES, indexSpam: false }).included).toBe(false);
  });
  it('honours pipeline.excludeFolders', () => {
    expect(classifyFolder('Archive/2009', null, { ...DEFAULT_RULES, excludeFolders: ['Archive/2009'] }).included).toBe(false);
  });
});

describe('coverageState', () => {
  const base = { total: 10, seen: 10, dupes: 2, chunked: 8, embedded: 8, bodiesDue: 0 };
  it('is done only when every message is seen, chunked, embedded and has its body settled', () => {
    expect(coverageState(base)).toBe('done');
    expect(coverageState({ ...base, seen: 9 })).toBe('running');
    expect(coverageState({ ...base, embedded: 7 })).toBe('running');
    expect(coverageState({ ...base, embedded: 0 }, { vectors: false })).toBe('done');
    expect(coverageState({ ...base, bodiesDue: 1 })).toBe('running');
  });
  it('flips back from done when unseen mail appears, whatever its age (the old cursor bug)', () => {
    expect(coverageState(base)).toBe('done');
    // An old message synced later: total grows, nothing else does.
    expect(coverageState({ ...base, total: 11 })).toBe('running');
  });
  it('an empty folder is done, an untouched one pending, a paused one stays paused', () => {
    expect(coverageState({ total: 0, seen: 0, chunked: 0, embedded: 0 })).toBe('done');
    expect(coverageState({ total: 5, seen: 0, chunked: 0, embedded: 0 })).toBe('pending');
    expect(coverageState({ ...base, seen: 1 }, { paused: true })).toBe('paused');
  });
  it('explains failures', () => {
    expect(coverageError({ bodyFailed: 2, lastBodyError: 'Mailbox lock timeout' })).toBe('2 bodies could not be fetched (last: Mailbox lock timeout)');
    expect(coverageError({})).toBeNull();
  });
});

describe('refreshCoverage', () => {
  afterAll(() => { delete process.env.HEDWIG_EMBEDDINGS_PROVIDER; invalidateConfigCache(); });
  beforeEach(() => {
    calls.length = 0;
    state.clear();
    invalidateConfigCache();
    process.env.HEDWIG_EMBEDDINGS_PROVIDER = 'hash';
    folders = [
      { account_id: 'a1', user_id: 'u1', path: 'INBOX', special_use: null },
      { account_id: 'a1', user_id: 'u1', path: 'Junk', special_use: '\\Junk' },
      { account_id: 'a1', user_id: 'u1', path: 'Trash', special_use: '\\Trash' },
    ];
    counts = [
      { account_id: 'a1', folder: 'INBOX', state: 'done', total: 4, seen: 4, dupes: 0, bodies: 4, body_failed: 0, bodies_due: 0, chunked: 4, embedded: 4, attach_failed: 0, index_errors: 0 },
      { account_id: 'a1', folder: 'Junk', state: 'done', total: 3, seen: 2, dupes: 0, bodies: 3, body_failed: 0, bodies_due: 0, chunked: 2, embedded: 2, attach_failed: 0, index_errors: 0 },
    ];
  });

  it('creates rows for included folders only, with the spam flag', async () => {
    await refreshCoverage();
    const ins = calls.find((c) => /INSERT INTO hedwig_index_coverage/.test(c.sql));
    expect(ins.params[1]).toEqual(['INBOX', 'Junk']);
    expect(ins.params[3]).toEqual([false, true]);
  });

  it('recomputes states from counts instead of trusting the stored state', async () => {
    const res = await refreshCoverage();
    const upd = calls.find((c) => /UPDATE hedwig_index_coverage c SET state = x.state/.test(c.sql));
    expect(upd.params[1]).toEqual(['INBOX', 'Junk']);
    expect(upd.params[2]).toEqual(['done', 'running']);
    expect(res).toMatchObject({ folders: 2, done: 1 });
  });

  it('resets every row when the folder rules change, and not otherwise', async () => {
    await refreshCoverage();
    const resets = () => calls.filter((c) => /UPDATE hedwig_index_coverage\s+SET state = CASE/.test(c.sql)).length;
    expect(resets()).toBe(1); // first run: no stored rules yet
    calls.length = 0;
    await refreshCoverage();
    expect(resets()).toBe(0);
    calls.length = 0;
    process.env.HEDWIG_PIPELINE_EXCLUDE_FOLDERS = '["Archive"]';
    invalidateConfigCache();
    await refreshCoverage();
    expect(resets()).toBe(1);
    expect(state.get('index.coverageRules').hash).toBe(rulesHash({ ...rulesOf({ 'pipeline.excludeSpecialUse': DEFAULT_RULES.excludeSpecialUse, 'index.indexSpamFolder': true }), excludeFolders: ['Archive'] }));
    delete process.env.HEDWIG_PIPELINE_EXCLUDE_FOLDERS;
  });

  it('marks messages due when the recipe changes', async () => {
    await refreshCoverage();
    expect(state.get('index.recipe.global')).toMatchObject({ full: 'v1:hash-1024', version: 'v1' });
    calls.length = 0;
    process.env.HEDWIG_INDEX_RECIPE = 'v2';
    invalidateConfigCache();
    await refreshCoverage();
    const rechunk = calls.find((c) => /SET chunk_version = NULL, embed_recipe = NULL/.test(c.sql));
    expect(rechunk.params).toEqual(['v2']);
    delete process.env.HEDWIG_INDEX_RECIPE;
  });
});
