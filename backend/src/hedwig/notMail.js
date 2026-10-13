// Messages with no sender address. IMAP stands in for a From with no address with an empty mailbox
// at the host ".MISSING-HOST-NAME." (RFC 3501 envelopes), so the row's from_email is exactly
// "@.MISSING-HOST-NAME.". Exchange serves every calendar entry (and other item) it cannot turn into
// mail as a "Retrieval using the IMAP4 protocol failed" notice from that sender, one per entry, in
// folders such as Calendar. Outside the Inbox such a message is not mail: Hedwig records it as
// skipped and never sorts, screens or indexes it. In the Inbox it stands for a real email Exchange
// could not convert, and is sorted to People with a pointer to Outlook (sort/engine.js).
export const NO_SENDER = '@.missing-host-name.';

export const noSender = (row) => String(row?.from_email || '').trim().toLowerCase() === NO_SENDER;

const inInbox = (row) => row?.special_use === '\\Inbox' || String(row?.folder || '').toUpperCase() === 'INBOX';

/** 'not mail' for a row Hedwig should leave alone, else null. */
export function notMailReason(row) {
  return noSender(row) && !inInbox(row) ? 'not mail' : null;
}
