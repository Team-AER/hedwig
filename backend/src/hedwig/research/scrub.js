// Make a web-search query safe to send to public search engines: the planner writes it from the user's
// mail, so it can carry addresses, the owner's name, phone and account numbers, or links with tokens.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'giu');
const letters = (s) => (s.match(/\p{L}/gu) || []).length;

function keepUrlPath(match) {
  try {
    const u = new URL(match);
    return ` ${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname} `;
  } catch {
    return ' ';
  }
}

// IBANs are mostly digits; the floor keeps tokens like "US10 YEAR TREASURY" out.
const ibanLike = (m) => ((m.match(/\d/g) || []).length >= 8 ? ' ' : m);

function numberLike(m) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m;
  const groups = m.replace(/^\+/, '').split(/[ -]/);
  if (groups.length === 1) return ' ';
  // Separated runs: phone and account numbers, but not "15 2024" or "1.80 2024".
  const digits = groups.join('').length;
  return digits >= 8 || groups.filter((g) => g.length >= 3).length >= 2 ? ' ' : m;
}

/**
 * A web-search query with private details removed: email addresses (and the given `emails`), the given
 * `names` (whole words, case-insensitive, plus each word of 3+ letters of a multi-word name), digit runs of
 * 6+ (spaces and dashes allowed inside; ISO dates kept), IBAN-like tokens, and URL queries (only scheme,
 * host and path are kept). Whitespace and stray punctuation are collapsed and the result is capped at
 * `maxChars` on a word boundary; '' when fewer than 2 letters or digits remain.
 * @param {string} query
 * @param {{ names?: string[], emails?: string[], maxChars?: number }} [opts]
 * @returns {string}
 */
export function scrubQuery(query, { names = [], emails = [], maxChars = 120 } = {}) {
  let q = String(query ?? '');
  q = q.replace(/\bhttps?:\/\/[^\s<>"']+/gi, keepUrlPath);
  for (const e of emails || []) {
    const email = String(e ?? '').trim();
    if (email) q = q.replace(new RegExp(escapeRe(email), 'gi'), ' ');
  }
  q = q.replace(/[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g, ' ');

  const terms = new Set();
  for (const n of names || []) {
    const name = String(n ?? '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    terms.add(name);
    const parts = name.split(' ');
    if (parts.length < 2) continue;
    for (const part of parts) {
      const word = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (letters(word) >= 3) terms.add(word);
    }
  }
  for (const term of [...terms].sort((a, b) => b.length - a.length)) q = q.replace(wholeWord(term), ' ');

  q = q.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,8}(?: ?[A-Z0-9]{1,3})?\b/g, ibanLike);
  q = q.replace(/\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,}\b/g, ibanLike);
  q = q.replace(/\+?\d(?:[ -]?\d){5,}/g, numberLike);

  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/^[,;:]+|[,;:]+$/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  let out = tokens.join(' ');
  if (out.length > maxChars) {
    const at = out.slice(0, maxChars + 1).lastIndexOf(' ');
    out = at > 0 ? out.slice(0, at) : out.slice(0, maxChars);
  }
  out = out.trim();
  return (out.match(/[\p{L}\p{N}]/gu) || []).length < 2 ? '' : out;
}
