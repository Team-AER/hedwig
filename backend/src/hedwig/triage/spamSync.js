// Keep upstream's spam model learning from Hedwig overrides. When a user moves a message to or
// from the spam list, record the label exactly as upstream's /spam and /ham routes do: a
// spam_training_log row with the features extracted at mark time (so upstream's nightly retrain
// keeps it) plus an incremental update of the per-user Naive Bayes model.
import { query } from '../../services/db.js';
import { tokenize, extractFlagFeatures } from '../../services/spamTokenizer.js';
import { updateIncrementalForUser } from '../../services/spamModelStore.js';

function attachmentTypes(attachments) {
  const out = (attachments || [])
    .map((a) => a?.filename || a?.name)
    .filter(Boolean)
    .map((f) => { const dot = String(f).lastIndexOf('.'); return dot > 0 ? String(f).slice(dot + 1).toLowerCase() : null; })
    .filter(Boolean);
  return out.length ? out : null;
}

/**
 * @param {string} userId
 * @param {string} messageId
 * @param {'spam'|'ham'} label
 * @returns {Promise<boolean>} whether a training record was written
 */
export async function trainUpstreamSpam(userId, messageId, label) {
  if (label !== 'spam' && label !== 'ham') return false;
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.message_id, m.uid, m.folder, m.subject, m.body_text, m.body_html, m.from_email, m.attachments
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId],
  );
  const m = rows[0];
  if (!m) return false;
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  const msg = {
    subject: m.subject || '',
    body: m.body_text || '',
    bodyHtml: m.body_html || '',
    from: m.from_email ? `<${m.from_email}>` : null,
    replyTo: null,
    headers: [],
    attachments,
  };
  const counts = {};
  for (const t of tokenize(msg)) counts[t] = (counts[t] || 0) + 1;
  await query(
    `INSERT INTO spam_training_log
       (user_id, account_id, message_id_header, message_uid, folder, label, source,
        subject, body_text, body_html, token_counts, flag_features, sender_domain, attachment_types)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, $10, $11, $12, $13)`,
    [userId, m.account_id, m.message_id || null, m.uid, m.folder, label, msg.subject, m.body_text || null, m.body_html || null,
      JSON.stringify(counts), JSON.stringify(extractFlagFeatures(msg)),
      m.from_email ? m.from_email.split('@').pop().toLowerCase() : null, attachmentTypes(attachments)],
  );
  await updateIncrementalForUser(userId, msg, label);
  return true;
}
