// The labels module's view of its neighbours. Streams A (retrieve), B (prompt registry,
// corrections) and C (sorting) are built in parallel; everything labels needs from them goes
// through this file. Each dependency is imported lazily: when it exists it is used as-is, and when
// it does not yet exist a thin local equivalent keeps labels working (and says so once in the log).
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../../services/db.js';
import { chat, extractJson, LlmError } from '../llm.js';
import * as validate from '../agent/validate.js';
import { enqueue } from '../jobs.js';
import labelsJudge from '../prompts/labels.judge.js';
import labelsQuestion from '../prompts/labels.question.js';
import askGenerate from '../prompts/ask.generate.js';
import askVerify from '../prompts/ask.verify.js';

export const OWN_PROMPTS = [labelsJudge, labelsQuestion, askGenerate, askVerify];
const OWN_BY_ID = new Map(OWN_PROMPTS.map((p) => [p.id, p]));

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[hedwig] labels: ${message}`);
}

// Loaded modules, cached per process. Only a missing file falls back to a shim; a module that exists
// but fails to load is a bug and surfaces. A missing module is re-checked after a minute so a stream
// that lands while the worker runs is picked up without a restart.
const cache = new Map(); // specifier -> { mod, at }
const RECHECK_MS = 60_000;
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

let loaders = {};
const defaultLoader = (spec) => (existsSync(here(spec)) ? import(/* @vite-ignore */ spec) : null);

async function optional(spec) {
  const hit = cache.get(spec);
  if (hit && (hit.mod || Date.now() - hit.at < RECHECK_MS)) return hit.mod;
  const mod = await (loaders[spec] ? loaders[spec]() : defaultLoader(spec));
  cache.set(spec, { mod: mod || null, at: Date.now() });
  return mod || null;
}

/** Test hook: replace how one optional module loads (return null for "missing"). */
export function _setLoader(spec, fn) {
  loaders[spec] = fn;
  cache.delete(spec);
}
export function _resetRuntime() {
  cache.clear();
  warned.clear();
  loaders = {};
}

// ── Prompts ────────────────────────────────────────────────────────────────

// B's registry discovers every prompts/<id>.js on its own (ours included); registering here is only
// a fallback for a file it could not load.
async function registry() {
  const mod = await optional('../prompts/index.js');
  return mod && typeof mod.runPrompt === 'function' ? mod : null;
}

async function specFor(reg, id) {
  const known = reg && typeof reg.getPrompt === 'function' ? await reg.getPrompt(id) : null;
  if (known) return known;
  const own = OWN_BY_ID.get(id);
  if (own && reg && typeof reg.definePrompt === 'function') {
    try { return reg.definePrompt(own); } catch (err) { console.warn(`[hedwig] labels: could not register ${id}:`, err.message); }
  }
  return own || null;
}

/**
 * Run a prompt through B's registry when it exists, otherwise through the local equivalent below.
 * Resolves `{ data, provenance }` like B's runPrompt.
 */
export async function runPrompt(id, vars, opts = {}) {
  const reg = await registry();
  const spec = await specFor(reg, id);
  if (!spec) throw new LlmError(`unknown prompt ${id}`, { status: 400, code: 'unknown_prompt' });
  if (opts.version && opts.version !== spec.version) {
    throw new LlmError(`prompt ${id} is at version ${spec.version}, not ${opts.version}`, { status: 400, code: 'unknown_prompt_version' });
  }
  // The registry has no per-call model override; an eval run pinned to a model goes through the
  // local path with the registry's own spec, so the prompt text is identical.
  if (reg && !opts.model) return reg.runPrompt(id, vars, opts);
  if (!reg) warnOnce('local-runPrompt', 'prompts/index.js not present; running label prompts through the local shim');
  return localRunPrompt(spec, vars, opts);
}

/**
 * The Reflex opinion on a batch, from C's `sort.reflex` (items are already in its shape).
 * Throws `reflex_unavailable` when sorting's prompt is not installed; the judge then only trusts
 * verdicts that behaviour confirms.
 * Resolves `{ items: [{ id, stream, needs_you, spam, confidence, reason } | null], provenance, promptId }`.
 */
export async function runReflex(items, vars, opts = {}) {
  const reg = await registry();
  if (!(await specFor(reg, 'sort.reflex'))) {
    throw new LlmError('sort.reflex is not registered', { status: 503, code: 'reflex_unavailable' });
  }
  const payload = { rules: [], corrections: [], bundles: [], ...vars, items };
  const { data, provenance } = await runPrompt('sort.reflex', payload, { ...opts, feature: opts.feature || 'labels' });
  return { items: normaliseReflex(data, items), provenance, promptId: 'sort.reflex' };
}

/** Accept C's output in whichever container it uses, matched to our items by id or position. */
export function normaliseReflex(data, items) {
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.results) ? data.results
        : Array.isArray(data?.messages) ? data.messages
          : (data && typeof data === 'object' && data.stream) ? [data] : [];
  const byId = new Map();
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const key = r.id ?? r.messageId ?? r.message_id ?? items[i]?.id;
    if (key != null) byId.set(String(key), r);
  });
  return items.map((it) => {
    const r = byId.get(String(it.id));
    if (!r) return null;
    return {
      id: it.id,
      stream: typeof r.stream === 'string' ? r.stream : null,
      needs_you: typeof r.needs_you === 'boolean' ? r.needs_you : (typeof r.needsYou === 'boolean' ? r.needsYou : null),
      spam: typeof r.spam === 'string' ? r.spam : null,
      confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
      reason: typeof r.reason === 'string' ? r.reason : null,
    };
  });
}

const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();

/**
 * Minimal stand-in for B's runPrompt, also used for eval runs pinned to a model: JSON-schema
 * response format, local validation, one retry with the validation error appended, batch entry
 * validation. Budgets, lanes and call logging are llm.js's.
 */
export async function localRunPrompt(spec, vars, opts = {}) {
  const { userId = null, feature = 'labels', model = null, lane = 'background', fetchFn } = opts;
  const role = spec.tier === 'reflex' ? 'fast' : 'long';
  const messages = [
    { role: 'system', content: spec.system },
    { role: 'user', content: typeof spec.user === 'function' ? spec.user(vars) : String(spec.user) },
  ];
  let lastErrors = null;
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = lastErrors
      ? [...messages, { role: 'assistant', content: res?.content || '' }, { role: 'user', content: `That output was invalid: ${lastErrors.join('; ')}. Reply again with JSON that matches the schema exactly.` }]
      : messages;
    res = await chat({
      userId, feature, role, model: model || undefined, messages: msgs, maxTokens: spec.maxTokens,
      temperature: spec.temperature ?? 0, json: { name: spec.id.replace(/\W/g, '_'), schema: spec.schema }, fetchFn,
      lane, workflow: spec.id, prompt: { id: spec.id, version: spec.version, hash: spec.hash || null, tier: spec.tier },
    });
    const parsed = extractJson(stripThink(res.content));
    if (parsed == null) { lastErrors = ['not JSON']; continue; }
    const out = validateOutput(spec, parsed);
    if (out.ok) {
      return {
        data: out.value,
        provenance: {
          aiCallId: null, promptId: spec.id, promptVersion: spec.version, model: res.model, tier: spec.tier,
          fellBack: Boolean(res.fellBack), tokensIn: res.usage?.prompt_tokens ?? null, tokensOut: res.usage?.completion_tokens ?? null,
          dropped: out.dropped,
        },
      };
    }
    lastErrors = out.errors;
  }
  throw new LlmError(`${spec.id}: model output failed validation (${(lastErrors || []).join('; ')})`);
}

// validateSchema is B's strict validator; validateArgs is the older tool-argument one.
const checkSchema = (schema, value) => (typeof validate.validateSchema === 'function'
  ? validate.validateSchema(schema, value, { coerce: true, dropUnknown: true })
  : validate.validateArgs(schema, value));

/** Validate against the prompt schema; batch prompts keep valid entries and report the dropped. */
export function validateOutput(spec, parsed) {
  if (spec.batch?.key) {
    const list = Array.isArray(parsed?.[spec.batch.key]) ? parsed[spec.batch.key] : null;
    if (!list) return { ok: false, errors: [`${spec.batch.key} must be an array`] };
    const kept = [];
    const dropped = [];
    for (const entry of list) {
      const r = checkSchema(spec.batch.validateEach, entry);
      if (r.ok) kept.push(r.value); else dropped.push({ entry, errors: r.errors });
    }
    if (!kept.length && list.length) return { ok: false, errors: dropped[0].errors };
    return { ok: true, value: { ...parsed, [spec.batch.key]: kept }, dropped };
  }
  const r = checkSchema(spec.schema, parsed);
  return r.ok ? { ok: true, value: r.value, dropped: [] } : { ok: false, errors: r.errors };
}

// ── Corrections (B) ────────────────────────────────────────────────────────

async function tableExists(name) {
  const { rows } = await query('SELECT to_regclass($1) AS t', [name]);
  return Boolean(rows[0]?.t);
}

/**
 * Record a correction. B's recordCorrection when it exists; otherwise a direct insert into
 * hedwig_corrections (B's table) when that exists; otherwise a logged no-op.
 * @param {{ userId, kind, targetId, before?, after?, note?, promptId?, promptVersion? }} c
 */
export async function recordCorrection(c) {
  for (const spec of ['../ledger/corrections.js']) {
    const mod = await optional(spec);
    if (mod && typeof mod.recordCorrection === 'function') return mod.recordCorrection(c);
  }
  if (await tableExists('hedwig_corrections')) {
    warnOnce('corrections-direct', 'recordCorrection() not found; inserting into hedwig_corrections directly');
    const { rows } = await query(
      `INSERT INTO hedwig_corrections (user_id, kind, target_id, before, after, note, prompt_id, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [c.userId, c.kind, String(c.targetId), JSON.stringify(c.before ?? null), JSON.stringify(c.after ?? null),
        c.note ?? null, c.promptId ?? null, c.promptVersion ?? null],
    );
    return rows[0] || null;
  }
  warnOnce('corrections-missing', 'hedwig_corrections does not exist yet; corrections are only kept as gold labels');
  return null;
}

// ── Sorting (C) ────────────────────────────────────────────────────────────

/**
 * Apply a correction the way POST /sort/correct does (it also records the hedwig_corrections row).
 * Uses sorting's function when present. Otherwise, when `queueIfMissing`, enqueues
 * `sort.applyCorrection` with the same body so sorting's worker applies it; else does nothing.
 * @returns {Promise<{ via: 'sort'|'job'|null, result?: any, jobId?: number }>}
 */
export async function applySortCorrection(userId, body, { queueIfMissing = true } = {}) {
  for (const spec of ['../sort/correct.js', '../sort/corrections.js', '../sort/service.js', '../sort/index.js']) {
    const mod = await optional(spec);
    const fn = mod && (mod.applyCorrection || mod.correct || mod.correctSort);
    if (typeof fn === 'function') return { via: 'sort', result: await fn(userId, body) };
  }
  if (!queueIfMissing) return { via: null };
  warnOnce('sort-correct-job', 'sort correction function not found; enqueueing sort.applyCorrection jobs');
  const jobId = await enqueue('sort.applyCorrection', { userId, ...body }, {
    userId, dedupeKey: `sort.applyCorrection:${userId}:${body.messageId}:${body.always || 'one'}`, priority: 3,
  });
  return { via: 'job', jobId };
}

// ── Retrieval (A) ──────────────────────────────────────────────────────────

/**
 * A's retrieve() when present; otherwise the existing context search mapped to the same shape
 * (message-level results, no chunk ids).
 */
export async function retrieve(args) {
  const mod = await optional('../indexer/retrieve.js');
  if (mod && typeof mod.retrieve === 'function') return { ...(await mod.retrieve(args)), via: 'indexer' };
  warnOnce('retrieve-shim', 'indexer/retrieve.js not present; retrieval eval uses context/search.js');
  const { searchMessages } = await import('../context/search.js');
  const { results } = await searchMessages(args.userId, { q: args.query, limit: args.limit || 10 });
  return {
    chunks: (results || []).map((m, i) => ({ chunkId: null, messageId: m.id, threadId: m.thread_key || null, kind: 'body', text: m.snippet || '', score: m.score ?? null, rank: i + 1 })),
    floor: false,
    via: 'context',
  };
}

export { tableExists };
