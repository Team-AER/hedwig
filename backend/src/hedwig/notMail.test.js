import { describe, it, expect } from 'vitest';
import { noSender, notMailReason } from './notMail.js';

describe('notMail', () => {
  const standIn = { from_email: '@.MISSING-HOST-NAME.', folder: 'Calendar', special_use: null };

  it('recognises IMAP\'s stand-in for a From with no address', () => {
    expect(noSender(standIn)).toBe(true);
    expect(noSender({ from_email: ' @.missing-host-name. ' })).toBe(true);
    expect(noSender({ from_email: 'ana@example.com' })).toBe(false);
    expect(noSender({ from_email: null })).toBe(false);
  });

  it('calls it not mail anywhere but the Inbox', () => {
    expect(notMailReason(standIn)).toBe('not mail');
    expect(notMailReason({ ...standIn, folder: 'Calendar/United States holidays' })).toBe('not mail');
    expect(notMailReason({ ...standIn, folder: 'Deleted Items', special_use: '\\Trash' })).toBe('not mail');
    expect(notMailReason({ ...standIn, folder: 'INBOX', special_use: '\\Inbox' })).toBeNull();
    expect(notMailReason({ ...standIn, folder: 'Posteingang', special_use: '\\Inbox' })).toBeNull();
    expect(notMailReason({ from_email: 'ana@example.com', folder: 'Calendar' })).toBeNull();
  });
});
