// Opt-in (spam.autoMove): move confident spam to the account's Junk folder, and move it back when
// the user undoes the move. Runs in the API process (it needs the IMAP engine) and mirrors
// triage/junk.js and upstream's /messages/:id/spam move: guard the UID, move, re-key the row, adjust
// counts, broadcast. It only ever moves; it never deletes mail.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { resolveSpamFolder, resolveAllSpamPaths, adjustFolderCounts } from '../../utils/mailUtils.js';

async function move(imapManager, account, message, target) {
  imapManager._guardMoveUid(account.id, message.folder, message.uid);
  try {
    const newUid = await imapManager.moveMessage(account, message.uid, message.folder, target);
    if (newUid != null) {
      await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4', [account.id, newUid, target, message.id]);
      await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [target, newUid, message.id]);
    } else {
      imapManager._guardMoveUid(account.id, target, message.uid);
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [target, message.id]);
      setTimeout(() => imapManager._unguardMoveUid(account.id, target, message.uid), 10_000);
    }
  } finally {
    imapManager._unguardMoveUid(account.id, message.folder, message.uid);
  }
  const unread = message.is_read ? 0 : 1;
  adjustFolderCounts(account.id, message.folder, -1, -unread);
  adjustFolderCounts(account.id, target, 1, unread);
}

export function makeSpamMoveHandler(imapManager) {
  return async ({ messageId, to = 'junk', folder = null }, job = {}) => {
    const userId = job.user_id;
    if (!messageId || !userId) return { skipped: 'bad payload' };
    const { rows } = await query(
      `SELECT m.id, m.account_id, m.uid, m.folder, m.is_read, m.is_deleted, a.folder_mappings, s.spam, s.stream, s.proposed_stream
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN hedwig_sort s ON s.message_id = m.id AND s.user_id = a.user_id
        WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, userId],
    );
    const message = rows[0];
    if (!message || message.is_deleted) return { skipped: 'message gone' };
    const { rows: accounts } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [message.account_id, userId]);
    const account = accounts[0];
    if (!account) return { skipped: 'account gone' };
    const allSpam = await resolveAllSpamPaths(message.account_id, message.folder_mappings);

    if (to === 'restore') {
      if (!allSpam.has(message.folder)) return { skipped: 'not in junk' };
      const target = folder && !allSpam.has(folder) ? folder : 'INBOX';
      await move(imapManager, account, message, target);
      await query(
        `UPDATE hedwig_sort SET in_spam_folder = false, spam = 'clean', stream = COALESCE(proposed_stream, 'people'), decided_at = NOW()
          WHERE message_id = $1 AND user_id = $2`,
        [messageId, userId],
      );
      imapManager.broadcast({ type: 'folder_updated', folder: target, accountId: account.id }, userId);
      return { moved: true, folder: target };
    }

    const cfg = await getConfig(userId);
    if (!cfg['spam.autoMove']) return { skipped: 'disabled' };
    // The verdict may have changed (a correction, a rescue) between enqueue and now.
    if (!['phishing', 'suspected'].includes(message.spam) || message.stream !== 'spam') return { skipped: 'no longer spam' };
    const spamFolder = await resolveSpamFolder(message.account_id, message.folder_mappings);
    if (!spamFolder) {
      const err = new Error('No spam folder configured for this account');
      err.permanent = true;
      throw err;
    }
    if (message.folder === spamFolder || allSpam.has(message.folder)) return { skipped: 'already in junk' };
    await move(imapManager, account, message, spamFolder);
    await query('UPDATE hedwig_sort SET in_spam_folder = true WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
    imapManager.broadcast({ type: 'folder_updated', folder: spamFolder, accountId: account.id }, userId);
    return { moved: true, folder: spamFolder };
  };
}
