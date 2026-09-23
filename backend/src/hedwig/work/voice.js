// The owner's voice with one person, read from their own sent mail: typical length, greeting,
// sign-off and a few recent samples. Plus a hook for hedwig_profile (not built yet).
import { query } from '../../services/db.js';
import { splitBody } from '../indexer/parse.js';

const GREETING_RE = /^(good (?:morning|afternoon|evening)|hi|hello|hey|dear|hallo|bonjour|hola|moin|servus|morning|afternoon|evening)\b/i;
const SIGNOFF_RE = /^(thanks|thank you|many thanks|cheers|best|best regards|kind regards|regards|warm regards|all the best|talk soon|speak soon|take care|ta|thx|love|br|lg|viele grüße|mit freundlichen grüßen|cordialement)\b[^\n]{0,30}$/i;

const words = (s) => (String(s || '').match(/\S+/g) || []).length;

/** Greeting, sign-off and word count of one reply the owner wrote. Pure. */
export function voiceFeatures(text, signature = '') {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const g = lines.length && lines[0].length <= 60 ? GREETING_RE.exec(lines[0]) : null;
  const greeting = g ? g[1][0].toUpperCase() + g[1].slice(1).toLowerCase() : null;
  const sigLines = String(signature || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates = [...lines.slice(-3), ...sigLines.slice(0, 2)];
  const signOff = candidates.find((l) => SIGNOFF_RE.test(l)) || null;
  return { greeting, signOff: signOff ? signOff.replace(/[,.!]+$/, '') : null, words: words(text) };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

/** Summarise several of the owner's replies. Pure. */
export function summarizeVoice(samples) {
  const feats = samples.map((s) => voiceFeatures(s.text, s.signature));
  const sorted = feats.map((f) => f.words).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    medianWords: median,
    greeting: mostCommon(feats.map((f) => f.greeting)),
    signOff: mostCommon(feats.map((f) => f.signOff)),
    samples: samples.map((s) => s.text.slice(0, 700)),
  };
}

/**
 * The owner's last `n` messages to `email` (their own sent mail), newest first, as voice samples.
 * @returns {Promise<{ medianWords, greeting, signOff, samples: string[] }>}
 */
export async function voiceWith(userId, email, { n = 5, addresses = [] } = {}) {
  if (!email || n <= 0) return summarizeVoice([]);
  const { rows } = await query(
    `SELECT m.body_text, m.body_html, m.snippet
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE a.user_id = $1 AND NOT m.is_deleted
        AND (COALESCE(f.special_use, '') = '\\Sent' OR lower(m.from_email) = ANY($3::text[]))
        AND jsonb_typeof(m.to_addresses) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.to_addresses) e
                     WHERE lower(COALESCE(e->>'address', e->>'email', e #>> '{}')) = $2)
      ORDER BY m.date DESC NULLS LAST
      LIMIT $4`,
    [userId, String(email).toLowerCase(), addresses, n],
  );
  const samples = rows
    .map((r) => { const p = splitBody(r); return { text: (p.newText || '').trim(), signature: p.signature || '' }; })
    .filter((s) => s.text);
  return summarizeVoice(samples);
}

/**
 * Lines about the owner from hedwig_profile, once that table exists (a later stream builds it).
 * Until then: []. Kept tolerant of the table's absence so drafting never depends on it.
 */
export async function profileLines(userId) {
  try {
    const { rows: [t] } = await query("SELECT to_regclass('public.hedwig_profile') AS t");
    if (!t?.t) return [];
    const { rows } = await query('SELECT * FROM hedwig_profile WHERE user_id = $1 LIMIT 20', [userId]);
    return rows.map((r) => r.line || r.text || r.value).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200));
  } catch {
    return [];
  }
}
