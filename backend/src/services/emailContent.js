// One bounded, side-effect-free view of mail for intelligence. Display HTML stays separate.
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

export const CONTENT_VERSION = '2026-10-24.1';
export const MAX_HTML_CHARS = 2_000_000;
export const MAX_TEXT_CHARS = 240_000;
const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'pre', 'dl', 'dt', 'dd', 'figure', 'figcaption']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'iframe', 'object']);
const clean = (s) => String(s || '').toWellFormed().replace(/\0/g, '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const words = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);

export function looksLikeHtml(text) {
  const t = String(text || '').slice(0, 2048);
  return /^\s*<(?:!doctype|html|head|body)[\s>]/i.test(t)
    || /<(?:div|table|p|span|a|style|meta|center|font)\b[^>]*>/i.test(t) && /<\/[a-z]+>/i.test(t);
}

export function isPlaceholder(text) {
  const t = clean(text).replace(/\s+/g, ' ');
  if (!t) return true;
  if (t.length > 600) return false;
  return /^(?:this is (?:an? )?html (?:e-?mail|message)\b|.{0,100}(?:client|browser|software).{0,80}(?:does not|doesn't|cannot|can't|not able to) (?:display|read|support|render).{0,30}(?:html|mime)|to (?:view|read) this (?:e-?mail|message).{0,100}(?:html|browser))/i.test(t)
    || /^(?:view|read|open|click here to view) (?:this |the )?(?:e-?mail|message|newsletter)?\s*(?:in (?:a |your )?browser|online)[.!:]?\s*(?:https?:\/\/\S+)?[.!]?$/i.test(t);
}

export function hiddenElement(attrs = {}) {
  return 'hidden' in attrs || attrs['aria-hidden'] === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|mso-hide\s*:\s*all|opacity\s*:\s*0(?:[;\s!]|$))/i.test(attrs.style || '');
}

export function safeContentUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(u.protocol) ? u.href.slice(0, 2048) : null;
  } catch { return null; }
}

/** Streaming extraction: no execution, resource loads, stylesheet evaluation, or network access. */
export function extractHtmlContent(input, { maxChars = MAX_TEXT_CHARS, linksInText = true, includeAltText = true } = {}) {
  const html = String(input || '');
  const cap = Math.max(1, Math.min(MAX_TEXT_CHARS, maxChars));
  let out = ''; let hiddenText = ''; let hidden = 0; let pre = 0; let stopped = false;
  const stack = []; const links = []; const tables = []; const tableStack = []; const seen = new Set();
  const warnings = [];
  const add = (s) => { if (out.length < cap) out += s.slice(0, cap - out.length); else stopped = true; };
  const newline = () => { if (out && !out.endsWith('\n')) add('\n'); };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (stopped) return;
      if (stack.length >= 256) { stopped = true; warnings.push('nesting_limit'); return; }
      const invisible = hiddenElement(attrs);
      const entry = { name, skip: SKIP.has(name) || invisible };
      stack.push(entry);
      if (entry.skip) hidden++;
      if (hidden) return;
      if (BLOCK.has(name)) newline();
      if (name === 'li') add('- ');
      if (name === 'pre') pre++;
      if (name === 'a' && links.length < 200) entry.link = { url: safeContentUrl(attrs.href), at: out.length };
      if (name === 'table' && tables.length < 100) { const table = { rows: [], at: out.length }; tables.push(table); tableStack.push(table); entry.table = table; }
      if (name === 'tr' && tableStack.length && tableStack[tableStack.length - 1].rows.length < 1000) { entry.row = []; tableStack[tableStack.length - 1].rows.push(entry.row); }
      if (name === 'td' || name === 'th') { if (out && !out.endsWith('\n')) add(' | '); entry.cell = out.length; }
      if (includeAltText && name === 'img' && attrs.alt && attrs.alt.trim() && !['1', '0'].includes(attrs.width) && !['1', '0'].includes(attrs.height)) {
        add(` [Image description: ${attrs.alt.replace(/\s+/g, ' ').slice(0, 500).toWellFormed()}] `);
      }
    },
    ontext(text) {
      if (stopped) return;
      if (hidden) {
        if (!stack.some((e) => SKIP.has(e.name)) && hiddenText.length < 1000) hiddenText += text.slice(0, 1000 - hiddenText.length);
        return;
      }
      add(pre ? text : text.replace(/\s+/g, ' '));
    },
    onclosetag() {
      if (stopped) return;
      const e = stack.pop(); if (!e) return;
      if (e.skip) { hidden--; return; }
      if (hidden) return;
      if (e.link?.url) {
        const label = out.slice(e.link.at).replace(/\s+/g, ' ').trim().slice(0, 200).toWellFormed().replace(/\0/g, '');
        if (!seen.has(e.link.url)) {
          seen.add(e.link.url); links.push({ url: e.link.url, text: label });
          if (linksInText && label !== e.link.url) add(` (${e.link.url})`);
        }
      }
      if (e.cell != null) {
        const row = [...stack].reverse().find((p) => p.row)?.row;
        if (row && row.length < 100) row.push(clean(out.slice(e.cell)).slice(0, 4000).toWellFormed());
      }
      if (e.table) tableStack.pop();
      if (e.name === 'pre') pre--;
      if (BLOCK.has(e.name)) newline();
    },
  }, { decodeEntities: true });
  try {
    const bounded = html.slice(0, MAX_HTML_CHARS);
    for (let i = 0; i < bounded.length && !stopped; i += 8192) parser.write(bounded.slice(i, i + 8192));
    parser.end();
  } catch { warnings.push('malformed_html'); }
  const truncated = stopped || html.length > MAX_HTML_CHARS;
  if (truncated) warnings.push('truncated');
  return { text: clean(out), links, tables, preheader: clean(hiddenText), truncated, warnings };
}

/** Select substantive evidence before any feature-specific token/character budget is applied. */
export function emailContent(row = {}, options = {}) {
  let plain = clean(String(row.body_text ?? row.text ?? '').slice(0, MAX_HTML_CHARS));
  let html = String(row.body_html ?? row.html ?? '');
  if (looksLikeHtml(plain)) { if (!html.trim()) html = plain; plain = ''; }
  const parsed = extractHtmlContent(html, options);
  const usable = parsed.text && !isPlaceholder(parsed.text);
  let source = 'plain'; let reason = 'substantive_plain'; let text = plain;
  if ((!plain || isPlaceholder(plain)) && usable) {
    text = parsed.text; source = 'html'; reason = plain ? 'plain_placeholder' : 'plain_empty';
  } else if (usable && plain) {
    const p = words(plain); const extra = [...words(parsed.text)].filter((w) => !p.has(w));
    const missingNumber = extra.some((w) => /\d/.test(w));
    if ((extra.length >= 5 && parsed.text.length > plain.length * 1.4)
      || (missingNumber && parsed.text.length > plain.length * 1.1)
      || (parsed.tables.length && extra.length >= 2 && parsed.text.length > plain.length * 1.2)) {
      text = parsed.text; source = 'html'; reason = 'html_richer';
      const h = words(parsed.text); const uniquePlain = [...p].filter((w) => !h.has(w));
      if (uniquePlain.length >= 8 && !isPlaceholder(plain)) text += `\n\n[Additional plain-text alternative]\n${plain}`;
    }
  } else if (!plain && !usable) { text = row.snippet || ''; source = text ? 'snippet' : 'none'; reason = 'no_readable_body'; }
  const truncated = parsed.truncated || text.length > MAX_TEXT_CHARS;
  text = clean(text.slice(0, MAX_TEXT_CHARS));
  const state = !text ? (html ? 'image_only' : 'empty') : isPlaceholder(text) ? 'placeholder' : source === 'snippet' ? 'partial' : 'readable';
  const hash = createHash('sha256').update(`${CONTENT_VERSION}\0${text}\0${JSON.stringify(row.content_metadata || [])}`).digest('hex');
  return { ...parsed, text, source, reason, state, hash, version: CONTENT_VERSION, truncated };
}
