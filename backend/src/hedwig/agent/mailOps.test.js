import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const ACC = '44444444-4444-4444-8444-444444444444';

const db = vi.hoisted(() => {
  const state = { message: null, folders: [], aliases: [], sql: [] };
  const res = (rows, rowCount = rows.length) => ({ rows, rowCount });
  async function query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    state.sql.push({ sql, params });
    if (sql.startsWith('SELECT m.*, a.user_id FROM messages m')) {
      const m = state.message;
      return res(m && m.id === params[0] && m.user_id === params[1] ? [{ ...m }] : []);
    }
    if (sql.startsWith('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2')) {
      return res(params[1] === '11111111-1111-4111-8111-111111111111'
        ? [{ id: params[0], user_id: params[1], name: 'Work', sender_name: 'Pat Doe', email_address: 'pat@work.example', signature: '<b>Pat</b>', folder_mappings: {} }]
        : []);
    }
    if (sql.startsWith('SELECT path, special_use FROM folders')) return res(state.folders.filter((f) => f.path === params[1]));
    if (sql.includes("special_use = '\\Drafts'")) return res([{ path: 'Drafts' }]);
    if (sql.includes('FROM email_accounts WHERE user_id = $1 UNION')) return res([{ e: 'pat@work.example' }]);
    if (sql.startsWith('SELECT name, email, signature FROM account_aliases')) return res(state.aliases);
    if (sql.startsWith('UPDATE messages SET folder')) return res([], 1);
    if (sql.includes("special_use = '\\All'")) return res([]);
    return res([]);
  }
  return { state, query };
});

const engine = vi.hoisted(() => ({ current: null }));

vi.mock('../../services/db.js', () => ({ query: db.query, pool: {} }));
vi.mock('../../plugins/mailEngine.js', () => ({ getMailEngine: () => { if (!engine.current) throw new Error('no engine'); return engine.current; } }));
vi.mock('../../plugins/registry.js', () => ({ pluginRegistry: { hasActiveAsync: async () => false, runHook: async () => [] } }));
vi.mock('../../utils/mailUtils.js', () => ({
  resolveArchiveFolder: async () => 'Archive',
  isAllMailFolder: async () => false,
  adjustFolderCounts: vi.fn(),
  fanOutReadToSiblings: vi.fn(),
  fanOutStarToSiblings: vi.fn(),
}));

const ops = await import('./mailOps.js');

function fakeEngine() {
  return {
    moveMessage: vi.fn(async () => 901),
    setFlag: vi.fn(async () => {}),
    appendToFolder: vi.fn(async () => ({ uid: 77, folder: 'Drafts' })),
    upsertDraftMessageRecord: vi.fn(async () => {}),
    ensureFolder: vi.fn(async () => ({ path: 'Snoozed' })),
    broadcast: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    // Anything that could send or expunge must never be reached.
    permanentDeleteMessage: vi.fn(),
    sendMail: vi.fn(),
  };
}

beforeEach(() => {
  engine.current = fakeEngine();
  db.state.sql = [];
  db.state.aliases = [];
  db.state.folders = [{ path: 'Projects', special_use: null }, { path: 'Trash', special_use: '\\Trash' }, { path: 'Old/Junk', special_use: null }];
  db.state.message = {
    id: MSG, user_id: USER, account_id: ACC, uid: 42, folder: 'INBOX', is_read: false, is_starred: false,
    message_id: '<orig@x.example>', thread_references: '<root@x.example>', subject: 'Invoice 2041',
    from_name: 'Marta', from_email: 'marta@k.example', reply_to: [], to_addresses: [{ address: 'pat@work.example' }],
    cc_addresses: [{ address: 'bookkeeping@k.example', name: 'Books' }], date: new Date('2026-09-22T10:00:00Z'),
    body_text: 'Please find invoice 2041 attached: €1,840.',
  };
});

describe('ownership', () => {
  it('refuses a message that belongs to someone else, before touching the engine', async () => {
    await expect(ops.archiveMessage(OTHER, { messageId: MSG })).rejects.toThrow('message not found');
    await expect(ops.draftReply(OTHER, { messageId: MSG, body: 'hi' })).rejects.toThrow('message not found');
    await expect(ops.markRead(USER, { messageId: 'not-a-uuid' })).rejects.toThrow(/message id/);
    expect(engine.current.moveMessage).not.toHaveBeenCalled();
    expect(engine.current.appendToFolder).not.toHaveBeenCalled();
  });

  it('needs the mail engine (API process) to change anything', async () => {
    engine.current = null;
    expect(ops.engineAvailable()).toBe(false);
    await expect(ops.markRead(USER, { messageId: MSG, read: true })).rejects.toThrow('no engine');
  });
});

describe('moves', () => {
  it('moves with the guard protocol and repoints the row', async () => {
    const out = await ops.moveMessage(USER, { messageId: MSG, folder: 'Projects' });
    const e = engine.current;
    expect(out).toMatchObject({ moved: true, from: 'INBOX', to: 'Projects' });
    expect(e.moveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACC }), 42, 'INBOX', 'Projects');
    expect(e._guardMoveUid).toHaveBeenCalledWith(ACC, 'INBOX', 42);
    expect(e._unguardMoveUid).toHaveBeenCalledWith(ACC, 'INBOX', 42);
    const upd = db.state.sql.find((q) => q.sql.startsWith('UPDATE messages SET folder'));
    expect(upd.params).toEqual(['Projects', 901, MSG, 'INBOX']);
  });

  it('refuses destinations that amount to deleting', async () => {
    await expect(ops.moveMessage(USER, { messageId: MSG, folder: 'Trash' })).rejects.toThrow(/cannot move mail to Trash/);
    await expect(ops.moveMessage(USER, { messageId: MSG, folder: 'Old/Junk' })).rejects.toThrow(/cannot move mail to Trash/);
    await expect(ops.moveMessage(USER, { messageId: MSG, folder: 'Nowhere' })).rejects.toThrow(/does not exist/);
    expect(engine.current.moveMessage).not.toHaveBeenCalled();
  });

  it('releases the source guard when the IMAP move fails', async () => {
    engine.current.moveMessage.mockRejectedValueOnce(new Error('NO [TRYCREATE]'));
    await expect(ops.moveMessage(USER, { messageId: MSG, folder: 'Projects' })).rejects.toThrow('TRYCREATE');
    expect(engine.current._unguardMoveUid).toHaveBeenCalledWith(ACC, 'INBOX', 42);
    expect(db.state.sql.some((q) => q.sql.startsWith('UPDATE messages SET folder'))).toBe(false);
  });
});

describe('flags', () => {
  it('writes the flag locally and to IMAP, queueing a retry when IMAP fails', async () => {
    engine.current.setFlag.mockRejectedValueOnce(new Error('connection lost'));
    const out = await ops.markRead(USER, { messageId: MSG, read: true });
    expect(out).toMatchObject({ is_read: true, changed: true });
    expect(engine.current.setFlag).toHaveBeenCalledWith(expect.anything(), 42, 'INBOX', '\\Seen', true);
    expect(engine.current._enqueueFlagPush).toHaveBeenCalledWith(ACC, MSG, '\\Seen', true);
  });
});

describe('snooze', () => {
  it('validates the time window', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(() => ops.checkSnoozeUntil('2026-09-23T09:00:00Z', now)).toThrow(/future/);
    expect(() => ops.checkSnoozeUntil('2026-11-30T09:00:00Z', now)).toThrow(/within 30 days/);
    expect(() => ops.checkSnoozeUntil('soon', now)).toThrow(/ISO 8601/);
    expect(ops.checkSnoozeUntil('2026-09-24T08:00:00+02:00', now).toISOString()).toBe('2026-09-24T06:00:00.000Z');
  });
});

describe('reply drafts', () => {
  it('works out reply and reply-all recipients without the user', () => {
    const own = new Set(['pat@work.example']);
    const m = db.state.message;
    expect(ops.replyRecipients(m, own)).toEqual({ to: [{ email: 'marta@k.example', name: 'Marta' }], cc: [] });
    expect(ops.replyRecipients(m, own, { replyAll: true }).cc).toEqual([{ email: 'bookkeeping@k.example', name: 'Books' }]);
    expect(ops.replyRecipients({ ...m, reply_to: [{ address: 'billing@k.example' }] }, own).to).toEqual([{ email: 'billing@k.example', name: null }]);
    // Replying to your own message continues to its recipients.
    expect(ops.replyRecipients({ ...m, from_email: 'pat@work.example', to_addresses: [{ address: 'ops@work.example' }] }, own).to)
      .toEqual([{ email: 'ops@work.example', name: null }]);
    expect(ops.replySubject('Re: Invoice')).toBe('Re: Invoice');
    expect(ops.replySubject('Invoice\r\nBcc: evil@x')).toBe('Re: Invoice  Bcc: evil@x');
  });

  it('appends a threaded reply draft to Drafts and never sends', async () => {
    const out = await ops.draftReply(USER, { messageId: MSG, body: 'Thanks Marta, the quote was €1,600 — could you check?' });
    const e = engine.current;
    expect(out.draft).toMatchObject({ folder: 'Drafts', uid: 77, subject: 'Re: Invoice 2041', to: ['marta@k.example'] });
    expect(e.appendToFolder).toHaveBeenCalledOnce();
    const [, folder, raw, flags] = e.appendToFolder.mock.calls[0];
    expect(folder).toBe('Drafts');
    expect(flags).toEqual(['\\Draft', '\\Seen']);
    const mime = raw.toString('utf8');
    expect(mime).toMatch(/^In-Reply-To: <orig@x\.example>$/m);
    expect(mime).toMatch(/^References: <root@x\.example> <orig@x\.example>$/m);
    expect(mime).toMatch(/^To: Marta <marta@k\.example>$/m);
    expect(mime).toMatch(/^From: Pat Doe <pat@work\.example>$/m);
    expect(e.upsertDraftMessageRecord).toHaveBeenCalledWith(expect.anything(), 'Drafts', 77, expect.objectContaining({
      subject: 'Re: Invoice 2041', inReplyTo: '<orig@x.example>', to: [{ name: 'Marta', email: 'marta@k.example' }],
      bodyHtml: expect.stringContaining('<div data-mailflow-signature="1"'),
      bodyText: expect.stringMatching(/^Thanks Marta.*\n\n-- \nPat\n\nOn .* wrote:\n> Please find invoice 2041/s),
    }));
    expect(e.sendMail).not.toHaveBeenCalled();
    expect(e.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('replies from the alias the message was sent to', async () => {
    db.state.aliases = [{ name: 'Pat (billing)', email: 'billing@work.example', signature: null }];
    db.state.message.to_addresses = [{ address: 'billing@work.example' }];
    await ops.draftReply(USER, { messageId: MSG, body: 'On it.' });
    const mime = engine.current.appendToFolder.mock.calls[0][2].toString('utf8');
    expect(mime).toMatch(/^From: "Pat \(billing\)" <billing@work\.example>$/m);
  });
});
