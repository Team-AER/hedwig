// Rules engine for sorting. A rule is ordered, has conditions and actions:
//
//   conditions: { match: 'all' | 'any', items: [{ field, op, value, name? }] }
//   actions:    [{ type, value? }]
//
// Fields: from, fromDomain, sender (address or domain), to, cc, recipient, subject, body, header
// (with `name`), account, folder, hasAttachment, attachment (file name), list (List-Id / list mail),
// and model predicates: kind (stream, bundle or sender kind), confidence (op under/over) and
// matches ("<description>", judged by Reflex, which gets the descriptions with each batch).
// Actions: stream, bundle, label, notify. snooze, plugin and webhook are declared but not available
// yet and are rejected with a clear error.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { addressesOf } from '../text.js';
import { MESSAGE_COLUMNS } from '../pipeline.js';
import { headerMap, senderKeys, isListMail } from './headers.js';
import { senderKind } from '../triage/signals.js';

export const FIELDS = Object.freeze(['from', 'fromDomain', 'sender', 'to', 'cc', 'recipient', 'subject', 'body', 'header', 'account',
  'folder', 'hasAttachment', 'attachment', 'list', 'kind', 'confidence', 'matches']);
export const MODEL_FIELDS = Object.freeze(new Set(['kind', 'confidence', 'matches']));
export const OPS = Object.freeze(['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'exists', 'under', 'over']);
export const ACTIONS = Object.freeze(['stream', 'bundle', 'label', 'notify']);
export const STUB_ACTIONS = Object.freeze(['snooze', 'plugin', 'webhook']);
export const STREAMS = Object.freeze(['people', 'reading', 'records', 'spam']);

const MAX_VALUE = 500;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Validate and normalise a rule body. Throws a 400 error naming every problem.
 * @returns {{ name, enabled, conditions, actions }}
 */
export function validateRule(input, { bundleKeys = null } = {}) {
  const errors = [];
  const name = String(input?.name || '').trim().slice(0, 120);
  if (!name) errors.push('name is required');
  const c = input?.conditions || {};
  const match = c.match === 'any' ? 'any' : 'all';
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length) errors.push('conditions.items needs at least one condition');
  if (items.length > 20) errors.push('at most 20 conditions');
  const outItems = items.slice(0, 20).map((it, i) => {
    const field = String(it?.field || '');
    const op = String(it?.op || (field === 'matches' ? 'is' : field === 'confidence' ? 'under' : 'contains'));
    if (!FIELDS.includes(field)) errors.push(`condition ${i + 1}: unknown field "${field}"`);
    if (!OPS.includes(op)) errors.push(`condition ${i + 1}: unknown op "${op}"`);
    if (field === 'confidence' && !['under', 'over'].includes(op)) errors.push(`condition ${i + 1}: confidence takes under or over`);
    if (['under', 'over'].includes(op) && field !== 'confidence') errors.push(`condition ${i + 1}: ${op} only applies to confidence`);
    let value = it?.value;
    if (field === 'hasAttachment') value = value === undefined ? true : value === true || value === 'true';
    else if (field === 'confidence') {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`condition ${i + 1}: confidence must be between 0 and 1`);
    } else if (op !== 'exists') {
      value = String(value ?? '').trim().slice(0, MAX_VALUE);
      if (!value) errors.push(`condition ${i + 1}: value is required`);
    }
    const out = { field, op, value };
    if (field === 'header') {
      const hn = String(it?.name || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(hn)) errors.push(`condition ${i + 1}: header needs a name`);
      out.name = hn;
    }
    return out;
  });
  const actions = Array.isArray(input?.actions) ? input.actions : [];
  if (!actions.length) errors.push('actions needs at least one action');
  const outActions = actions.slice(0, 10).map((a, i) => {
    const type = String(a?.type || '');
    if (STUB_ACTIONS.includes(type)) { errors.push(`action ${i + 1}: "${type}" is not available yet (planned); use stream, bundle, label or notify`); return null; }
    if (!ACTIONS.includes(type)) { errors.push(`action ${i + 1}: unknown action "${type}"`); return null; }
    if (type === 'notify') return { type };
    const value = String(a?.value ?? '').trim().slice(0, 64);
    if (type === 'stream' && !STREAMS.includes(value)) errors.push(`action ${i + 1}: stream must be one of ${STREAMS.join(', ')}`);
    if (type === 'bundle' && bundleKeys && !bundleKeys.includes(value)) errors.push(`action ${i + 1}: unknown bundle "${value}"`);
    if (type === 'label' && !value) errors.push(`action ${i + 1}: label needs a value`);
    return { type, value };
  }).filter(Boolean);
  if (errors.length) throw httpError(400, errors.join('; '));
  return { name, enabled: input?.enabled !== false, conditions: { match, items: outItems }, actions: outActions };
}

export function hasModelPredicates(rule) {
  return (rule?.conditions?.items || []).some((c) => MODEL_FIELDS.has(c.field));
}

function textOp(op, hay, value) {
  const list = Array.isArray(hay) ? hay : [hay];
  const v = String(value ?? '').toLowerCase();
  const vals = list.map((h) => String(h ?? '').toLowerCase());
  switch (op) {
    case 'is': return vals.some((h) => h === v);
    case 'isNot': return vals.every((h) => h !== v);
    case 'contains': return vals.some((h) => h.includes(v));
    case 'notContains': return vals.every((h) => !h.includes(v));
    case 'startsWith': return vals.some((h) => h.startsWith(v));
    case 'endsWith': return vals.some((h) => h.endsWith(v));
    case 'exists': return vals.some((h) => h !== '');
    default: return false;
  }
}

/**
 * Evaluate one condition against a message context.
 * @param {object} c condition
 * @param {object} m { row, headers, keys, text, decision: { stream, bundle, confidence }, ruleMatches: string[], ruleId }
 * @returns {boolean|null} null when a model predicate cannot be judged yet (no model output)
 */
export function evalCondition(c, m) {
  const row = m.row || {};
  const headers = m.headers || headerMap(row);
  const keys = m.keys || senderKeys(row, headers);
  const to = addressesOf(row.to_addresses).map((a) => a.email);
  const cc = addressesOf(row.cc_addresses).map((a) => a.email);
  const atts = (Array.isArray(row.attachments) ? row.attachments : []).map((a) => a?.filename || a?.name || '');
  switch (c.field) {
    case 'from': return textOp(c.op, [keys.address, row.from_name].filter(Boolean), c.value);
    case 'fromDomain': {
      const d = keys.domain || '';
      if (c.op === 'is') return d === String(c.value).toLowerCase() || d.endsWith(`.${String(c.value).toLowerCase()}`);
      return textOp(c.op, d, c.value);
    }
    case 'sender': {
      const v = String(c.value).toLowerCase();
      if (c.op !== 'is' && c.op !== 'isNot') return textOp(c.op, keys.address, v);
      const hit = v.includes('@') ? keys.address === v : Boolean(keys.domain && (keys.domain === v || keys.domain.endsWith(`.${v}`)));
      return c.op === 'is' ? hit : !hit;
    }
    case 'to': return textOp(c.op, to, c.value);
    case 'cc': return textOp(c.op, cc, c.value);
    case 'recipient': return textOp(c.op, [...to, ...cc], c.value);
    case 'subject': return textOp(c.op, row.subject || '', c.value);
    case 'body': return textOp(c.op, m.text ?? row.body_text ?? row.snippet ?? '', c.value);
    case 'header': return textOp(c.op, headers[c.name] ?? '', c.value);
    case 'account': return textOp(c.op, String(row.account_id || ''), c.value);
    case 'folder': return textOp(c.op, row.folder || '', c.value);
    case 'hasAttachment': return Boolean(row.has_attachments || atts.length) === Boolean(c.value);
    case 'attachment': return textOp(c.op, atts, c.value);
    case 'list': {
      if (c.op === 'exists') return isListMail(row, headers);
      return textOp(c.op, [keys.list, headers['list-id']].filter(Boolean), c.value);
    }
    case 'kind': {
      const d = m.decision;
      if (!d) return null;
      const kinds = [d.stream, d.bundle, senderKind(keys.address)].filter(Boolean);
      return textOp(c.op === 'contains' ? 'is' : c.op, kinds, c.value);
    }
    case 'confidence': {
      const conf = m.decision?.confidence;
      if (conf === undefined || conf === null) return null;
      return c.op === 'under' ? conf < c.value : conf > c.value;
    }
    case 'matches': {
      if (!Array.isArray(m.ruleMatches)) return null;
      return m.ruleMatches.includes(String(m.ruleId));
    }
    default: return false;
  }
}

/**
 * Whether a rule matches. `null` = depends on a model predicate that has no output yet.
 */
export function ruleMatches(rule, m) {
  if (!rule?.enabled) return false;
  const items = rule.conditions?.items || [];
  if (!items.length) return false;
  const results = items.map((c) => evalCondition(c, { ...m, ruleId: rule.id }));
  if (rule.conditions?.match === 'any') {
    if (results.some((r) => r === true)) return true;
    return results.some((r) => r === null) ? null : false;
  }
  if (results.some((r) => r === false)) return false;
  return results.some((r) => r === null) ? null : true;
}

/** Fold a rule's actions into an effect { stream?, bundle?, labels: [], notify }. */
export function ruleEffect(rule) {
  const eff = { labels: [], notify: false };
  for (const a of rule.actions || []) {
    if (a.type === 'stream') eff.stream = a.value;
    else if (a.type === 'bundle') eff.bundle = a.value;
    else if (a.type === 'label') eff.labels.push(a.value);
    else if (a.type === 'notify') eff.notify = true;
  }
  return eff;
}

/**
 * First matching rule (in order) that decides a stream or bundle, plus labels/notify from every
 * matching rule. `phase`: 'pre' evaluates rules without model predicates; 'post' evaluates the
 * model-predicate rules once a decision exists.
 */
export function applyRules(rules, m, { phase = 'pre' } = {}) {
  const out = { rule: null, effect: null, labels: [], notify: false, matched: [] };
  for (const rule of rules || []) {
    const model = hasModelPredicates(rule);
    if ((phase === 'pre' && model) || (phase === 'post' && !model)) continue;
    if (ruleMatches(rule, m) !== true) continue;
    const eff = ruleEffect(rule);
    out.matched.push(rule.id);
    out.labels.push(...eff.labels);
    if (eff.notify) out.notify = true;
    if (!out.rule && (eff.stream || eff.bundle)) { out.rule = rule; out.effect = eff; }
  }
  out.labels = [...new Set(out.labels)];
  return out;
}

/** Rules whose `matches` descriptions Reflex should judge, as [{ id, description }]. */
export function matchDescriptions(rules) {
  const out = [];
  for (const r of rules || []) {
    if (!r.enabled) continue;
    for (const c of r.conditions?.items || []) if (c.field === 'matches') out.push({ id: String(r.id), description: String(c.value).slice(0, 200) });
  }
  return out.slice(0, 20);
}

// ── Gmail filter import (stub: the common fields only) ─────────────────────

function xmlAttr(tag, attr) {
  const m = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  const v = m ? (m[1] ?? m[2]) : null;
  return v === null ? null : v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Parse a Gmail filters export (mailFilters.xml) into rule bodies. Reads from, to, subject and
 * label; anything else in an entry is ignored and reported in `skipped`.
 */
export function parseGmailFilters(xml) {
  const rules = [];
  const skipped = [];
  const entries = String(xml || '').match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  entries.forEach((entry, i) => {
    const props = {};
    for (const tag of entry.match(/<apps:property\b[^>]*>/gi) || []) {
      const name = xmlAttr(tag, 'name');
      const value = xmlAttr(tag, 'value');
      if (name) props[name] = value;
    }
    const items = [];
    if (props.from) items.push({ field: 'from', op: 'contains', value: props.from.slice(0, MAX_VALUE) });
    if (props.to) items.push({ field: 'recipient', op: 'contains', value: props.to.slice(0, MAX_VALUE) });
    if (props.subject) items.push({ field: 'subject', op: 'contains', value: props.subject.slice(0, MAX_VALUE) });
    const actions = [];
    if (props.label) actions.push({ type: 'label', value: props.label.slice(0, 64) });
    const unknown = Object.keys(props).filter((k) => !['from', 'to', 'subject', 'label'].includes(k) && !k.startsWith('size'));
    if (!items.length || !actions.length) { skipped.push({ entry: i + 1, reason: 'needs from/to/subject and a label', ignored: unknown }); return; }
    const what = props.from || props.to || props.subject;
    rules.push({ name: `Gmail: ${what} → ${props.label}`.slice(0, 120), enabled: true, conditions: { match: 'all', items }, actions, ignored: unknown });
  });
  return { rules, skipped };
}

// ── Storage ─────────────────────────────────────────────────────────────────

const RULE_COLUMNS = 'id, position, name, enabled, conditions, actions, source, created_from_correction_id, hits, last_hit_at, created_at, updated_at';

export async function loadRules(userId, { enabledOnly = true } = {}) {
  const { rows } = await query(
    `SELECT ${RULE_COLUMNS} FROM hedwig_rules WHERE user_id = $1 ${enabledOnly ? 'AND enabled' : ''} ORDER BY position, created_at`,
    [userId],
  );
  return rows;
}

async function bundleKeys(userId) {
  const { rows } = await query('SELECT key FROM hedwig_bundles WHERE user_id = $1', [userId]);
  return rows.length ? rows.map((r) => r.key) : null;
}

export async function createRule(userId, input, { source = 'user', correctionId = null } = {}) {
  const rule = validateRule(input, { bundleKeys: await bundleKeys(userId) });
  const cfg = await getConfig(userId);
  const { rows: count } = await query('SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS pos FROM hedwig_rules WHERE user_id = $1', [userId]);
  if (count[0].n >= cfg['rules.maxPerUser']) throw httpError(409, `You have ${count[0].n} rules; the limit is ${cfg['rules.maxPerUser']} (rules.maxPerUser)`);
  const position = Number.isFinite(Number(input?.position)) ? Number(input.position) : count[0].pos + 10;
  const { rows } = await query(
    `INSERT INTO hedwig_rules (user_id, position, name, enabled, conditions, actions, source, created_from_correction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RULE_COLUMNS}`,
    [userId, position, rule.name, rule.enabled, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), source,
      correctionId === null || correctionId === undefined ? null : String(correctionId)],
  );
  return rows[0];
}

export async function updateRule(userId, id, input) {
  const { rows: cur } = await query(`SELECT ${RULE_COLUMNS} FROM hedwig_rules WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!cur[0]) throw httpError(404, 'Rule not found');
  const merged = { ...cur[0], ...input, conditions: input?.conditions ?? cur[0].conditions, actions: input?.actions ?? cur[0].actions };
  const rule = validateRule(merged, { bundleKeys: await bundleKeys(userId) });
  const position = Number.isFinite(Number(input?.position)) ? Number(input.position) : cur[0].position;
  const { rows } = await query(
    `UPDATE hedwig_rules SET name = $3, enabled = $4, conditions = $5, actions = $6, position = $7, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING ${RULE_COLUMNS}`,
    [id, userId, rule.name, rule.enabled, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), position],
  );
  return rows[0];
}

export async function deleteRule(userId, id) {
  const { rowCount } = await query('DELETE FROM hedwig_rules WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw httpError(404, 'Rule not found');
  return { deleted: true };
}

export async function bumpHits(userId, ruleIds) {
  const ids = [...new Set(ruleIds.filter(Boolean))];
  if (!ids.length) return;
  await query('UPDATE hedwig_rules SET hits = hits + 1, last_hit_at = NOW() WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, ids]);
}

async function scanHistory(rule, userId, { limit = 2000, onMatch }) {
  const r = rule.id ? rule : { ...validateRule(rule), id: 'draft' };
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, s.stream AS s_stream, s.bundle AS s_bundle, s.confidence AS s_confidence, s.rule_matches AS s_rule_matches,
            s.layer AS s_layer
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       LEFT JOIN hedwig_sort s ON s.message_id = m.id AND s.user_id = a.user_id
      WHERE a.user_id = $1 AND NOT m.is_deleted
      ORDER BY m.date DESC NULLS LAST
      LIMIT $2`,
    [userId, Math.max(1, Math.min(10000, Number(limit) || 2000))],
  );
  const matchesItems = (r.conditions?.items || []).filter((c) => c.field === 'matches');
  const approximate = matchesItems.length > 0;
  const words = matchesItems.flatMap((c) => String(c.value).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
  for (const row of rows) {
    const decision = row.s_stream ? { stream: row.s_stream, bundle: row.s_bundle, confidence: row.s_confidence === null ? null : Number(row.s_confidence) } : null;
    let ruleMatchesList = Array.isArray(row.s_rule_matches) && row.s_rule_matches.includes(String(r.id)) ? row.s_rule_matches : null;
    if (!ruleMatchesList && approximate) {
      const hay = `${row.subject || ''} ${row.from_name || ''} ${row.from_email || ''} ${row.snippet || ''}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      ruleMatchesList = hits >= Math.min(2, words.length) && words.length ? [String(r.id)] : [];
    }
    if (ruleMatches({ ...r, enabled: true }, { row, decision, ruleMatches: ruleMatchesList || [] }) === true) onMatch(row);
  }
  return { scanned: rows.length, approximate };
}

/**
 * Run a rule (saved or draft) over the user's recent history without changing anything.
 * Model predicates read the stored sorting decision; `matches` uses the Reflex verdicts stored for
 * this rule and otherwise a keyword approximation, reported as `approximate`.
 * @returns {{ matched, scanned, approximate, sample: Array }}
 */
export async function dryRun(rule, userId, { limit = 2000, sampleSize = 10 } = {}) {
  const sample = [];
  let matched = 0;
  const { scanned, approximate } = await scanHistory(rule, userId, {
    limit,
    onMatch: (row) => {
      matched++;
      if (sample.length < sampleSize) {
        sample.push({ messageId: row.id, from: { name: row.from_name, email: row.from_email }, subject: row.subject, date: row.date, stream: row.s_stream || null });
      }
    },
  });
  return { matched, scanned, approximate, sample };
}

/** Ids of recent sorted messages a (non-model) rule matches and the user has not corrected by hand. */
export async function matchingMessageIds(rule, userId, { limit = 2000 } = {}) {
  if (hasModelPredicates(rule)) return [];
  const ids = [];
  await scanHistory(rule, userId, { limit, onMatch: (row) => { if (row.s_layer && row.s_layer !== 'user') ids.push(row.id); } });
  return ids;
}

/** Row → sender-scope rule body for "always" corrections. Exported for tests. */
export function ruleForCorrection({ always, row, keys, after, before }) {
  const actions = [];
  if (after.stream) actions.push({ type: 'stream', value: after.stream });
  if (after.bundle) actions.push({ type: 'bundle', value: after.bundle });
  if (!actions.length) return null;
  const target = after.bundle ? `${after.stream || before.stream} · ${after.bundle}` : after.stream;
  if (always === 'sender' && keys.address) {
    return { name: `Mail from ${keys.address} → ${target}`, conditions: { match: 'all', items: [{ field: 'sender', op: 'is', value: keys.address }] }, actions };
  }
  if (always === 'list') {
    if (keys.list) return { name: `List ${keys.list} → ${target}`, conditions: { match: 'all', items: [{ field: 'list', op: 'is', value: keys.list }] }, actions };
    if (keys.domain) return { name: `Mail from ${keys.domain} → ${target}`, conditions: { match: 'all', items: [{ field: 'sender', op: 'is', value: keys.domain }] }, actions };
  }
  if (always === 'kind') {
    if (before.bundle) return { name: `${before.bundle} mail → ${target}`, conditions: { match: 'all', items: [{ field: 'kind', op: 'is', value: before.bundle }] }, actions };
    const what = (row.subject || '').replace(/^(?:\s*(?:re|fwd?)\s*:\s*)+/i, '').slice(0, 80);
    return { name: `Mail like “${what}” → ${target}`, conditions: { match: 'all', items: [{ field: 'matches', op: 'is', value: `mail like “${what}” from ${keys.domain || keys.address}` }] }, actions };
  }
  return null;
}
