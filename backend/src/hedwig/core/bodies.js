// Message bodies for the pipeline. Many providers (Gmail especially) sync headers and a snippet
// only; the body arrives when someone opens the message. Hedwig asks the API process — which holds
// the IMAP engine — to fetch missing bodies through the job queue, rate-limited by the queue itself.
import { query } from '../../services/db.js';
import { sanitizeEmail } from '../../services/emailSanitizer.js';
import { snippetFromBody } from '../../services/messageParser.js';
import { enqueue } from '../jobs.js';

const stripNul = (v) => (typeof v === 'string' ? v.replace(/\0/g, '') : v);

/** Ask the API process to fetch a body. Deduplicated per message. */
export function requestBody(messageId, { priority = 7 } = {}) {
  return enqueue('mail.fetchBody', { messageId }, { dedupeKey: `body:${messageId}`, priority, maxAttempts: 3 });
}

/** Job handler, runs in the API process. */
export function makeFetchBodyHandler(imapManager) {
  return async ({ messageId }) => {
    const { rows } = await query(
      `SELECT m.id, m.uid, m.folder, m.body_text, m.body_html, a.* , m.account_id
         FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1`,
      [messageId],
    );
    const row = rows[0];
    if (!row || row.body_text || row.body_html) return;
    const account = { ...row, id: row.account_id };
    const { html, text, attachments } = await imapManager.fetchMessageBody(account, row.uid, row.folder);
    const safeHtml = html ? stripNul(sanitizeEmail(html)) : null;
    const safeText = stripNul(text);
    if (!safeHtml && !safeText) return;
    const snip = stripNul(snippetFromBody(safeText, safeHtml || html));
    await query(
      `UPDATE messages SET body_html = COALESCE(body_html, $1), body_text = COALESCE(body_text, $2),
              attachments = CASE WHEN attachments IS NULL OR attachments = '[]'::jsonb THEN $3::jsonb ELSE attachments END,
              snippet = CASE WHEN $5 <> '' AND (snippet IS NULL OR snippet = '') THEN $5 ELSE snippet END
        WHERE id = $4`,
      [safeHtml, safeText, JSON.stringify(attachments || []), messageId, snip || ''],
    );
  };
}
