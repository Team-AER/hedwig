// Embedding providers, chosen by config:
//   openai — any server exposing POST /v1/embeddings (Hugging Face TEI, LiteLLM, vLLM, Ollama)
//   hash   — built-in lexical feature-hashing vectors. No model, no network; weaker but always on.
//   off    — no vectors. Retrieval falls back to full-text search only.
import { createHash } from 'crypto';
import { getConfig } from './config.js';

/**
 * `status` is the endpoint's HTTP status (undefined for connection failures and bad replies);
 * `retryAfterSec` is its Retry-After header, when it sent one. Callers use them to tell one bad
 * input (4xx) from an outage or rate limit (429, 5xx, no connection).
 */
export class EmbeddingError extends Error {
  constructor(message, { status, retryAfterSec } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    if (status !== undefined) this.status = status;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

function retryAfter(res) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : undefined;
}

/** @returns {Promise<{provider: string, model: string, dims: number} | null>} */
export async function embeddingProfile() {
  const cfg = await getConfig();
  const provider = cfg['embeddings.provider'];
  if (provider === 'off' || !cfg.enabled) return null;
  if (provider === 'hash') return { provider, model: `hash-${cfg['embeddings.dims']}`, dims: cfg['embeddings.dims'] };
  return { provider, model: cfg['embeddings.model'], dims: cfg['embeddings.dims'] };
}

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

/** Deterministic hashed bag-of-words (+ bigrams), L2-normalised. Exported for tests. */
export function hashEmbed(text, dims) {
  const v = new Float32Array(dims);
  const tokens = (String(text || '').toLowerCase().match(TOKEN_RE) || []).slice(0, 4000);
  const add = (tok, w) => {
    const h = createHash('md5').update(tok).digest();
    const idx = h.readUInt32LE(0) % dims;
    const sign = (h[4] & 1) ? 1 : -1;
    v[idx] += sign * w;
  };
  for (let i = 0; i < tokens.length; i++) {
    add(tokens[i], 1);
    if (i + 1 < tokens.length) add(`${tokens[i]}_${tokens[i + 1]}`, 0.5);
  }
  return l2(Array.from(v));
}

export function l2(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return vec.map((x) => x / n);
}

export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/** pgvector literal. */
export function toVectorLiteral(vec) {
  return `[${vec.map((x) => (Number.isFinite(x) ? Number(x).toFixed(6) : '0')).join(',')}]`;
}

export function fromVectorLiteral(s) {
  if (Array.isArray(s)) return s.map(Number);
  if (typeof s !== 'string') return null;
  return s.replace(/^\[|\]$/g, '').split(',').filter(Boolean).map(Number);
}

/**
 * Embed a batch of texts. Returns { model, dims, vectors } or null when embeddings are off.
 * @param {string[]} texts
 */
export async function embed(texts, { fetchFn = fetch, kind = 'passage' } = {}) {
  const cfg = await getConfig();
  const profile = await embeddingProfile();
  if (!profile) return null;
  const maxChars = cfg['embeddings.maxChars'];
  const inputs = texts.map((t) => String(t || '').slice(0, maxChars) || ' ');
  if (profile.provider === 'hash') {
    return { model: profile.model, dims: profile.dims, vectors: inputs.map((t) => hashEmbed(t, profile.dims)) };
  }
  const base = cfg['embeddings.baseUrl'].replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg['embeddings.apiKey']) headers.Authorization = `Bearer ${cfg['embeddings.apiKey']}`;
  const batch = cfg['embeddings.batchSize'];
  const vectors = [];
  // bge-style models want a query instruction; passages are embedded as-is.
  const prefix = kind === 'query' && /bge/i.test(profile.model) ? 'Represent this sentence for searching relevant passages: ' : '';
  for (let i = 0; i < inputs.length; i += batch) {
    const slice = inputs.slice(i, i + batch).map((t) => prefix + t);
    let res;
    try {
      res = await fetchFn(`${base}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: profile.model, input: slice }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new EmbeddingError(`embeddings request failed: ${err.message}`);
    }
    if (!res.ok) {
      throw new EmbeddingError(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status, retryAfterSec: retryAfter(res) });
    }
    const body = await res.json();
    const data = (body.data || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== slice.length) throw new EmbeddingError('embeddings response size mismatch');
    for (const d of data) {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length !== profile.dims) {
        throw new EmbeddingError(`embedding has ${Array.isArray(v) ? v.length : 0} dims, config says ${profile.dims}`);
      }
      vectors.push(l2(v));
    }
  }
  return { model: profile.model, dims: profile.dims, vectors };
}

export async function embedQuery(text, opts = {}) {
  const r = await embed([text], { ...opts, kind: 'query' });
  return r ? { model: r.model, dims: r.dims, vector: r.vectors[0] } : null;
}
