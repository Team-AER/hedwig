// Pure helpers shared by the Hedwig views. No React, no DOM, no store: everything here is unit
// tested with `node --test` (helpers.test.js).

// ── Triage vocabulary ────────────────────────────────────────────────────────
export const TRIAGE_CATEGORIES = [
  { id: 'needs_you', label: 'Needs you', tone: 'amber' },
  { id: 'waiting_on', label: 'Waiting on', tone: 'teal' },
  { id: 'digest', label: 'Digest', tone: 'neutral' },
  { id: 'notifications', label: 'Notifications', tone: 'neutral' },
  { id: 'everything', label: 'Everything', tone: 'neutral' },
  { id: 'spam', label: 'Spam', tone: 'red' },
];

export function categoryLabel(id) {
  return TRIAGE_CATEGORIES.find((c) => c.id === id)?.label || (id ? String(id).replace(/_/g, ' ') : 'Unsorted');
}

export function categoryTone(id) {
  return TRIAGE_CATEGORIES.find((c) => c.id === id)?.tone || 'neutral';
}

/** Chip text + muted "why" text for a triage row. */
export function triageReason(triage) {
  if (!triage) return { chip: 'Unsorted', why: '' };
  const chip = triage.reason_label || categoryLabel(triage.category);
  const reasons = Array.isArray(triage.reasons) ? triage.reasons : [];
  const why = reasons
    .filter((r) => r && r.direction !== 'against' && r.label && r.label !== chip)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 2)
    .map((r) => r.label)
    .join(' · ');
  return { chip, why };
}

/** "2 · 0.94" — stage plus confidence, the way the triage table shows it. */
export function stageLabel(triage) {
  if (!triage) return '';
  const stage = triage.stage ?? '';
  if (stage === 1 || triage.confidence == null) return String(stage);
  return `${stage} · ${Number(triage.confidence).toFixed(2)}`;
}

// ── Errors ───────────────────────────────────────────────────────────────────
/**
 * Classify an error from hedwigApi / hedwigStream into the state a view should show.
 * 'missing' (404: route or object not there yet), 'off' (403/503: feature disabled),
 * 'budget' (429 budget_exceeded), 'auth' (401), 'error' (anything else).
 */
export function classifyError(err) {
  if (!err) return null;
  const status = err.status;
  const msg = String(err.message || err.error || '').toLowerCase();
  if (status === 429 || msg.includes('budget')) return 'budget';
  if (status === 404) return 'missing';
  if (status === 403 || status === 503 || /feature (is )?(off|disabled)|not enabled|disabled for/.test(msg)) return 'off';
  if (status === 401) return 'auth';
  return 'error';
}

// ── Time ─────────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const pad2 = (n) => String(n).padStart(2, '0');

/** List-style time: 09:40 today, Yesterday, Tue this week, 21 Sep this year, else 21 Sep 2024. */
export function formatWhen(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return DAYS[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "21 Sep" (or "21 Sep 2024" in another year). */
export function formatDay(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** "Feb 2026". */
export function formatMonth(value) {
  const d = toDate(value);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

/** "3 min ago", "2 h ago", "4 d ago"; future: "in 3 d". */
export function formatAgo(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const diff = now.getTime() - d.getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let out;
  if (s < 45) out = 'just now';
  else if (s < 3600) out = `${Math.round(s / 60)} min`;
  else if (s < 86_400) out = `${Math.round(s / 3600)} h`;
  else if (s < 86_400 * 60) out = `${Math.round(s / 86_400)} d`;
  else return formatDay(d, now);
  if (out === 'just now') return out;
  return future ? `in ${out}` : `${out} ago`;
}

/** Due-date phrase for a commitment: "due in 7 d", "due today", "overdue 3 d". */
export function dueLabel(dueAt, now = new Date()) {
  const d = toDate(dueAt);
  if (!d) return '';
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days > 1) return days <= 14 ? `due in ${days} d` : `due ${formatDay(d, now)}`;
  return `overdue ${-days} d`;
}

export function formatHours(h) {
  if (h == null || !Number.isFinite(Number(h))) return '–';
  const n = Number(h);
  if (n < 1) return `${Math.round(n * 60)} min`;
  if (n < 48) return `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} h`;
  return `${(n / 24).toFixed(1).replace(/\.0$/, '')} d`;
}

/** Rate as a percentage. Accepts 0..1 fractions or 0..100 percentages. */
export function formatPercent(v, digits = 0) {
  if (v == null || !Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  const pct = n <= 1 ? n * 100 : n;
  return `${pct.toFixed(digits)}%`;
}

export function formatCount(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  return Number(n).toLocaleString('en-GB');
}

// ── People ───────────────────────────────────────────────────────────────────
export function initials(name, email) {
  const src = String(name || '').trim() || String(email || '').split('@')[0] || '?';
  const words = src.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function senderName(message) {
  if (!message) return '';
  return message.from_name || message.from_email || 'Unknown sender';
}

// ── Citations ────────────────────────────────────────────────────────────────
/**
 * Split plain text into text / citation segments. Recognises `[n]`, `[n, m]`, `[n][m]` and
 * `[msg:<id>]`. Markdown links `[text](url)` are left alone.
 * Returns [{ type: 'text', text } | { type: 'cite', n } | { type: 'msg', id }].
 */
export function parseCitations(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /\[(msg:[A-Za-z0-9_-]+|\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    const body = m[1];
    if (body.startsWith('msg:')) out.push({ type: 'msg', id: body.slice(4) });
    else for (const n of body.split(',')) out.push({ type: 'cite', n: Number(n.trim()) });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Replace citation markers in rendered HTML with buttons the Markdown component delegates clicks
 * from. Markers inside <code>/<pre> and inside tag attributes are left alone.
 */
export function linkifyCitations(html) {
  const src = String(html ?? '');
  // Tokenise into tags and text so markers inside attributes or code stay untouched.
  const parts = src.split(/(<[^>]+>)/g);
  let codeDepth = 0;
  return parts.map((part) => {
    if (part.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(part)) codeDepth++;
      else if (/^<\/(code|pre)>/i.test(part)) codeDepth = Math.max(0, codeDepth - 1);
      return part;
    }
    if (codeDepth > 0 || !part.includes('[')) return part;
    return parseCitations(part).map((seg) => {
      if (seg.type === 'text') return seg.text;
      if (seg.type === 'msg') {
        return `<button type="button" class="hw-cite" data-msg="${escapeAttr(seg.id)}" aria-label="Open cited message">↗</button>`;
      }
      return `<button type="button" class="hw-cite" data-cite="${seg.n}" aria-label="Open source ${seg.n}">${seg.n}</button>`;
    }).join('');
  }).join('');
}

/** The citation numbers used in a text, unique, in order of first appearance. */
export function citedNumbers(text) {
  const seen = [];
  for (const seg of parseCitations(text)) if (seg.type === 'cite' && !seen.includes(seg.n)) seen.push(seg.n);
  return seen;
}

// ── SSE reducers ─────────────────────────────────────────────────────────────
export const ASK_INITIAL = Object.freeze({ status: 'idle', sources: [], answer: '', citations: [], error: null });

/** Fold one /context/ask event into the answer state. */
export function reduceAsk(state, event) {
  if (!event || typeof event !== 'object') return state;
  switch (event.type) {
    case 'sources':
      return { ...state, status: 'streaming', sources: Array.isArray(event.sources) ? event.sources : [] };
    case 'delta':
      return { ...state, status: 'streaming', answer: state.answer + (event.text || '') };
    case 'done':
      return {
        ...state,
        status: 'done',
        answer: typeof event.answer === 'string' && event.answer ? event.answer : state.answer,
        citations: Array.isArray(event.citations) ? event.citations : citedNumbers(state.answer),
      };
    case 'error':
      return { ...state, status: 'error', error: event.error || 'The answer failed' };
    default:
      return state;
  }
}

export const AGENT_INITIAL = Object.freeze({ runId: null, status: 'idle', items: [], result: null, error: null });

/**
 * Fold one /agent/runs event into the transcript. Items are
 * { kind: 'user', text } | { kind: 'text', text } | { kind: 'tool', id, name, arguments, ok, summary, done }
 * | { kind: 'action', action }.
 */
export function reduceAgent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const items = state.items;
  switch (event.type) {
    case 'run':
      return { ...state, runId: event.runId ?? state.runId, status: 'running' };
    case 'delta': {
      const last = items[items.length - 1];
      if (last && last.kind === 'text') {
        return { ...state, status: 'running', items: [...items.slice(0, -1), { ...last, text: last.text + (event.text || '') }] };
      }
      return { ...state, status: 'running', items: [...items, { kind: 'text', text: event.text || '' }] };
    }
    case 'tool_call':
      return {
        ...state,
        status: 'running',
        items: [...items, { kind: 'tool', id: event.id, name: event.name, arguments: event.arguments, done: false }],
      };
    case 'tool_result': {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'tool' && (items[i].id === event.id || (event.id == null && items[i].name === event.name && !items[i].done))) { idx = i; break; }
      }
      const patch = { ok: event.ok !== false, summary: event.summary, done: true };
      if (idx < 0) return { ...state, items: [...items, { kind: 'tool', id: event.id, name: event.name, ...patch }] };
      const next = items.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...state, items: next };
    }
    case 'action_pending':
      return event.action ? { ...state, items: [...items, { kind: 'action', action: event.action }] } : state;
    case 'done':
      return { ...state, runId: event.runId ?? state.runId, status: event.status || 'done', result: event.result ?? null };
    case 'error':
      return { ...state, status: 'error', error: event.error || 'The run failed' };
    default:
      return state;
  }
}

/** Replace an action (by id) wherever it appears in the transcript. */
export function updateActionInItems(items, action) {
  if (!action?.id) return items;
  return items.map((it) => (it.kind === 'action' && it.action?.id === action.id ? { ...it, action: { ...it.action, ...action } } : it));
}

/**
 * Rebuild transcript items from a stored run (GET /agent/runs/:id). Messages are OpenAI-style;
 * step records (`steps[].tool_calls[]`) carry the tool summaries. Hedwig's own status notes
 * (user-role messages with `kind`, or the "[Hedwig status update" prefix) become 'note' items.
 */
export function itemsFromRun(run, actions = []) {
  const items = [];
  const msgs = Array.isArray(run?.messages) ? run.messages : [];
  const stepCalls = new Map();
  for (const st of Array.isArray(run?.steps) ? run.steps : []) {
    for (const c of st?.tool_calls || []) if (c?.id) stepCalls.set(c.id, c);
  }
  const toolIdx = new Map();
  for (const m of msgs) {
    if (!m || m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => c?.text || '').join('') : '';
    if (m.role === 'user') {
      if (!text) continue;
      if (m.kind || text.startsWith('[Hedwig status update')) items.push({ kind: 'note', text: text.replace(/^\[Hedwig status update[^\]]*\]\s*/, '') });
      else items.push({ kind: 'user', text });
      continue;
    }
    if (m.role === 'assistant') {
      if (text) items.push({ kind: 'text', text });
      for (const tc of m.tool_calls || []) {
        toolIdx.set(tc.id, items.length);
        items.push({ kind: 'tool', id: tc.id, name: tc.function?.name || tc.name, arguments: tc.function?.arguments ?? tc.arguments, done: false });
      }
      continue;
    }
    if (m.role === 'tool') {
      const i = toolIdx.get(m.tool_call_id);
      if (i == null) continue;
      const step = stepCalls.get(m.tool_call_id);
      let summary = step?.summary;
      let ok = step ? step.ok !== false : true;
      if (summary == null) {
        summary = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            summary = parsed.summary || parsed.error || truncate(text, 120);
            ok = !parsed.error && parsed.ok !== false;
          }
        } catch { /* plain text result */ }
      }
      items[i] = { ...items[i], ok, summary: truncate(summary, 280), done: true };
    }
  }
  if (!items.length) {
    for (const c of stepCalls.values()) items.push({ kind: 'tool', id: c.id, name: c.name, arguments: c.arguments, ok: c.ok !== false, summary: c.summary, done: true });
  }
  for (const a of actions || []) items.push({ kind: 'action', action: a });
  if (run?.result && typeof run.result === 'string' && !items.some((it) => it.kind === 'text')) {
    items.push({ kind: 'text', text: run.result });
  }
  return items;
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** Tool arguments are usually a JSON string; show them compactly. */
export function formatArgs(args) {
  if (args == null || args === '') return '';
  let v = args;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return truncate(v, 160); }
  }
  if (v && typeof v === 'object') {
    return truncate(Object.entries(v).map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`).join(', '), 160);
  }
  return truncate(String(v), 160);
}

// ── Automation schedules ─────────────────────────────────────────────────────
// Strings (API.md): daily@HH:MM, weekdays@HH:MM, weekly@<0-6>@HH:MM, every@<N>m, every@<N>h.
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/** Build a schedule string from builder state. Returns null when the input is invalid. */
export function buildSchedule({ kind, time, day, every, unit } = {}) {
  switch (kind) {
    case 'daily':
    case 'weekdays': {
      const t = normTime(time);
      return t ? `${kind}@${t}` : null;
    }
    case 'weekly': {
      const t = normTime(time);
      const d = Number(day);
      return t && Number.isInteger(d) && d >= 0 && d <= 6 ? `weekly@${d}@${t}` : null;
    }
    case 'every': {
      const n = Number(every);
      const u = unit === 'h' ? 'h' : unit === 'm' ? 'm' : null;
      if (!u || !Number.isInteger(n) || n < 1) return null;
      if (u === 'm' && (n < 5 || n > 1440)) return null;
      if (u === 'h' && n > 168) return null;
      return `every@${n}${u}`;
    }
    default:
      return null;
  }
}

/** Parse a schedule string back into builder state. Unknown strings return null. */
export function parseSchedule(str) {
  const s = String(str || '').trim();
  let m;
  if ((m = /^(daily|weekdays)@(\d{1,2}:\d{2})$/.exec(s))) {
    const time = normTime(m[2]);
    return time ? { kind: m[1], time } : null;
  }
  if ((m = /^weekly@([0-6])@(\d{1,2}:\d{2})$/.exec(s))) {
    const time = normTime(m[2]);
    return time ? { kind: 'weekly', day: Number(m[1]), time } : null;
  }
  if ((m = /^every@(\d+)([mh])$/.exec(s))) return { kind: 'every', every: Number(m[1]), unit: m[2] };
  return null;
}

export function describeSchedule(str) {
  const p = parseSchedule(str);
  if (!p) return str ? `Custom: ${str}` : 'No schedule';
  switch (p.kind) {
    case 'daily': return `Every day at ${p.time}`;
    case 'weekdays': return `Weekdays at ${p.time}`;
    case 'weekly': return `Every ${WEEKDAY_NAMES[p.day]} at ${p.time}`;
    case 'every': return `Every ${p.every} ${p.unit === 'h' ? (p.every === 1 ? 'hour' : 'hours') : 'minutes'}`;
    default: return str;
  }
}

// ── Ask follow-ups ───────────────────────────────────────────────────────────
/** Static follow-up suggestions derived from the question and its scope. */
export function followUps(question, { entityName, topicLabel } = {}) {
  const q = String(question || '').toLowerCase();
  const out = [];
  const subject = topicLabel ? `“${topicLabel}”` : entityName || 'this';
  if (!/owe/.test(q)) out.push(entityName ? `What do I still owe ${entityName}?` : 'What do I still owe here?');
  if (!/deadline|due|when/.test(q)) out.push(`Show every deadline in ${subject}`);
  if (!/attach/.test(q)) out.push('Which attachments have I already sent?');
  if (!/(cost|price|quote|amount|paid|pay|£|€|\$)/.test(q)) out.push(`What amounts were mentioned in ${subject}?`);
  if (!/summar/.test(q)) out.push(`Summarise the last month of ${subject}`);
  return out.slice(0, 3);
}

// ── Settings forms ───────────────────────────────────────────────────────────
const GROUP_ORDER = ['general', 'models', 'budgets', 'embeddings', 'pipeline', 'context', 'triage', 'insights', 'agent', 'plugins', 'ui'];

/** Group config fields ([{ group, key, … }]) into [{ group, fields }] in a stable order. */
export function groupFields(fields) {
  const map = new Map();
  for (const f of fields || []) {
    const g = f.group || 'other';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(f);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .map(([group, list]) => ({ group, fields: list }));
}

export function groupTitle(group) {
  const titles = { general: 'General', models: 'Model gateway', budgets: 'Daily budgets', embeddings: 'Embeddings', pipeline: 'Pipeline', context: 'Context engine', triage: 'Triage', insights: 'Insights', agent: 'Agent', plugins: 'Plugins', ui: 'Interface' };
  return titles[group] || group.charAt(0).toUpperCase() + group.slice(1);
}

/** Model-id fields get the catalog picker. */
export function isModelField(field) {
  return Boolean(field && (/^llm\.models\./.test(field.key) || field.key === 'embeddings.model'));
}

/**
 * Turn a form draft into a PATCH body: only changed keys, typed per field. Returns
 * { patch, errors } where errors maps key → message (JSON parse failures, bad numbers).
 */
export function buildConfigPatch(fields, draft) {
  const patch = {};
  const errors = {};
  for (const f of fields || []) {
    if (!(f.key in (draft || {}))) continue;
    const raw = draft[f.key];
    if (raw === null) { patch[f.key] = null; continue; }
    let v = raw;
    if (f.type === 'number') {
      v = Number(raw);
      if (raw === '' || !Number.isFinite(v)) { errors[f.key] = 'Enter a number'; continue; }
      if (f.min != null && v < f.min) { errors[f.key] = `Minimum ${f.min}`; continue; }
      if (f.max != null && v > f.max) { errors[f.key] = `Maximum ${f.max}`; continue; }
    } else if (f.type === 'boolean') {
      v = Boolean(raw);
    } else if (f.type === 'json') {
      if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { errors[f.key] = 'Not valid JSON'; continue; }
      }
    } else if (f.type === 'secret') {
      if (raw === '••••••••' || (raw === '' && f.value)) continue; // blank keeps the stored secret; Reset clears it
    }
    if (JSON.stringify(v) === JSON.stringify(f.value)) continue;
    patch[f.key] = v;
  }
  return { patch, errors };
}

// ── Charts ───────────────────────────────────────────────────────────────────
/** A "nice" axis maximum ≥ v (1, 2, 2.5, 5 × 10^k). */
export function niceMax(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= n) return m * exp;
  return 10 * exp;
}

/** SVG polyline points for a sparkline of `values` in a w×h box (null values are skipped). */
export function sparkPoints(values, w, h, pad = 2) {
  const pts = (values || []).map((v, i) => [i, v == null ? null : Number(v)]).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return '';
  const max = Math.max(...pts.map(([, v]) => v));
  const min = Math.min(...pts.map(([, v]) => v));
  const span = max - min || 1;
  const n = Math.max(1, (values.length || 1) - 1);
  return pts.map(([i, v]) => {
    const x = pad + (i / n) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// ── Plugins ──────────────────────────────────────────────────────────────────
/** Guess the install source from what the admin typed. */
export function installSource(location) {
  const s = String(location || '').trim();
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /\.git$/.test(s)) return 'git';
  return 'dir';
}

/** Two-letter monogram for a plugin tile ("Receipts" → "Rc", "Send guard" → "Sg"). */
export function pluginMonogram(name, id) {
  const src = String(name || id || '?').trim();
  const words = src.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0].toUpperCase() + words[1][0].toLowerCase());
  const w = words[0] || '?';
  if (w.length <= 2) return w.charAt(0).toUpperCase() + w.slice(1);
  const consonant = w.slice(1).match(/[bcdfghjklmnpqrstvwxz]/i);
  return w[0].toUpperCase() + (consonant ? consonant[0].toLowerCase() : w[1].toLowerCase());
}

/** Initial grant selection for the enable dialog: required + already granted on; optional off. */
export function initialGrants(permissions) {
  return (permissions || []).filter((p) => p.granted || !p.optional).map((p) => p.name);
}

/** Stable colour index for a string (plugin tiles, avatars). */
export function hashIndex(str, n) {
  let h = 0;
  for (const ch of String(str || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return n > 0 ? h % n : 0;
}
