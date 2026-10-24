import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { query } from '../../services/db.js';
import { emailContent, CONTENT_VERSION } from '../../services/emailContent.js';

// Compatibility fingerprint for the first upgrade only. Later upgrades compare stored hashes.
export function legacyText(row) {
  if (row.body_text) return row.body_text;
  let out = ''; let skip = 0;
  const blocks = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'section', 'article', 'header', 'footer', 'ul', 'ol']);
  const skipped = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);
  const parser = new Parser({
    onopentag(n) { if (skipped.has(n)) skip++; else if (blocks.has(n)) out += '\n'; if (n === 'li') out += '- '; },
    ontext(t) { if (!skip) out += t; },
    onclosetag(n) { if (skipped.has(n)) skip = Math.max(0, skip - 1); else if (blocks.has(n)) out += '\n'; },
  }, { decodeEntities: true });
  parser.write(String(row.body_html || '').slice(0, 2_000_000)); parser.end();
  return out || row.snippet || '';
}

const comparable = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const contentChanged = (row, content) => comparable(legacyText(row)) !== comparable(content.text);
export const contentRowsHash = (rows) => createHash('sha256').update(rows.map((r) => `${r.id}:${emailContent(r).hash}`).join('\n')).digest('hex');

export async function normaliseRows(rows) {
  let changed = 0;
  for (const row of rows) {
    const content = emailContent(row);
    const sourceHash = createHash('sha256').update(JSON.stringify([row.body_text, row.body_html, row.content_metadata || null])).digest('hex');
    const difference = contentChanged(row, content) || Boolean(row.content_metadata?.length);
    const result = await query(
      `INSERT INTO hedwig_email_content (message_id, user_id, version, source_hash, content_hash, text, source, reason, state, links, tables, warnings, tsv, changed)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,to_tsvector('english',LEFT($6,120000)),$13
         WHERE EXISTS (SELECT 1 FROM messages m JOIN email_accounts a ON a.id=m.account_id WHERE m.id=$1 AND a.user_id=$2 AND NOT m.is_deleted)
       ON CONFLICT (message_id) DO UPDATE SET version=EXCLUDED.version, source_hash=EXCLUDED.source_hash,
         content_hash=EXCLUDED.content_hash, text=EXCLUDED.text, source=EXCLUDED.source, reason=EXCLUDED.reason,
         state=EXCLUDED.state, links=EXCLUDED.links, tables=EXCLUDED.tables, warnings=EXCLUDED.warnings, tsv=EXCLUDED.tsv,
         changed=hedwig_email_content.changed OR hedwig_email_content.content_hash<>EXCLUDED.content_hash OR hedwig_email_content.source_hash<>EXCLUDED.source_hash,
         auto_repair=hedwig_email_content.auto_repair OR hedwig_email_content.content_hash<>EXCLUDED.content_hash,
         repair_state=CASE WHEN hedwig_email_content.content_hash<>EXCLUDED.content_hash THEN 'pending' ELSE hedwig_email_content.repair_state END,
         updated_at=NOW() RETURNING changed`,
      [row.id, row.user_id, CONTENT_VERSION, sourceHash, content.hash, content.text, content.source, content.reason, content.state,
        JSON.stringify(content.links), JSON.stringify(content.tables), JSON.stringify(content.warnings), difference],
    );
    if (!result.rowCount) continue;
    if (result.rows[0]?.changed) changed++;
    if (content.state === 'readable') {
      // A snippet is derived, not provider content; replacing it does not invalidate the body hash.
      const snippet = content.text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      await query('UPDATE messages SET snippet=$2 WHERE id=$1 AND snippet IS DISTINCT FROM $2', [row.id, snippet]);
    }
  }
  return { processed: rows.length, changed };
}

export async function normaliseSweep({ limit = 100, messageIds = null } = {}) {
  const { rows } = await query(
    `SELECT m.id,m.body_text,m.body_html,m.snippet,a.user_id,em.data AS content_metadata
       FROM messages m JOIN email_accounts a ON a.id=m.account_id
       LEFT JOIN hedwig_email_content c ON c.message_id=m.id
       LEFT JOIN hedwig_email_metadata em ON em.message_id=m.id
      WHERE NOT m.is_deleted AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL)
        AND ($3::uuid[] IS NULL OR m.id=ANY($3)) AND (c.version IS DISTINCT FROM $1)
      ORDER BY m.date DESC NULLS LAST LIMIT $2`, [CONTENT_VERSION, limit, messageIds],
  );
  return normaliseRows(rows);
}
