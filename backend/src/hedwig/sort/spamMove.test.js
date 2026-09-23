import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { message: null, calls: [], cfg: { 'spam.autoMove': true } };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    state.calls.push({ sql, params });
    if (/FROM messages m JOIN email_accounts a/.test(sql)) return { rows: state.message ? [state.message] : [] };
    if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acc' }] };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => state.cfg) }));
vi.mock('../../utils/mailUtils.js', () => ({
  resolveSpamFolder: vi.fn(async () => 'Junk'),
  resolveAllSpamPaths: vi.fn(async () => new Set(['Junk'])),
  adjustFolderCounts: vi.fn(),
}));

const { makeSpamMoveHandler } = await import('./spamMove.js');

function engine() {
  return {
    moveMessage: vi.fn(async () => 77),
    _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
  };
}

const JOB = { user_id: 'u1' };

describe('opt-in spam move', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.cfg = { 'spam.autoMove': true };
    state.message = { id: 'm1', account_id: 'acc', uid: 5, folder: 'INBOX', is_read: false, is_deleted: false, spam: 'phishing', stream: 'spam' };
  });

  it('moves confident spam to Junk, re-keys the row, and never deletes it', async () => {
    const imap = engine();
    const res = await makeSpamMoveHandler(imap)({ messageId: 'm1', to: 'junk' }, JOB);
    expect(res).toEqual({ moved: true, folder: 'Junk' });
    expect(imap.moveMessage).toHaveBeenCalledWith({ id: 'acc' }, 5, 'INBOX', 'Junk');
    expect(state.calls.some((c) => /UPDATE messages SET folder = \$1, uid = \$2 WHERE id = \$3/.test(c.sql) && c.params[0] === 'Junk' && c.params[1] === 77)).toBe(true);
    // The only DELETE is upstream's stale-row cleanup at the destination UID, never this message.
    const deletes = state.calls.filter((c) => /DELETE/.test(c.sql));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/id != \$4/);
    expect(deletes[0].params[3]).toBe('m1');
  });

  it('does nothing when the user has not opted in, or the verdict changed since', async () => {
    state.cfg = { 'spam.autoMove': false };
    const imap = engine();
    expect(await makeSpamMoveHandler(imap)({ messageId: 'm1', to: 'junk' }, JOB)).toEqual({ skipped: 'disabled' });
    state.cfg = { 'spam.autoMove': true };
    state.message = { ...state.message, spam: 'rescued', stream: 'people' };
    expect(await makeSpamMoveHandler(imap)({ messageId: 'm1', to: 'junk' }, JOB)).toEqual({ skipped: 'no longer spam' });
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });

  it('undo moves the message back to the folder it came from', async () => {
    state.message = { ...state.message, folder: 'Junk', uid: 77 };
    const imap = engine();
    const res = await makeSpamMoveHandler(imap)({ messageId: 'm1', to: 'restore', folder: 'Archive' }, JOB);
    expect(res).toEqual({ moved: true, folder: 'Archive' });
    expect(imap.moveMessage).toHaveBeenCalledWith({ id: 'acc' }, 77, 'Junk', 'Archive');
  });
});
