// One-time codes: login, verification and security codes, with the service and expiry when stated.
// A number only counts with a code phrase next to it; booking references ("confirmation code") are
// travel, not one-time codes.
import { detectText, sentenceAround } from '../text.js';

const PHRASE = /(?:verification|one[- ]time|security|login|log-in|sign[- ]in|authentication|access|2fa|two[- ]factor|confirmation)\s+(?:code|pin|passcode|password|number)|\b(?:your|the) code\b|\bcode is\b|\bcode:|\bpasscode\b|\botp\b|engangskode|bekreftelseskode|sikkerhetskode|bestätigungscode|code de vérification/gi;
const CODE = /\b(?:[A-Z]-)?(\d{3}[- ]\d{3}|\d{4,8})\b|\b([A-Z0-9]{6,8})\b/g;
const BOOKING = /booking|reservation|flight|pnr|itinerary|ticket|order/i;

function codeNear(text, phraseIndex, phraseLen) {
  const windowStart = Math.max(0, phraseIndex - 60);
  const windowText = text.slice(windowStart, phraseIndex + phraseLen + 80);
  let best = null;
  for (const m of windowText.matchAll(CODE)) {
    const raw = m[1] || m[2];
    if (m[2] && !(/\d/.test(raw) && /[A-Z]/.test(raw))) continue;    // letters-and-digits codes need both
    if (m[1] && /^(19|20)\d{2}$/.test(raw)) continue;                 // a year
    const abs = windowStart + m.index + (m[0].length - raw.length);
    const before = text.slice(Math.max(0, abs - 3), abs);
    if (/[£€$#]\s?$/.test(before)) continue;                      // an amount or an order number
    const dist = Math.abs(abs - phraseIndex);
    if (!best || dist < best.dist) best = { code: raw.replace(/[ -]/g, ''), index: abs, dist };
  }
  return best;
}

/**
 * Code cards. Pure.
 * @param {{ id, subject, from_name, from_email, date, body_text?, body_html?, snippet? }} row
 */
export function detectCodes(row) {
  const text = detectText(row, { maxChars: 4000 });
  const out = [];
  for (const m of text.matchAll(PHRASE)) {
    const phrase = m[0].toLowerCase();
    if (/confirmation/.test(phrase) && BOOKING.test(sentenceAround(text, m.index))) continue;
    const hit = codeNear(text, m.index, m[0].length);
    if (!hit) continue;
    if (out.some((c) => c.fields.code === hit.code)) continue;
    const fields = { code: hit.code, service: row.from_name || (row.from_email || '').split('@')[1] || null, purpose: /sign[- ]?in|log[- ]?in|access/.test(phrase) ? 'sign-in' : 'verification' };
    const quote = sentenceAround(text, hit.index);
    const sources = { code: { messageId: row.id, quote, via: 'pattern' }, purpose: { messageId: row.id, quote, via: 'pattern' } };
    if (fields.service) sources.service = { messageId: row.id, quote: `From: ${row.from_name || ''} <${row.from_email || ''}>`.trim(), via: 'header' };
    const exp = /(?:expires?|valid|gültig|gyldig)[^.\n]{0,20}?(\d{1,3})\s*(minutes?|mins?|hours?|minutter|minuten)/i.exec(text);
    if (exp && row.date) {
      const mins = Number(exp[1]) * (/hour/i.test(exp[2]) ? 60 : 1);
      fields.expiresAt = new Date(new Date(row.date).getTime() + mins * 60_000).toISOString();
      sources.expiresAt = { messageId: row.id, quote: sentenceAround(text, exp.index), via: 'pattern' };
    }
    if (!fields.service) delete fields.service;
    out.push({ kind: 'code', messageId: row.id, fields, sources, confidence: 0.85, layer: 'pattern' });
    if (out.length >= 2) break;
  }
  return out;
}
