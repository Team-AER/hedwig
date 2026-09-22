// Optional: when the user has triage.pushJunkToProvider on and moves a message to spam, move it
// to the account's Junk folder too, so the provider's filter learns and other clients agree.
// Runs in the API process (it needs the IMAP engine) and mirrors upstream's /messages/:id/spam
// move in routes/mail.js: guard the UID, move, re-key the row, adjust counts, broadcast. It only
// ever moves; it never deletes mail.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { resolveSpamFolder, resolveAllSpamPaths, adjustFolderCounts } from '../../utils/mailUtils.js';

export function makePushJunkHandler(imapManager) {
  return async ({ messageId }, job = {}) => {
    const userId = job.user_id;
    if (!messageId || !userId) return { skipped: 'bad payload' };
    const cfg = await getConfig(userId);
    if (!cfg['triage.pushJunkToProvider']) return { skipped: 'disabled' };

    const { rows } = await query(
      `SELECT m.id, m.account_id, m.uid, m.folder, m.is_read, m.is_deleted, a.folder_mappings,
              COALESCE(CASE WHEN t.overridden THEN t.override_category END, t.category) AS triage_category
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN hedwig_triage t ON t.message_id = m.id AND t.user_id = a.user_id
        WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, userId],
    );
    const message = rows[0];
    if (!message || message.is_deleted) return { skipped: 'message gone' };
    // The user may have changed their mind between the override and this job running.
    if (message.triage_category !== 'spam') return { skipped: 'no longer spam' };

    const spamFolder = await resolveSpamFolder(message.account_id, message.folder_mappings);
    if (!spamFolder) {
      const err = new Error('No spam folder configured for this account');
      err.permanent = true;
      throw err;
    }
    const allSpam = await resolveAllSpamPaths(message.account_id, message.folder_mappings);
    if (message.folder === spamFolder || allSpam.has(message.folder)) return { skipped: 'already in junk' };

    const { rows: accounts } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [message.account_id, userId]);
    const account = accounts[0];
    if (!account) return { skipped: 'account gone' };

    imapManager._guardMoveUid(account.id, message.folder, message.uid);
    let newUid;
    try {
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, spamFolder);
      if (newUid != null) {
        // Same as upstream: drop a stale row already occupying the destination UID, then re-key.
        await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
          [account.id, newUid, spamFolder, messageId]);
        await query(
          `UPDATE messages SET folder = $1, uid = $2, spam_user_override = 'spam', spam_verdict = 'spam', spam_analyzed_at = NOW()
            WHERE id = $3`,
          [spamFolder, newUid, messageId],
        );
      } else {
        // Non-UIDPLUS server: the DB keeps the source UID at the destination until the next sync.
        imapManager._guardMoveUid(account.id, spamFolder, message.uid);
        await query(
          `UPDATE messages SET folder = $1, spam_user_override = 'spam', spam_verdict = 'spam', spam_analyzed_at = NOW()
            WHERE id = $2`,
          [spamFolder, messageId],
        );
        setTimeout(() => imapManager._unguardMoveUid(account.id, spamFolder, message.uid), 10_000);
      }
    } finally {
      imapManager._unguardMoveUid(account.id, message.folder, message.uid);
    }
    const unread = message.is_read ? 0 : 1;
    adjustFolderCounts(account.id, message.folder, -1, -unread);
    adjustFolderCounts(account.id, spamFolder, 1, unread);
    await query('UPDATE hedwig_triage SET resolved_at = COALESCE(resolved_at, NOW()) WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
    imapManager.broadcast({ type: 'folder_updated', folder: spamFolder, accountId: account.id }, userId);
    return { moved: true, folder: spamFolder };
  };
}
