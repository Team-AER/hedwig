// Prompt registry: every structured model call in Hedwig v2 is a named, versioned prompt.
//
//   definePrompt({ id, version, tier, system, user, schema, maxTokens, temperature, batch?, feature?, reasoning? })
//   const { data, provenance } = await runPrompt(id, vars, { userId, feature, lane, escalate, signal })
//
// Files: one prompt per file, `prompts/<id>.js` (the id has a dot, e.g. `sort.reflex.js`), whose
// default export is the definePrompt(...) result (or the plain spec). index.js discovers them on the
// first runPrompt, so adding a prompt never means editing this file.
//
// What runPrompt does, in order:
//   - tier → model: reflex → llm.models.fast, reasoning → llm.models.long; escalate: true forces
//     reasoning. llm.js still applies the primary/fallback switch and the lane limits.
//   - response_format json_schema (strict). A model that answers 400 to that, with an error that
//     names response_format / the schema, is retried with json_object (schema in the system prompt)
//     and remembered for that prompt on that model, for this process. Other 400s are thrown.
//   - finish_reason length → max_tokens doubled, up to the model's catalog max_output_tokens.
//   - reasoning traces stripped (llm.js), JSON extracted, validated locally (agent/validate.js,
//     light coercion, unknown properties dropped).
//   - invalid → once more on the same tier with the errors appended → once on the other tier.
//   - batch prompts ({ batch: { key, validateEach } }): the array at data[key] is validated entry by
//     entry; invalid entries are removed and listed in provenance.dropped. All entries invalid
//     counts as an invalid reply.
//   - every call is logged to hedwig_ai_calls with prompt id/version/hash, tier, lane, workflow.
//   - X-Workflow: <prompt id> and X-Session-ID: hedwig on every request (llm.js).
//
// provenance = { aiCallId, promptId, promptVersion, promptHash, model, tier, fellBack, tokensIn,
//                tokensOut, attempts, escalated, repaired, dropped }
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chat, extractJson, outputCap, activeModels, LlmError } from '../llm.js';
import { getConfig } from '../config.js';
import { validateSchema } from '../agent/validate.js';

export const TIERS = { reflex: 'fast', reasoning: 'long' };
const OTHER_TIER = { reflex: 'reasoning', reasoning: 'reflex' };
const ID_RE = /^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/;
const DIR = dirname(fileURLToPath(import.meta.url));

const registry = new Map();          // id -> frozen prompt
const jsonSchemaRejected = new Set(); // `${promptId}\n${model}` pairs whose json_schema the model refused
const schemaKey = (promptId, model) => `${promptId}\n${model}`;
/** A 400 that is about the response format or schema (not about the request as a whole). */
const SCHEMA_REJECTION = /response_format|json_schema|\bschema\b|structured output|guided_json|grammar/i;
let loading = null;

export class PromptOutputError extends LlmError {
  constructor(promptId, errors, provenance) {
    super(`prompt ${promptId} produced no valid output: ${errors.slice(0, 5).join('; ')}`, { status: 502, code: 'invalid_output' });
    this.name = 'PromptOutputError';
    this.errors = errors;
    this.provenance = provenance;
  }
}

function hashOf(spec) {
  const material = JSON.stringify({
    version: spec.version,
    tier: spec.tier,
    system: typeof spec.system === 'function' ? spec.system.toString() : spec.system,
    user: typeof spec.user === 'function' ? spec.user.toString() : spec.user,
    schema: spec.schema,
    batch: spec.batch || null,
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
    reasoning: spec.reasoning || null,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Register a prompt. Re-registering the same id with identical content is a no-op (modules may be
 * imported twice); a different body under the same id throws, since that would make provenance lie.
 */
export function definePrompt(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('definePrompt needs a spec object');
  const { id, version, tier } = spec;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`prompt id "${id}" must look like area.name`);
  if (typeof version !== 'string' || !version) throw new Error(`prompt ${id} needs a version string`);
  if (!(tier in TIERS)) throw new Error(`prompt ${id}: tier must be reflex or reasoning`);
  if (typeof spec.system !== 'string' && typeof spec.system !== 'function') throw new Error(`prompt ${id} needs a system prompt`);
  if (typeof spec.user !== 'string' && typeof spec.user !== 'function') throw new Error(`prompt ${id} needs a user template or function`);
  if (!spec.schema || typeof spec.schema !== 'object') throw new Error(`prompt ${id} needs a JSON schema`);
  if (spec.batch) {
    const { key, validateEach } = spec.batch;
    if (typeof key !== 'string' || !validateEach || typeof validateEach !== 'object') throw new Error(`prompt ${id}: batch needs { key, validateEach }`);
  }
  const prompt = Object.freeze({
    ...spec,
    maxTokens: Number.isFinite(spec.maxTokens) ? spec.maxTokens : 1024,
    temperature: Number.isFinite(spec.temperature) ? spec.temperature : 0,
    feature: spec.feature || id.split('.')[0],
    hash: null,
  });
  const hash = hashOf(prompt);
  const existing = registry.get(id);
  if (existing) {
    if (existing.hash === hash) return existing;
    throw new Error(`prompt ${id} is already defined with different content (bump its id or reuse the file)`);
  }
  const frozen = Object.freeze({ ...prompt, hash });
  registry.set(id, frozen);
  return frozen;
}

/** Import every prompts/<id>.js once. A broken file is logged and skipped, not fatal. */
export function loadPrompts() {
  if (!loading) {
    loading = (async () => {
      let names;
      try { names = await readdir(DIR); } catch { names = []; }
      const files = names.filter((f) => /^[^.]+(\.[^.]+)+\.js$/.test(f) && !/\.test\.js$/.test(f) && !/\.testutil\.js$/.test(f));
      for (const f of files.sort()) {
        try {
          const mod = await import(pathToFileURL(`${DIR}/${f}`).href);
          const spec = mod.default;
          if (spec && typeof spec === 'object' && spec.id && !registry.has(spec.id)) definePrompt(spec);
        } catch (err) {
          console.error(`[hedwig] prompt file ${f} failed to load:`, err?.message || err);
        }
      }
    })();
  }
  return loading;
}

export async function getPrompt(id) {
  if (!registry.has(id)) await loadPrompts();
  return registry.get(id) || null;
}

/** For the admin page: id, version, hash, tier of every registered prompt. */
export async function listPrompts() {
  await loadPrompts();
  return [...registry.values()]
    .map((p) => ({ id: p.id, version: p.version, hash: p.hash, tier: p.tier, feature: p.feature, maxTokens: p.maxTokens, batch: Boolean(p.batch) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function render(part, vars) {
  return typeof part === 'function' ? String(part(vars) ?? '') : renderTemplate(part, vars || {});
}

/** The schema with the batch array's item schema removed: entries are checked one by one instead. */
function envelopeSchema(p) {
  if (!p.batch) return p.schema;
  const props = { ...(p.schema.properties || {}) };
  if (props[p.batch.key]) {
    const rest = { ...props[p.batch.key] };
    delete rest.items;
    props[p.batch.key] = rest;
  }
  return { ...p.schema, properties: props };
}

function checkOutput(p, content) {
  const data = extractJson(content);
  if (data === null || typeof data !== 'object') return { ok: false, errors: ['the reply was not a JSON object'] };
  const top = validateSchema(envelopeSchema(p), data, { coerce: true, dropUnknown: true });
  if (!top.ok) return { ok: false, errors: top.errors };
  if (!p.batch) return { ok: true, data: top.value, dropped: [] };
  const entries = Array.isArray(top.value[p.batch.key]) ? top.value[p.batch.key] : [];
  const kept = [];
  const dropped = [];
  entries.forEach((entry, index) => {
    const r = validateSchema(p.batch.validateEach, entry, { coerce: true, dropUnknown: true });
    if (r.ok) kept.push(r.value);
    else dropped.push({ index, entry, errors: r.errors.map((e) => e.replace(/^\$/, `${p.batch.key}[${index}]`)) });
  });
  if (entries.length && !kept.length) {
    return { ok: false, errors: dropped.slice(0, 3).flatMap((d) => d.errors.map((e) => (e.startsWith(p.batch.key) ? e : `${p.batch.key}[${d.index}].${e}`))) };
  }
  return { ok: true, data: { ...top.value, [p.batch.key]: kept }, dropped };
}

function schemaName(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Run a registered prompt.
 * @param {string} id
 * @param {object} vars   template variables / argument to the prompt's user() function
 * @param {{ userId?: string, feature?: string, lane?: 'interactive'|'background', escalate?: boolean,
 *           signal?: AbortSignal, pluginId?: string, fetchFn?: Function }} [opts]
 * @returns {Promise<{ data: any, provenance: object }>}
 */
export async function runPrompt(id, vars = {}, opts = {}) {
  const p = await getPrompt(id);
  if (!p) throw new LlmError(`unknown prompt ${id}`, { status: 400, code: 'unknown_prompt' });
  const { userId, lane, escalate = false, signal, pluginId, fetchFn } = opts;
  const feature = opts.feature || p.feature;
  const cfg = await getConfig(userId);
  const startTier = escalate ? 'reasoning' : p.tier;
  const system = render(p.system, vars);
  const user = render(p.user, vars);
  const base = [{ role: 'system', content: system }, { role: 'user', content: user }];

  const provenance = {
    aiCallId: null, promptId: p.id, promptVersion: p.version, promptHash: p.hash, model: null, tier: startTier,
    fellBack: false, tokensIn: 0, tokensOut: 0, attempts: 0, escalated: startTier !== p.tier, repaired: false,
    dropped: [],
  };

  async function call(tier, messages) {
    const role = TIERS[tier];
    const active = (await activeModels(userId))[role]?.active || cfg[`llm.models.${role}`];
    let cap = await outputCap(active, cfg, { fetchFn });
    let maxTokens = Math.min(p.maxTokens, cap);
    for (;;) {
      const useSchema = !jsonSchemaRejected.has(schemaKey(p.id, active));
      const send = (schemaMode) => chat({
        userId, feature, pluginId, role, lane, signal, fetchFn,
        messages: schemaMode ? messages : withSchemaInstruction(messages, p.schema),
        maxTokens, temperature: p.temperature, reasoning: p.reasoning,
        responseFormat: schemaMode
          ? { type: 'json_schema', json_schema: { name: schemaName(p.id), strict: true, schema: p.schema } }
          : { type: 'json_object' },
        workflow: p.id,
        prompt: { id: p.id, version: p.version, hash: p.hash, tier },
      });
      let res;
      provenance.attempts++;
      if (useSchema) {
        try {
          res = await send(true);
        } catch (err) {
          if (!(err instanceof LlmError) || err.status !== 400 || err.code !== 'llm_error' || !SCHEMA_REJECTION.test(err.message || '')) throw err;
          res = await send(false);
          jsonSchemaRejected.add(schemaKey(p.id, active));
          console.warn(`[hedwig] model ${active} rejected the json_schema of ${p.id}; using json_object for that prompt on it from now on`);
        }
      } else {
        res = await send(false);
      }
      provenance.tokensIn += Number(res.usage?.prompt_tokens) || 0;
      provenance.tokensOut += Number(res.usage?.completion_tokens) || 0;
      provenance.aiCallId = res.aiCallId ?? provenance.aiCallId;
      provenance.model = res.model;
      provenance.fellBack = Boolean(res.fellBack);
      provenance.tier = tier;
      if (res.finishReason === 'length') {
        cap = await outputCap(res.model, cfg, { fetchFn });
        if (maxTokens < cap) {
          maxTokens = Math.min(cap, maxTokens * 2);
          continue;
        }
        return { res, truncatedAt: maxTokens };
      }
      return { res, truncatedAt: null };
    }
  }

  const steps = [
    { tier: startTier, repair: false },
    { tier: startTier, repair: true },
    { tier: OTHER_TIER[startTier], repair: false },
  ];
  let lastErrors = [];
  let lastContent = '';
  for (const step of steps) {
    const messages = step.repair
      ? [...base,
        { role: 'assistant', content: String(lastContent || '').slice(0, 6000) },
        { role: 'user', content: `That reply did not match the required JSON schema: ${lastErrors.slice(0, 8).join('; ')}. Reply again with only the corrected JSON.` }]
      : base;
    const { res, truncatedAt } = await call(step.tier, messages);
    const checked = checkOutput(p, res.content);
    if (checked.ok) {
      provenance.repaired = step.repair || step.tier !== startTier;
      provenance.escalated = step.tier !== p.tier;
      provenance.dropped = checked.dropped;
      return { data: checked.data, provenance };
    }
    lastErrors = truncatedAt ? [`the reply was cut off at ${truncatedAt} tokens`, ...checked.errors] : checked.errors;
    lastContent = res.content;
    console.warn(`[hedwig] prompt ${p.id}@${p.version} on ${res.model}: invalid output (${lastErrors.slice(0, 3).join('; ')})`);
  }
  throw new PromptOutputError(p.id, lastErrors, provenance);
}

function withSchemaInstruction(messages, schema) {
  const [first, ...rest] = messages;
  const note = `\n\nReply with a single JSON object, and nothing else, that matches this JSON schema:\n${JSON.stringify(schema)}`;
  if (first?.role === 'system') return [{ ...first, content: `${first.content}${note}` }, ...rest];
  return [{ role: 'system', content: note.trim() }, ...messages];
}

/** Test hook. */
export function _resetPrompts({ keepFiles = false } = {}) {
  jsonSchemaRejected.clear();
  if (!keepFiles) {
    registry.clear();
    loading = null;
  }
}
