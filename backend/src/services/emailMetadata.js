import { Parser } from 'htmlparser2';

const JSONLD_RE = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function typesOf(node) {
  const t = node?.['@type'] ?? node?.type;
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, ''));
}

/** Every typed object in a JSON-LD value (arrays, @graph, nested). */
function flatten(value, out = [], depth = 0) {
  if (depth > 12 || out.length >= 100) return out;
  if (Array.isArray(value)) { value.forEach((v) => flatten(v, out, depth + 1)); return out; }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value['@graph'])) flatten(value['@graph'], out, depth + 1);
  if (typesOf(value).length) out.push(value);
  return out;
}

/** JSON-LD blocks in an HTML body. Pure. */
export function jsonLdItems(html) {
  const items = [];
  for (const m of String(html || '').slice(0, 262144).matchAll(JSONLD_RE)) {
    const raw = m[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
    let parsed = null;
    for (const candidate of [raw, decodeEntities(raw)]) {
      try { parsed = JSON.parse(candidate); break; } catch { /* try the next form */ }
    }
    if (items.length >= 100) break;
    if (parsed) items.push(...flatten(parsed).map((n) => ({ node: n, via: 'JSON-LD' })));
  }
  return items;
}

const VALUE_ATTRS = { meta: 'content', link: 'href', a: 'href', img: 'src', time: 'datetime', data: 'value', meter: 'value' };

/** Microdata (itemscope / itemtype / itemprop) as nested objects with @type. Pure. */
export function microdataItems(html) {
  const roots = [];
  const stack = []; // { tag, scope?, prop?, text, depth }
  let depth = 0;
  const scopes = []; // open scope objects with their element depth
  const parser = new Parser({
    onopentag(name, attrs) {
      depth++;
      if (depth > 64 || roots.length >= 100) return;
      const isScope = 'itemscope' in attrs;
      const prop = attrs.itemprop;
      let scope = null;
      if (isScope) {
        scope = { '@type': (attrs.itemtype || '').split(/\s+/).filter(Boolean).map((t) => t.replace(/^https?:\/\/schema\.org\//i, '')) };
        if (scope['@type'].length === 1) scope['@type'] = scope['@type'][0];
      }
      const parent = scopes[scopes.length - 1];
      if (prop && parent && !isScope) {
        const attr = VALUE_ATTRS[name];
        if (attr && attrs[attr] != null) addProp(parent.obj, prop, attrs[attr]);
        else if ('content' in attrs) addProp(parent.obj, prop, attrs.content);
        else stack.push({ depth, prop, text: '', target: parent.obj });
      }
      if (scope) {
        if (prop && parent) addProp(parent.obj, prop, scope);
        else roots.push(scope);
        scopes.push({ obj: scope, depth });
      }
    },
    ontext(text) {
      for (const s of stack) if (s.text.length < 4000) s.text += text.slice(0, 4000 - s.text.length);
    },
    onclosetag() {
      if (depth > 64) { depth--; return; }
      const top = stack[stack.length - 1];
      if (top && top.depth === depth) {
        stack.pop();
        addProp(top.target, top.prop, top.text.replace(/\s+/g, ' ').trim());
      }
      if (scopes.length && scopes[scopes.length - 1].depth === depth) scopes.pop();
      depth--;
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.write(String(html || '').slice(0, 262144));
  parser.end();
  return roots.flatMap((r) => flatten(r)).map((n) => ({ node: n, via: 'microdata' }));
}

function addProp(obj, prop, value) {
  for (const p of String(prop).split(/\s+/).filter(Boolean)) {
    if (obj[p] === undefined) obj[p] = value;
    else if (Array.isArray(obj[p])) obj[p].push(value);
    else obj[p] = [obj[p], value];
  }
}


// Bound nested metadata and drop prototype keys before it can reach cards or model input.
function inert(value, depth = 0) {
  if (depth > 12) return null;
  if (typeof value === 'string') return value.slice(0, 4000).toWellFormed().replace(/\0/g, '');
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => inert(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([k]) => !['__proto__', 'prototype', 'constructor'].includes(k))
    .map(([k, v]) => [k.slice(0, 100).toWellFormed(), inert(v, depth + 1)]));
  return value;
}

export function extractEmailMetadata(html) {
  if (!/schema\.org|ld\+json/i.test(String(html || '').slice(0, 262144))) return [];
  return [...jsonLdItems(html), ...microdataItems(html)].slice(0, 100).map((v) => inert(v));
}
