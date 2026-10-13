-- Exchange serves each calendar entry it cannot turn into mail as a "Retrieval using the IMAP4
-- protocol failed" notice with no sender address (from_email "@.MISSING-HOST-NAME.", see
-- src/hedwig/notMail.js). A Microsoft 365 account added on 2026-10-13 brought 1,070 of them from
-- Calendar folders into the Screener under one sender no decision could be made on ("Invalid
-- address key"). Outside the Inbox they are not mail: record them as skipped and take them out of
-- the streams and the search index. Only Hedwig's own derived rows change; the messages stay.
UPDATE hedwig_msg h SET skip_reason = 'not mail'
  FROM messages m LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
 WHERE h.message_id = m.id
   AND lower(trim(m.from_email)) = '@.missing-host-name.'
   AND COALESCE(f.special_use, '') <> '\Inbox' AND upper(m.folder) <> 'INBOX';

DELETE FROM hedwig_sort s USING hedwig_msg h
 WHERE s.message_id = h.message_id AND h.skip_reason = 'not mail';

DELETE FROM hedwig_chunks c USING hedwig_msg h
 WHERE c.message_id = h.message_id AND h.skip_reason = 'not mail';

DELETE FROM hedwig_triage t USING hedwig_msg h
 WHERE t.message_id = h.message_id AND h.skip_reason = 'not mail';
