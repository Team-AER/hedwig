import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { foldBodyRows, shareOf } = await import('./truth.js');

describe('real-body coverage (one number for health, /index/status and onboarding)', () => {
  it('folds reasons per folder, per account and in total; duplicates are outside the denominator', () => {
    const out = foldBodyRows([
      { account_id: 'a1', folder: 'Archive', spam: false, reason: 'real', n: 5145 },
      { account_id: 'a1', folder: 'Archive', spam: false, reason: 'no_text', n: 29 },
      { account_id: 'a1', folder: 'Archive', spam: false, reason: 'duplicate', n: 1 },
      { account_id: 'a1', folder: 'Sent', spam: false, reason: 'real', n: 134 },
      { account_id: 'a1', folder: 'Sent', spam: false, reason: 'server_empty', n: 8 },
      { account_id: 'a1', folder: 'Sent', spam: false, reason: 'duplicate', n: 5 },
      { account_id: 'a2', folder: 'INBOX', spam: false, reason: 'waiting', n: 10 },
    ]);
    expect(out).toMatchObject({ total: 5332, indexable: 5326, real: 5279 });
    expect(out.reasons).toEqual({ duplicate: 6, fetch_failed: 0, server_empty: 8, waiting: 10, not_indexed: 0, no_text: 29 });
    expect(out.share).toBeCloseTo(5279 / 5326, 4);
    const sent = out.byFolder.find((f) => f.folder === 'Sent');
    expect(sent).toMatchObject({ real: 134, indexable: 142, reasons: expect.objectContaining({ server_empty: 8, duplicate: 5 }) });
    expect(out.byAccount.find((a) => a.accountId === 'a2')).toMatchObject({ real: 0, indexable: 10, share: 0 });
    expect(foldBodyRows([])).toMatchObject({ total: 0, real: 0, share: null });
  });

  it('coverage share: embedded over indexable, spam folder aside; complete means every folder done', () => {
    const rows = [
      { spam: false, state: 'running', total: 5175, dupes: 1, chunked: 5174, embedded: 3400 },
      { spam: false, state: 'done', total: 303, dupes: 0, chunked: 303, embedded: 303 },
      { spam: true, state: 'running', total: 830, dupes: 0, chunked: 10, embedded: 0 },
    ];
    expect(shareOf(rows)).toEqual({ share: Math.round((3703 / 5477) * 10000) / 10000, indexed: 3703, total: 5477, complete: false });
    expect(shareOf(rows, { vectors: false }).indexed).toBe(5477);
    expect(shareOf(rows.map((r) => ({ ...r, state: 'done' }))).share).toBe(1);
    expect(shareOf([])).toEqual({ share: null, indexed: 0, total: 0, complete: false });
  });
});
