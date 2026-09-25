// The analysis window (analysis.historyDays) on the context steps, and the catch-up that brings the
// model steps to history the scanner only gave the cheap steps.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let userSettings = {};
let catchUpRows = [];
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM hedwig_user_settings/.test(sql)) return { rows: [{ settings: userSettings[params[0]] || {} }] };
    if (/SELECT DISTINCT user_id FROM email_accounts/.test(sql)) return { rows: [{ user_id: 'u1' }] };
    if (/h\.topic_at IS NULL/.test(sql)) return { rows: catchUpRows };
    return { rows: [] };
  }),
}));

const steps = { embed: vi.fn(async () => {}), topics: vi.fn(async () => {}), extract: vi.fn(async () => {}) };
vi.mock('./embed.js', () => ({ runEmbedStep: (rows) => steps.embed(rows) }));
vi.mock('./topics.js', () => ({ runTopicsStep: (rows) => steps.topics(rows) }));
vi.mock('./extract.js', () => ({ runExtractStep: (rows) => steps.extract(rows) }));

const { invalidateConfigCache } = await import('../config.js');
const { analysisGroups } = await import('./entities.js');
const { analysisCatchUp } = await import('./history.js');

const DAY = 86400_000;
const msg = (id, daysAgo, extra = {}) => ({ id, user_id: 'u1', account_id: 'a1', date: new Date(Date.now() - daysAgo * DAY).toISOString(), ...extra });

beforeEach(() => {
  calls.length = 0;
  userSettings = {};
  catchUpRows = [];
  for (const s of Object.values(steps)) { s.mockReset(); s.mockResolvedValue(); }
  invalidateConfigCache();
});

describe('analysisGroups', () => {
  it('passes all mail by default and cuts each user to their own window', async () => {
    const rows = [msg('new', 2), msg('old', 3000), msg('b-new', 2, { user_id: 'u2' }), msg('b-old', 400, { user_id: 'u2' })];
    userSettings.u2 = { 'analysis.historyDays': 365 };
    const groups = await analysisGroups(rows);
    expect(groups.map((g) => [g.userId, g.rows.map((r) => r.id)])).toEqual([['u1', ['new', 'old']], ['u2', ['b-new']]]);
  });

  it('skips users whose context engine is off', async () => {
    userSettings.u1 = { 'features.context': false };
    expect(await analysisGroups([msg('x', 1)])).toEqual([]);
  });
});

describe('analysisCatchUp', () => {
  const catchUpQuery = () => calls.find((c) => /h\.topic_at IS NULL/.test(c.sql));

  it('asks for all history by default and runs embed (only where missing), topics and extract', async () => {
    catchUpRows = [msg('m1', 900, { h_embedded_at: null }), msg('m2', 1200, { h_embedded_at: new Date().toISOString() })];
    expect(await analysisCatchUp({ limit: 10 })).toBe(2);
    expect(catchUpQuery().params).toEqual(['u1', 10, 0]);
    expect(steps.embed.mock.calls[0][0].map((r) => r.id)).toEqual(['m1']);
    expect(steps.topics.mock.calls[0][0].map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(steps.extract.mock.calls[0][0].map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it("uses the user's window", async () => {
    userSettings.u1 = { 'analysis.historyDays': 90 };
    await analysisCatchUp();
    expect(catchUpQuery().params[2]).toBe(90);
    expect(catchUpQuery().sql).toMatch(/\$3::int = 0 OR m\.date >= NOW\(\) - make_interval\(days => \$3::int\)/);
  });

  it('retries the batch later when embedding fails, and records a topics failure so it is not picked again', async () => {
    catchUpRows = [msg('m1', 900)];
    steps.embed.mockRejectedValueOnce(new Error('provider down'));
    await analysisCatchUp();
    expect(steps.topics).not.toHaveBeenCalled();
    expect(calls.some((c) => /SET error/.test(c.sql))).toBe(false);

    steps.topics.mockRejectedValueOnce(new Error('boom'));
    await analysisCatchUp();
    const recorded = calls.find((c) => /SET error/.test(c.sql));
    expect(recorded.params).toEqual([['m1'], 'topics: boom']);
    expect(steps.extract).toHaveBeenCalledTimes(1);
    expect(catchUpQuery().sql).toMatch(/h\.error !~ '\(\^\|; \)\(topics\|extract\):'/);
  });

  it('does nothing for a user with the context engine off', async () => {
    userSettings.u1 = { 'features.context': false };
    catchUpRows = [msg('m1', 900)];
    expect(await analysisCatchUp()).toBe(0);
    expect(catchUpQuery()).toBeUndefined();
  });
});
