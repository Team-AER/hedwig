// Deterministic detectors, cheapest and most certain first. Model extraction (cards.extract) only
// runs for mail these find nothing in.
import { detectSchemaOrg } from './schemaOrg.js';
import { detectIcs } from './ics.js';
import { detectTracking } from './tracking.js';
import { detectCodes } from './codes.js';

export { detectSchemaOrg, detectIcs, detectTracking, detectCodes };

/** Calendar attachments listed on a message (text/calendar, application/ics, *.ics). Pure. */
export function calendarAttachments(attachments, { maxBytes = 262144 } = {}) {
  let list = attachments;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : [])
    .map((a, index) => ({ index, part: a?.part, filename: a?.filename || '', mime: String(a?.type || a?.mime || a?.contentType || '').toLowerCase(), size: Number(a?.size) || 0, encoding: a?.encoding }))
    .filter((a) => /text\/calendar|application\/ics/.test(a.mime) || /\.ics$/i.test(a.filename))
    .filter((a) => !(a.size > maxBytes));
}

/**
 * Every deterministic card for one message.
 * @param {object} row message row (id, subject, from_*, date, body_text, body_html, snippet)
 * @param {{ icsParts?: { text, filename }[], tz?: string }} [ctx]
 */
export function detectDeterministic(row, { icsParts = [], tz = 'UTC' } = {}) {
  const parts = [...icsParts];
  if (/BEGIN:VCALENDAR/.test(row.body_text || '')) parts.push({ text: row.body_text, filename: null });
  const cards = [...detectSchemaOrg(row), ...detectIcs(row, parts, { tz })];
  // Tracking numbers the markup already gave are not repeated.
  const tracked = new Set(cards.filter((c) => c.kind === 'delivery').map((c) => String(c.fields.trackingNumber || '').toUpperCase()));
  for (const c of detectTracking(row, { tz })) if (!tracked.has(c.fields.trackingNumber)) cards.push(c);
  cards.push(...detectCodes(row));
  return cards;
}
