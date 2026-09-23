import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let handler = () => ({ rows: [] });
vi.mock('../../services/db.js', () => ({
  query: vi.fn(async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [] }; }),
  pool: {},
}));

const { planSlots, extractableAttachments, tikaExtract, TikaUnavailable, makeAttachmentHandler } = await import('./acquire.js');
const { invalidateConfigCache } = await import('../config.js');

describe('planSlots (per-host rate limit)', () => {
  const now = 1_000_000;
  it('spaces requests at the configured rate from now', () => {
    const s = planSlots({ now, rate: 5, want: 3 });
    expect(s.map((d) => d.getTime() - now)).toEqual([0, 200, 400]);
  });
  it('starts after what is already queued for the host', () => {
    const s = planSlots({ now, queuedUntil: new Date(now + 1000), rate: 2, want: 2 });
    expect(s.map((d) => d.getTime() - now)).toEqual([1500, 2000]);
  });
  it('never schedules beyond the horizon, and stops when nothing consumes the queue', () => {
    expect(planSlots({ now, rate: 1, want: 500, horizonSec: 10 })).toHaveLength(11);
    expect(planSlots({ now, rate: 1, want: 5, horizonSec: 10, queuedCount: 20 })).toHaveLength(0);
  });
});

describe('extractableAttachments', () => {
  it('keeps documents with a part number within the size limit', () => {
    const list = [
      { part: '2', filename: 'invoice.pdf', type: 'application/pdf', size: 1000 },
      { part: '3', filename: 'photo.jpg', type: 'image/jpeg', size: 1000 },
      { part: '4', filename: 'contract.docx', type: 'application/octet-stream', size: 1000 },
      { part: '5', filename: 'huge.pdf', type: 'application/pdf', size: 50_000_000 },
      { filename: 'seeded.pdf', type: 'application/pdf', size: 10 },
    ];
    expect(extractableAttachments(list, { maxBytes: 20_000_000 }).map((a) => [a.index, a.filename])).toEqual([[0, 'invoice.pdf'], [2, 'contract.docx']]);
    expect(extractableAttachments(JSON.stringify(list.slice(0, 1)))).toHaveLength(1);
    expect(extractableAttachments(null)).toEqual([]);
  });
});

describe('tikaExtract', () => {
  it('PUTs the bytes to /tika and returns tidy text', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'INVOICE\n\n\n\nTotal 1,840  \n' }));
    const out = await tikaExtract(Buffer.from('%PDF'), { url: 'http://tika:9998/', mime: 'application/pdf', filename: 'a.pdf', fetchFn });
    expect(out).toBe('INVOICE\n\nTotal 1,840');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://tika:9998/tika');
    expect(init).toMatchObject({ method: 'PUT', headers: { Accept: 'text/plain; charset=UTF-8', 'Content-Type': 'application/pdf' } });
  });
  it('distinguishes Tika being down from a document it cannot parse', async () => {
    await expect(tikaExtract(Buffer.from('x'), { url: 'http://t', fetchFn: async () => { throw new Error('ECONNREFUSED'); } })).rejects.toBeInstanceOf(TikaUnavailable);
    await expect(tikaExtract(Buffer.from('x'), { url: 'http://t', fetchFn: async () => ({ ok: false, status: 503, text: async () => '' }) })).rejects.toBeInstanceOf(TikaUnavailable);
    const bad = tikaExtract(Buffer.from('x'), { url: 'http://t', fetchFn: async () => ({ ok: false, status: 422, text: async () => 'unsupported' }) });
    await expect(bad).rejects.toThrow('tika 422');
    await expect(bad).rejects.not.toBeInstanceOf(TikaUnavailable);
  });
});

describe('attachment job', () => {
  const message = { id: 'm1', uid: 42, folder: 'INBOX', account_id: 'acc', attachments: [{ part: '2', filename: 'invoice.pdf', type: 'application/pdf', size: 10 }] };
  beforeEach(() => {
    calls.length = 0;
    invalidateConfigCache();
    process.env.HEDWIG_INDEX_TIKA_ENABLED = 'true';
    handler = (sql) => (/FROM messages m JOIN email_accounts/.test(sql) ? { rows: [message] } : { rows: [] });
  });
  it('fetches parts over IMAP, stores the text and marks the message for re-chunking', async () => {
    const imapManager = { fetchMultipleAttachments: vi.fn(async () => new Map([['2', Buffer.from('%PDF')]])) };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'Total due 1,840' }));
    await makeAttachmentHandler(imapManager, { fetchFn })({ messageId: 'm1' });
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc' }), 42, 'INBOX', [{ part: '2', encoding: undefined }]);
    const insert = calls.find((c) => /INSERT INTO hedwig_attachment_text/.test(c.sql));
    expect(insert.params).toEqual(['m1', 0, 'invoice.pdf', 'application/pdf', '2', 4, 15, 'Total due 1,840', null]);
    const state = calls.find((c) => /SET attach_state = \$2/.test(c.sql));
    expect(state.params.slice(0, 2)).toEqual(['m1', 'done']);
    expect(state.sql).toContain("chunk_version = CASE WHEN $2 = 'done' THEN NULL");
  });
  it('schedules a retry instead of failing when Tika is unreachable', async () => {
    const imapManager = { fetchMultipleAttachments: vi.fn(async () => new Map([['2', Buffer.from('%PDF')]])) };
    await makeAttachmentHandler(imapManager, { fetchFn: async () => { throw new Error('ECONNREFUSED'); } })({ messageId: 'm1' });
    const state = calls.find((c) => /SET attach_state = \$2/.test(c.sql));
    expect(state.params[1]).toBe('retry');
    expect(calls.some((c) => /INSERT INTO hedwig_attachment_text/.test(c.sql))).toBe(false);
  });
  it('does nothing over IMAP when Tika is off', async () => {
    process.env.HEDWIG_INDEX_TIKA_ENABLED = 'false';
    invalidateConfigCache();
    const imapManager = { fetchMultipleAttachments: vi.fn() };
    await makeAttachmentHandler(imapManager)({ messageId: 'm1' });
    expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
    delete process.env.HEDWIG_INDEX_TIKA_ENABLED;
  });
});
