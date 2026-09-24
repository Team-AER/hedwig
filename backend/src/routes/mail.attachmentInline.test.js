import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchAttachment: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let ctx;
beforeEach(async () => {
  query.mockReset();
  imapManager.fetchAttachment.mockReset();
  if (!ctx) ctx = await startServer();
});
afterAll(() => ctx?.server?.close());

function mockAttachment(att) {
  query
    .mockResolvedValueOnce({ rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 7, folder: 'INBOX', user_id: 'user-1', attachments: [att] }] })
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
    .mockResolvedValue({ rows: [] });
  imapManager.fetchAttachment.mockResolvedValue(Buffer.from('bytes'));
}

const url = (inline) => `${ctx.base}/api/mail/messages/${MESSAGE_ID}/attachments/2${inline ? '?inline=1' : ''}`;

describe('GET /messages/:id/attachments/:part?inline=1', () => {
  it('serves a picture inline, as the type its extension vouches for, under a sandbox CSP', async () => {
    mockAttachment({ part: '2', filename: 'Picture1.jpg', type: 'application/octet-stream', size: 5 });
    const res = await fetch(url(true));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="Picture1.jpg"/);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox/);
  });

  it('serves a PDF inline for the browser viewer', async () => {
    mockAttachment({ part: '2', filename: 'statement.pdf', type: 'application/pdf', size: 5 });
    const res = await fetch(url(true));
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('an SVG or HTML file still downloads, even when asked inline', async () => {
    mockAttachment({ part: '2', filename: 'logo.svg', type: 'image/svg+xml', size: 5 });
    const res = await fetch(url(true));
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('without ?inline=1 nothing changes: the declared type and an attachment disposition', async () => {
    mockAttachment({ part: '2', filename: 'Picture1.jpg', type: 'image/jpeg', size: 5 });
    const res = await fetch(url(false));
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});
