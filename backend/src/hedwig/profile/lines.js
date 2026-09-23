// Profile lines: parsing the text, checking model lines against the evidence, and composing a
// version from pinned (user-written) and generated lines. Pure, except profileLines().
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';

export const LINE_MAX_CHARS = 200;
const KIND_ORDER = ['people', 'ignore', 'reading', 'writing', 'preference'];

/** Case, spacing and trailing-punctuation insensitive key for comparing lines. */
export const normLine = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!…]+$/, '').trim();

/** Text → trimmed, non-empty lines, list bullets removed. */
export function parseLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const uniqueBy = (list, key) => {
  const seen = new Set();
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

/** Second person, one line, bounded. */
export function cleanLine(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bthe user's\b/gi, 'your').replace(/\bthe user\b/gi, 'you').replace(/^[-*•]\s+/, '');
  if (s.length > LINE_MAX_CHARS) s = `${s.slice(0, LINE_MAX_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Every digit run a line citing these facts may use. */
function allowedNumbers(facts) {
  const out = new Set();
  for (const f of facts) for (const n of JSON.stringify([f.statement, f.numbers]).match(/\d+/g) || []) out.add(n);
  return out;
}

/**
 * Keep the model's lines that are grounded: a known kind, cited facts that exist, and every number
 * in the text found in the facts it cites (a line with numbers and no valid citation is dropped).
 * Lines that repeat a pinned line or bring back a dismissed one are dropped too.
 * @returns {{ kept: Array<{ text, kind, evidence }>, dropped: Array<{ text, reason }> }}
 */
export function validateLines(lines, facts, { pinned = [], dismissed = [], max = 40 } = {}) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const blocked = new Set([...pinned, ...dismissed].map(normLine));
  const kept = [];
  const dropped = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const text = cleanLine(raw?.text);
    if (!text) continue;
    const kind = KIND_ORDER.includes(raw?.kind) ? raw.kind : null;
    if (!kind) { dropped.push({ text, reason: 'unknown kind' }); continue; }
    const cited = (Array.isArray(raw.evidence) ? raw.evidence : []).map(String).filter((id) => byId.has(id));
    const numbers = text.match(/\d+/g) || [];
    if (numbers.length) {
      const allowed = allowedNumbers(cited.map((id) => byId.get(id)));
      const invented = numbers.filter((n) => !allowed.has(n));
      if (invented.length) { dropped.push({ text, reason: `numbers not in the cited evidence: ${[...new Set(invented)].join(', ')}` }); continue; }
    }
    if (blocked.has(normLine(text))) { dropped.push({ text, reason: 'repeats a pinned or dismissed line' }); continue; }
    kept.push({ text, kind, evidence: [...new Set(cited)] });
  }
  const unique = uniqueBy(kept, (l) => normLine(l.text));
  if (unique.length < kept.length) dropped.push(...kept.filter((l) => !unique.includes(l)).map((l) => ({ text: l.text, reason: 'duplicate' })));
  const out = unique.slice(0, Math.max(0, max));
  for (const l of unique.slice(Math.max(0, max))) dropped.push({ text: l.text, reason: 'over the line limit' });
  return { kept: out, dropped };
}

/**
 * A version's lines: pinned lines first, verbatim and in the user's order, then generated lines by
 * kind, up to `max` in total (pinned lines always stay, even past the limit).
 */
export function composeLines({ pinned = [], generated = [], max = 40 }) {
  const pins = uniqueBy(pinned.map((t) => String(t).trim()).filter(Boolean), normLine).map((text) => ({ text, kind: 'preference', pinned: true, evidence: [] }));
  const pinKeys = new Set(pins.map((p) => normLine(p.text)));
  const gen = generated
    .filter((l) => !pinKeys.has(normLine(l.text)))
    .map((l, i) => ({ line: { text: l.text, kind: l.kind, pinned: false, evidence: l.evidence || [] }, i }))
    .sort((a, b) => (KIND_ORDER.indexOf(a.line.kind) - KIND_ORDER.indexOf(b.line.kind)) || (a.i - b.i))
    .map((x) => x.line);
  return [...pins, ...gen.slice(0, Math.max(0, max - pins.length))];
}

export const linesToText = (lines) => lines.map((l) => l.text).join('\n');

/**
 * A user edit of the whole text. Lines they wrote or changed are pinned; lines they kept from the
 * previous version keep their kind, evidence and pin state; lines they deleted are dismissed.
 * @returns {{ lines, pinned: string[], dismissed: string[] }}
 */
export function applyUserEdit(previous, text, { max = 40 } = {}) {
  const prevLines = Array.isArray(previous?.lines) ? previous.lines : parseLines(previous?.text).map((t) => ({ text: t, kind: 'preference', pinned: false, evidence: [] }));
  const prevByKey = new Map(prevLines.map((l) => [normLine(l.text), l]));
  const prevPinned = new Set((previous?.pinned || []).map(normLine));
  const incoming = uniqueBy(parseLines(text).map((t) => (t.length > LINE_MAX_CHARS ? t.slice(0, LINE_MAX_CHARS) : t)), normLine);
  if (incoming.length > max) {
    const err = new Error(`A profile has at most ${max} lines`);
    err.status = 400;
    throw err;
  }
  const lines = incoming.map((t) => {
    const prev = prevByKey.get(normLine(t));
    if (prev && !prevPinned.has(normLine(t)) && prev.text === t) return { text: t, kind: prev.kind || 'preference', pinned: false, evidence: prev.evidence || [] };
    return { text: t, kind: prev?.kind || 'preference', pinned: true, evidence: [] };
  });
  const keptKeys = new Set(incoming.map(normLine));
  const removed = prevLines.filter((l) => !keptKeys.has(normLine(l.text))).map((l) => l.text);
  const dismissed = uniqueBy([...removed, ...(previous?.dismissed || [])], normLine).filter((t) => !keptKeys.has(normLine(t))).slice(0, 100);
  return { lines, pinned: lines.filter((l) => l.pinned).map((l) => l.text), dismissed };
}

/**
 * The user's current profile as lines, for prompts (drafting, Reflex). [] when there is none, when
 * the user turned the profile off for prompts, or on any error: callers never depend on it.
 */
export async function profileLines(userId) {
  if (!userId) return [];
  try {
    const cfg = await getConfig(userId);
    if (!cfg['profile.enabled'] || !cfg['profile.inPrompts']) return [];
    const { rows } = await query('SELECT text FROM hedwig_profile WHERE user_id = $1 ORDER BY version DESC LIMIT 1', [userId]);
    if (!rows[0]) return [];
    return parseLines(rows[0].text).map((l) => l.slice(0, LINE_MAX_CHARS)).slice(0, 80);
  } catch {
    return [];
  }
}
