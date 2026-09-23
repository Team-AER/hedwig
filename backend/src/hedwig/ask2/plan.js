// Query plan for Ask: turn a question into retrieval filters. Rules first (dates, people, folders,
// attachments, "latest", quoted phrases); the Reflex model (`ask.plan`) only when the rules find
// nothing structured, with a hard time limit so a slow model never delays the answer by more than
// ask.planTimeoutMs. The plan is logged with the answer (hedwig_ask_log.plan).
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { runPrompt } from '../prompts/index.js';
import { validTimezone, zonedParts, zonedToUtc, addDays } from '../insights/time.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NOT_NAMES = new Set([...MONTHS, ...DAYS, 'i', 'me', 'my', 'the', 'a', 'an', 'last', 'this', 'next', 'today', 'yesterday', 'tomorrow',
  'what', 'when', 'where', 'who', 'why', 'how', 'did', 'do', 'does', 'is', 'are', 'was', 'any', 'all', 'mail', 'email', 'emails',
  'inbox', 'work', 'home', 'them', 'him', 'her', 'us', 'you', 'it', 'there', 'here', 'someone', 'anyone', 'everyone', 'june', 'may']);
const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };

export const EMPTY_PLAN = Object.freeze({ text: '', people: [], names: [], after: null, before: null, folders: [], hasAttachment: null, latest: false, quoted: [] });

function monthIndex(word) {
  const w = String(word || '').toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(w));
}

const startOfDay = (p, tz) => zonedToUtc({ year: p.year, month: p.month, day: p.day }, tz);
const monthStart = (year, month, tz) => zonedToUtc({ year, month, day: 1 }, tz);
const nextMonth = (year, month) => (month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 });

/** True when the plan narrows retrieval by anything other than free text. */
export function isStructured(plan) {
  return Boolean(plan && (plan.people?.length || plan.names?.length || plan.after || plan.before || plan.folders?.length
    || plan.hasAttachment != null || plan.latest || plan.quoted?.length));
}

/**
 * Rules-only plan. Pure (given `now`, `tz`, the user's folder names and known correspondent names).
 * @param {string} question
 * @param {{ now?: Date|number, tz?: string, folders?: string[], knownPeople?: string[] }} [ctx]
 * @returns {{ text, people, names: {name, from}[], after, before, folders, hasAttachment, latest, quoted, rules: string[] }}
 *   people: addresses and sender names retrieval can filter on now; names: every person named, for
 *   resolution to addresses (planQuery), which also covers "to Priya" and "with Priya".
 */
export function planRules(question, { now = new Date(), tz = 'UTC', folders = [], knownPeople = [] } = {}) {
  const zone = validTimezone(tz);
  const at = new Date(now);
  const today = zonedParts(at, zone);
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const plan = { text: '', people: [], names: [], after: null, before: null, folders: [], hasAttachment: null, latest: false, quoted: [], rules: [] };
  let rest = q;
  const take = (re, fn) => {
    rest = rest.replace(re, (...m) => {
      const keep = fn(...m);
      return typeof keep === 'string' ? keep : ' ';
    });
  };
  const setRange = (after, before, rule) => {
    if (!plan.after && !plan.before) {
      plan.after = after ? after.toISOString() : null;
      plan.before = before ? before.toISOString() : null;
      plan.rules.push(rule);
    }
  };

  // Quoted phrases stay in the text (they are what to look for) and are also kept for a phrase boost.
  take(/[“"]([^”"]{2,120})[”"]/g, (_, phrase) => { plan.quoted.push(phrase.trim()); plan.rules.push('quoted'); return ` ${phrase} `; });

  // Dates, in the user's zone.
  take(/\b(yesterday)\b/gi, () => setRange(startOfDay(addDays(today, -1), zone), startOfDay(today, zone), 'yesterday'));
  take(/\b(today|this morning)\b/gi, () => setRange(startOfDay(today, zone), startOfDay(addDays(today, 1), zone), 'today'));
  take(/\b(?:in |during |from )?(this|last|past|previous) (week|month|year)\b/gi, (_, which, unit) => {
    const u = unit.toLowerCase();
    const prev = which.toLowerCase() !== 'this';
    if (u === 'week') {
      const monday = addDays(today, -((today.weekday + 6) % 7));
      if (prev) setRange(startOfDay(addDays(monday, -7), zone), startOfDay(monday, zone), 'last_week');
      else setRange(startOfDay(monday, zone), null, 'this_week');
    } else if (u === 'month') {
      if (prev) {
        const pm = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
        setRange(monthStart(pm.year, pm.month, zone), monthStart(today.year, today.month, zone), 'last_month');
      } else setRange(monthStart(today.year, today.month, zone), null, 'this_month');
    } else if (prev) setRange(monthStart(today.year - 1, 1, zone), monthStart(today.year, 1, zone), 'last_year');
    else setRange(monthStart(today.year, 1, zone), null, 'this_year');
  });
  take(/\b(?:in |over |during )?(?:the )?(?:last|past) (\d{1,3}) (day|week|month|year)s?\b/gi, (_, n, unit) => {
    setRange(new Date(at.getTime() - Number(n) * UNIT_DAYS[unit.toLowerCase()] * 86400_000), null, `last_n_${unit.toLowerCase()}s`);
  });
  take(new RegExp(`\\b(since|after|before|in|during|from) ${MONTH_RE}(?: (\\d{4}))?\\b`, 'gi'), (whole, prep, mon, yr) => {
    const m = monthIndex(mon) + 1;
    if (m < 1) return whole;
    // "May" is also a verb; only a capitalised May counts.
    if (/^may$/i.test(mon) && mon !== 'May') return whole;
    let year = yr ? Number(yr) : today.year;
    if (!yr && m > today.month) year -= 1; // "in November" asked in March means last November
    const start = monthStart(year, m, zone);
    const nm = nextMonth(year, m);
    const end = monthStart(nm.year, nm.month, zone);
    const p = prep.toLowerCase();
    if (p === 'since' || p === 'from') setRange(start, null, 'since_month');
    else if (p === 'after') setRange(end, null, 'after_month');
    else if (p === 'before') setRange(null, start, 'before_month');
    else setRange(start, end, 'in_month');
    return ' ';
  });
  take(/\b(in|during|since|before) (20\d{2}|19\d{2})\b/gi, (_, prep, yr) => {
    const y = Number(yr);
    const p = prep.toLowerCase();
    if (p === 'since') setRange(monthStart(y, 1, zone), null, 'since_year');
    else if (p === 'before') setRange(null, monthStart(y, 1, zone), 'before_year');
    else setRange(monthStart(y, 1, zone), monthStart(y + 1, 1, zone), 'in_year');
  });

  // "latest", "most recent", "last email from …" (after the date rules took "last week" etc.).
  take(/\b(latest|most recent|newest|last (?:email|e-mail|message|mail|one|update|reply))\b/gi, () => { plan.latest = true; plan.rules.push('latest'); });

  // Attachments. The file type stays in the text: attachment chunks carry the file name.
  take(/\bwith (?:an? |the |any )?(attachments?|pdfs?|files?|documents?|spreadsheets?|invoice attached)\b/gi, (_, what) => {
    plan.hasAttachment = true;
    plan.rules.push('has_attachment');
    return /^(pdfs?|spreadsheets?)$/i.test(what) ? ` ${what} ` : ' ';
  });
  if (plan.hasAttachment == null && /\b(attached|attachments?)\b/i.test(rest)) { plan.hasAttachment = true; plan.rules.push('attached'); }

  // Folders: only the user's own folder names, after "in"/"from" or before "folder".
  const names = [...new Set((folders || []).filter(Boolean))];
  for (const f of names.sort((a, b) => b.length - a.length)) {
    const leaf = f.split(/[/.]/).pop();
    if (!leaf || leaf.length < 3) continue;
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b(?:in|from) (?:my |the )?${esc}(?: folder)?\\b|\\b${esc} folder\\b`, 'i');
    if (re.test(rest)) {
      plan.folders.push(f);
      plan.rules.push('folder');
      rest = rest.replace(re, ' ');
    }
  }

  // People: email addresses anywhere; names after from/by/with/to/sent by.
  take(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, (email) => { plan.people.push(email.toLowerCase()); plan.rules.push('email'); });
  const known = new Set((knownPeople || []).map((n) => String(n).toLowerCase()).filter((n) => n.length >= 2));
  take(/\b(from|by|with|to|sent by|emailed by|cc'd|cc) ([\p{L}][\p{L}'’-]+(?: [\p{L}][\p{L}'’-]+)?)/giu, (whole, prep, name) => {
    const words = name.split(' ');
    const isName = (w) => !NOT_NAMES.has(w.toLowerCase()) && (/^\p{Lu}/u.test(w) || known.has(w.toLowerCase()));
    if (!isName(words[0])) return whole;
    const picked = words.length === 2 && isName(words[1]) && /^\p{Lu}/u.test(words[1]) ? name : words[0];
    const p = prep.toLowerCase();
    const from = p === 'from' || p === 'by' || p.endsWith(' by');
    plan.names.push({ name: picked, from });
    // A bare name can only be matched against the sender; "to"/"with" names wait for resolution.
    if (from) plan.people.push(picked.toLowerCase());
    plan.rules.push('person');
    return ` ${picked} ${words.length === 2 && picked === words[0] ? words[1] : ''} `;
  });
  plan.people = [...new Set(plan.people)];

  const cleaned = rest.replace(/\s+([?.!,])/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,?.!]+|[\s,]+$/g, '').trim();
  plan.text = cleaned.replace(/[?.!]+$/, '').trim().length >= 2 ? cleaned : q;
  plan.rules = [...new Set(plan.rules)];
  return plan;
}

/** Normalise the Reflex plan: dates must parse, folders must be the user's, people are short strings. */
export function normaliseModelPlan(data, { folders = [], question = '' } = {}) {
  const out = { ...EMPTY_PLAN, text: String(question || '').trim() };
  if (!data || typeof data !== 'object') return out;
  const date = (v) => {
    if (typeof v !== 'string' || !v.trim()) return null;
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  if (typeof data.text === 'string' && data.text.trim().length >= 2) out.text = data.text.trim().slice(0, 300);
  out.people = (Array.isArray(data.people) ? data.people : []).map((p) => String(p || '').trim().toLowerCase()).filter((p) => p.length >= 2 && p.length <= 80).slice(0, 5);
  out.after = date(data.after);
  out.before = date(data.before);
  if (out.after && out.before && out.after >= out.before) { out.after = null; out.before = null; }
  const own = new Map(folders.map((f) => [f.toLowerCase(), f]));
  out.folders = (Array.isArray(data.folders) ? data.folders : []).map((f) => own.get(String(f || '').toLowerCase())).filter(Boolean);
  out.hasAttachment = data.hasAttachment === true ? true : null;
  out.latest = data.latest === true;
  return out;
}

async function userFolders(userId) {
  const { rows } = await query(
    `SELECT DISTINCT f.path FROM folders f JOIN email_accounts a ON a.id = f.account_id
      WHERE a.user_id = $1 AND COALESCE(f.special_use, '') NOT IN ('\\Junk', '\\Trash') LIMIT 500`,
    [userId],
  );
  return rows.map((r) => r.path).filter(Boolean);
}

async function knownPeople(userId) {
  const { rows } = await query(
    `SELECT display_name FROM hedwig_entities WHERE user_id = $1 AND kind <> 'self' AND display_name IS NOT NULL
      ORDER BY message_count DESC NULLS LAST LIMIT 300`,
    [userId],
  ).catch(() => ({ rows: [] }));
  const out = new Set();
  for (const r of rows) {
    const first = String(r.display_name).trim().split(/\s+/)[0];
    if (first && first.length >= 2) out.add(first.toLowerCase());
  }
  return [...out];
}

/**
 * Replace person names with the addresses Hedwig knows for them (so "to Priya" and "with Priya" match
 * To/Cc as well as From). Unknown names stay as sender-name filters when they were "from"/"by".
 */
export async function resolvePeople(userId, plan) {
  if (!plan.names?.length) return plan;
  const emails = plan.people.filter((p) => p.includes('@'));
  const names = [];
  for (const { name, from } of plan.names) {
    const { rows } = await query(
      `SELECT DISTINCT lower(x.email) AS email
         FROM hedwig_entities e JOIN hedwig_entity_addresses x ON x.entity_id = e.id AND x.user_id = $1
        WHERE e.user_id = $1 AND e.kind <> 'self' AND (e.display_name ILIKE $2 || '%' OR e.display_name ILIKE '% ' || $2 || '%')
        ORDER BY 1 LIMIT 4`,
      [userId, name.replace(/[%_\\]/g, (ch) => `\\${ch}`)],
    ).catch(() => ({ rows: [] }));
    if (rows.length) emails.push(...rows.map((r) => r.email));
    else if (from) names.push(name.toLowerCase());
  }
  return { ...plan, people: [...new Set([...emails, ...names])] };
}

/**
 * The plan for one question: rules, then (only when they find nothing structured) the Reflex model
 * within ask.planTimeoutMs. Never throws for a model problem; `via` says what made the plan.
 * @returns {Promise<{ text, people, after, before, folders, hasAttachment, latest, quoted, rules, via, ms, provenance? }>}
 */
export async function planQuery(userId, question, { now = new Date(), cfg = null, signal } = {}) {
  const started = Date.now();
  const config = cfg || await getConfig(userId);
  const tz = validTimezone(config['insights.timezone']);
  const [folders, people] = await Promise.all([userFolders(userId).catch(() => []), knownPeople(userId)]);
  const rules = await resolvePeople(userId, planRules(question, { now, tz, folders, knownPeople: people }));
  if (isStructured(rules) || !config['ask.planReflex'] || !config['llm.baseUrl']) {
    return { ...rules, via: 'rules', ms: Date.now() - started };
  }
  const timeout = AbortSignal.timeout(config['ask.planTimeoutMs']);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const { data, provenance } = await runPrompt('ask.plan', {
      question, today: new Date(now).toISOString().slice(0, 10), tz, folders: folders.slice(0, 40),
    }, { userId, feature: 'ask', lane: 'interactive', signal: combined });
    const model = normaliseModelPlan(data, { folders, question });
    const merged = { ...rules, ...model, quoted: rules.quoted, rules: [...rules.rules, 'reflex'] };
    if (!merged.text || merged.text.length < 2) merged.text = rules.text;
    return {
      ...merged, via: 'reflex', ms: Date.now() - started,
      provenance: { promptId: provenance.promptId, promptVersion: provenance.promptVersion, model: provenance.model, aiCallId: provenance.aiCallId },
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ...rules, via: 'rules', reflexError: timeout.aborted ? 'timeout' : String(err?.code || err?.message || err).slice(0, 120), ms: Date.now() - started };
  }
}
