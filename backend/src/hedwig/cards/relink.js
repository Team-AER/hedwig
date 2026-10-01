// Cards whose mail moved. Upstream deletes a message's row when the message moves to another folder
// (the owner's phone files a bank alert to Trash) and syncs the copy there as a new row with a new
// id, so a card's link (message_id, ON DELETE SET NULL) is lost and its row no longer opens anything
// (2026-10-01: 41 of 463 receipts and invoices). The moved copy is found again by the sentences the
// card kept, near the card's date, and the card is pointed at it.
import { query } from '../../services/db.js';

const DAY = 86400_000;
const alnum = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const MSG_KEY = /^msg:([0-9a-f-]{36})/;

/** The quotes a card kept that are long enough to identify its mail, longest first. Pure. */
export function cardQuotes(card) {
  const out = new Set();
  for (const src of Object.values(card?.sources || {})) {
    const q = src && typeof src === 'object' ? alnum(src.quote) : '';
    if (q.length >= 12) out.add(q);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The day a card is about, as a time, or null. Pure. */
export function cardDay(card) {
  const f = card?.fields || {};
  const d = f.date || f.issuedDate || f.lastCharged || null;
  const t = d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The message an orphaned card came from, among candidate rows: every kept quote must occur in the
 * row's text (two at most are checked), and the row must be within three days of the card's date
 * when the card has one. The closest in time wins. Pure.
 * @param {{ fields, sources }} card
 * @param {{ id, date, subject?, body_text?, snippet? }[]} rows
 */
export function matchOrphan(card, rows) {
  const quotes = cardQuotes(card).slice(0, 2);
  if (!quotes.length) return null;
  const day = cardDay(card);
  let best = null;
  for (const r of rows || []) {
    const t = r.date ? new Date(r.date).getTime() : null;
    if (day != null && (t == null || Math.abs(t - day) > 3 * DAY)) continue;
    const text = alnum(`${r.subject || ''} ${r.snippet || ''} ${r.body_text || ''}`);
    if (!quotes.every((q) => text.includes(q))) continue;
    const gap = day != null && t != null ? Math.abs(t - day) : 0;
    if (!best || gap < best.gap) best = { id: r.id, gap };
  }
  return best?.id || null;
}

/** Point a card at the message it now lives in; its msg:<old id> dedupe key and sources follow. */
async function relinkCard(card, messageId) {
  const old = MSG_KEY.exec(card.dedupe_key || '')?.[1] || null;
  const sources = old ? JSON.parse(JSON.stringify(card.sources || {}).split(old).join(messageId)) : card.sources;
  const key = old ? card.dedupe_key.replace(`msg:${old}`, `msg:${messageId}`) : card.dedupe_key;
  const set = async (dedupe) => query(
    `UPDATE hedwig_cards SET message_id = $2, message_ids = (SELECT ARRAY(SELECT DISTINCT unnest(message_ids || ARRAY[$2]::uuid[]))),
            sources = $3, dedupe_key = $4, updated_at = NOW()
      WHERE id = $1 AND message_id IS NULL`,
    [card.id, messageId, JSON.stringify(sources || {}), dedupe],
  );
  try {
    await set(key);
  } catch (err) {
    // The moved copy already has a card of its own under the new key: link this one, keep its key.
    if (err.code !== '23505') throw err;
    await set(card.dedupe_key);
  }
}

const ORPHANS_SQL = `SELECT c.id, c.kind, c.fields, c.sources, c.dedupe_key FROM hedwig_cards c
  WHERE c.user_id = $1 AND c.message_id IS NULL AND c.kind <> 'subscription' AND c.kind <> 'deadline'
    AND c.updated_at > NOW() - INTERVAL '400 days'`;

/**
 * Relink the user's orphaned cards to rows a cards job is about to read (mail just scanned, Trash
 * included). Returns how many were relinked.
 */
export async function relinkToRows(userId, rows) {
  if (!rows?.length) return 0;
  const { rows: orphans } = await query(`${ORPHANS_SQL} ORDER BY c.updated_at DESC LIMIT 1000`, [userId]);
  let n = 0;
  const taken = new Set();
  for (const card of orphans) {
    const id = matchOrphan(card, rows.filter((r) => !taken.has(r.id)));
    if (!id) continue;
    await relinkCard(card, id);
    taken.add(id);
    n++;
  }
  return n;
}

/**
 * Look for the moved copies of orphaned cards in the user's mail: the given cards, or the newest
 * orphans. Each search is bounded to the user's mail within three days of the card's date.
 */
export async function relinkOrphans(userId, { cardIds = null, limit = 20 } = {}) {
  const params = [userId];
  let sql = ORPHANS_SQL;
  if (cardIds?.length) { params.push(cardIds); sql += ` AND c.id = ANY($${params.length}::uuid[])`; }
  params.push(Math.max(1, Math.min(200, Number(limit) || 20)));
  const { rows: orphans } = await query(`${sql} ORDER BY c.updated_at DESC LIMIT $${params.length}`, params);
  let n = 0;
  for (const card of orphans) {
    const day = cardDay(card);
    const quotes = cardQuotes(card);
    if (day == null || !quotes.length) continue;
    const { rows } = await query(
      `SELECT m.id, m.date, m.subject, m.snippet, m.body_text FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND NOT m.is_deleted AND m.date BETWEEN $2::timestamptz AND $3::timestamptz
          AND NOT EXISTS (SELECT 1 FROM hedwig_cards k WHERE k.user_id = $1 AND k.kind = $4 AND k.message_id = m.id)
        LIMIT 400`,
      [userId, new Date(day - 3 * DAY), new Date(day + 3 * DAY), card.kind],
    );
    const id = matchOrphan(card, rows);
    if (!id) continue;
    await relinkCard(card, id);
    n++;
  }
  return n;
}
