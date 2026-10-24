import { query } from './db.js';
import { extractEmailMetadata } from './emailMetadata.js';

// Capture only schema-bearing bodies. Ordinary fetches do no additional database work.
export async function captureMailboxMetadata(accountId, uid, folder, html, { recordEmpty = false } = {}) {
  if (!recordEmpty && !/schema\.org|ld\+json/i.test(String(html || '').slice(0, 262144))) return;
  const data = extractEmailMetadata(html);
  await query(
    `INSERT INTO hedwig_email_metadata (message_id, data)
     SELECT id, $4::jsonb FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND NOT is_deleted
     ON CONFLICT (message_id) DO UPDATE SET data = EXCLUDED.data, captured_at = NOW()`,
    [accountId, uid, folder, JSON.stringify(data)],
  );
  await query(
    `UPDATE hedwig_email_content c SET version = NULL FROM messages m
      WHERE c.message_id = m.id AND m.account_id = $1 AND m.uid = $2 AND m.folder = $3`,
    [accountId, uid, folder],
  );
}
