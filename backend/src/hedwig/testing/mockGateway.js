// Test double for the model gateway. Never call the live gateway from tests; use this instead.
//
//   import { mockGateway } from '../testing/mockGateway.js';
//   const gw = mockGateway();                 // defaults: baseUrl 'http://llm-proxy.cls/v1'
//   gw.install();                             // replaces globalThis.fetch (call gw.restore() after)
//   // or pass gw.fetch as `fetchFn` to chat()/runPrompt()/getCatalog() instead of installing
//
//   gw.on('sort.reflex', { items: [...] });   // route by X-Workflow: a plain object/array = JSON reply
//   gw.on('ask.generate', 'plain text');      // a string = raw content
//   gw.on('sort.reflex', (req) => ...);       // a function of the request, returning any of these
//   gw.on('x', [first, second]);              // a sequence, one per call; the last one repeats
//   gw.on('x', gw.truncated('{"items": ['));  // finish_reason 'length'
//   gw.on('x', gw.reply(data, { finishReason, usage, toolCalls, model }));
//   gw.on('x', gw.error(400, 'response_format json_schema not supported'));
//   gw.on('x', gw.hang());                    // never answers (until the request is aborted)
//   gw.otherwise(handler);                    // for workflows with no route (default: 404, loud)
//
//   gw.calls                                  // every chat request, in order:
//     { url, workflow, sessionId, headers, body, model, messages, text, responseFormat, maxTokens, stream }
//     `text` is every message's content joined, for asserting on prompt contents.
//   gw.callsFor('sort.reflex')                // calls for one workflow
//   gw.embeddings                             // every /embeddings request body
//   gw.reset()                                // clear calls and routes
//
// Also served: GET <origin>/catalog.json (gw.catalogUrl; models with max_output_tokens: Gemma 4096,
// Qwen 32768 by default, override with { catalog }), GET <base>/models, and POST <base>/embeddings
// returning deterministic lexical hash vectors (similar text → similar vector; { dims } default 1024).
// Streaming requests (body.stream) get the reply as SSE deltas plus a usage event.
// Requests to any other URL go to the original fetch.

const DEFAULT_CATALOG = [
  { id: 'google/gemma-4-12B-it-qat-w4a16-ct', capabilities: ['chat', 'reasoning', 'streaming'], max_output_tokens: 4096, reasoning_efforts: ['none', 'high'], status: 'ready' },
  { id: 'Qwen/Qwen3.8-Flash-Next', capabilities: ['chat', 'tools', 'reasoning', 'streaming'], max_output_tokens: 32768, reasoning_efforts: ['off', 'low', 'medium', 'xhigh'], status: 'ready' },
  { id: 'bge-m3', capabilities: ['embeddings'], max_output_tokens: null, reasoning_efforts: [], status: 'ready' },
];

const SPEC = Symbol('mockGatewaySpec');

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic, normalised lexical embedding (token and bigram hashing). */
export function hashVector(text, dims = 1024) {
  const v = new Array(dims).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const feats = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]} ${t}`)];
  for (const f of feats) {
    const h = fnv(f);
    v[h % dims] += (h & 0x80000000) ? -1 : 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const estimate = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

export function mockGateway({ baseUrl = 'http://llm-proxy.cls/v1', catalog = DEFAULT_CATALOG, dims = 1024, catalogUrl } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const catUrl = catalogUrl || `${origin}/catalog.json`;
  const routes = new Map();     // workflow -> { handler, queue }
  let fallbackHandler = null;
  let original = null;

  const gw = {
    baseUrl: base,
    catalogUrl: catUrl,
    calls: [],
    embeddings: [],

    on(workflow, handler) {
      routes.set(workflow, Array.isArray(handler) && !handler[SPEC] ? { queue: [...handler] } : { handler });
      return gw;
    },
    otherwise(handler) { fallbackHandler = handler; return gw; },
    callsFor(workflow) { return gw.calls.filter((c) => c.workflow === workflow); },
    reset() { gw.calls.length = 0; gw.embeddings.length = 0; routes.clear(); fallbackHandler = null; return gw; },

    reply(data, { finishReason = 'stop', usage = null, toolCalls = null, model = null } = {}) {
      return { [SPEC]: true, content: typeof data === 'string' ? data : JSON.stringify(data), finishReason, usage, toolCalls, model };
    },
    truncated(partial = '{"items": [', opts = {}) {
      return gw.reply(partial, { ...opts, finishReason: 'length' });
    },
    error(status = 500, message = 'mock gateway error') {
      return { [SPEC]: true, status, errorBody: typeof message === 'string' ? message : JSON.stringify(message) };
    },
    hang() { return { [SPEC]: true, hang: true }; },

    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === catUrl) return json({ models: catalog });
      if (!url.startsWith(base)) {
        if (original) return original(input, init);
        throw new Error(`mockGateway: unexpected request to ${url}`);
      }
      const path = url.slice(base.length);
      if (path === '/models') return json({ data: catalog.map((m) => ({ id: m.id })) });
      const headers = lowerHeaders(init.headers);
      const body = init.body ? JSON.parse(init.body) : {};
      if (path === '/embeddings') {
        gw.embeddings.push(body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return json({
          model: body.model,
          data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: hashVector(t, body.dimensions || dims) })),
          usage: { prompt_tokens: inputs.reduce((a, t) => a + estimate(t), 0) },
        });
      }
      if (path !== '/chat/completions') return new Response(`mockGateway: no endpoint ${path}`, { status: 404 });

      const messages = body.messages || [];
      const req = {
        url, headers, body, messages,
        workflow: headers['x-workflow'] || null,
        sessionId: headers['x-session-id'] || null,
        model: body.model,
        responseFormat: body.response_format || null,
        maxTokens: body.max_tokens,
        stream: Boolean(body.stream),
        text: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n'),
      };
      gw.calls.push(req);
      const spec = await resolve(req);
      if (spec.hang) {
        return new Promise((_, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      if (spec.status) return new Response(spec.errorBody || 'error', { status: spec.status });
      const usage = spec.usage || { prompt_tokens: estimate(req.text), completion_tokens: estimate(spec.content) };
      const model = spec.model || body.model;
      if (req.stream) return sse(spec, usage, model);
      return json({
        id: `mock-${gw.calls.length}`,
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: spec.content ?? null, ...(spec.toolCalls ? { tool_calls: spec.toolCalls } : {}) },
          finish_reason: spec.finishReason || 'stop',
        }],
        usage,
      });
    },

    install() {
      if (!original) original = globalThis.fetch;
      globalThis.fetch = gw.fetch;
      return gw;
    },
    restore() {
      if (original) globalThis.fetch = original;
      original = null;
      return gw;
    },
  };

  async function resolve(req) {
    const route = routes.get(req.workflow);
    let handler;
    if (!route) handler = fallbackHandler;
    else if (route.queue) handler = route.queue.length > 1 ? route.queue.shift() : route.queue[0];
    else handler = route.handler;
    if (handler === undefined || handler === null) {
      return gw.error(404, `mockGateway: no route for workflow "${req.workflow}"`);
    }
    let out = typeof handler === 'function' ? await handler(req) : handler;
    if (out && out[SPEC]) return out;
    return gw.reply(out === undefined ? '' : out);
  }

  return gw;
}

function lowerHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !(h instanceof Array) && typeof h.get === 'function') {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function sse(spec, usage, model) {
  const events = [];
  const content = spec.content || '';
  for (let i = 0; i < content.length; i += 16) {
    events.push({ model, choices: [{ index: 0, delta: { content: content.slice(i, i + 16) } }] });
  }
  if (spec.toolCalls) {
    spec.toolCalls.forEach((tc, index) => events.push({ model, choices: [{ index: 0, delta: { tool_calls: [{ index, ...tc }] } }] }));
  }
  events.push({ model, choices: [{ index: 0, delta: {}, finish_reason: spec.finishReason || 'stop' }] });
  events.push({ model, choices: [], usage });
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
