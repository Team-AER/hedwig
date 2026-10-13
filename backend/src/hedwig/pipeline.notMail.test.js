// The pipeline's first look at new mail: Exchange's stand-ins for calendar entries (no sender
// address, outside the Inbox) are recorded as skipped and never reach a step.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: [], inserted: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/WHERE h\.message_id IS NULL AND m\.is_deleted = false AND a\.enabled = true\s+AND m\.date >= NOW\(\) - INTERVAL '3 days'/.test(sql)) return { rows: db.rows };
    if (/INSERT INTO hedwig_msg/.test(sql)) { db.inserted = params; return { rows: [] }; }
    return { rows: [] };
  }),
  pool: {},
}));
vi.mock('./config.js', async (orig) => {
  const real = await orig();
  const defaults = Object.fromEntries(real.SCHEMA.map((f) => [f.key, f.default]));
  return { ...real, getConfig: vi.fn(async () => ({ ...defaults, enabled: true })) };
});
vi.mock('./indexer/coverage.js', () => ({
  maybeRefreshCoverage: vi.fn(async () => {}), historyPending: vi.fn(async () => false), resetCoverage: vi.fn(), coverageSummary: vi.fn(),
}));
vi.mock('./state.js', () => ({ setState: vi.fn(async () => {}), getState: vi.fn(async () => null) }));

const { scanOnce, defineStep, _resetSteps } = await import('./pipeline.js');

const USER = '11111111-1111-4111-8111-111111111111';
const row = (id, over) => ({
  id, account_id: 'acc', user_id: USER, message_id: `<${id}@x>`, folder: 'INBOX', special_use: '\\Inbox',
  from_email: 'ana@example.com', subject: 'Hi', date: new Date(), ...over,
});

describe('pipeline: not mail', () => {
  let ran;
  beforeEach(() => {
    _resetSteps();
    ran = [];
    defineStep({ name: 'probe', order: 1, run: async (rows) => { ran.push(...rows.map((r) => r.id)); } });
  });

  it('skips Exchange\'s calendar stand-ins and runs every step on real mail', async () => {
    db.rows = [
      row('real'),
      row('calendar', { folder: 'Calendar', special_use: null, from_email: '@.MISSING-HOST-NAME.', message_id: null }),
      row('inbox-stand-in', { from_email: '@.MISSING-HOST-NAME.', message_id: null }),
    ];
    await scanOnce();
    const [ids, , , skips] = db.inserted;
    expect(Object.fromEntries(ids.map((id, i) => [id, skips[i]]))).toEqual({ real: null, calendar: 'not mail', 'inbox-stand-in': null });
    expect(ran.sort()).toEqual(['inbox-stand-in', 'real']);
  });
});
