// What an attachment chip can show without a download: a thumbnail for a picture, the picture in
// a lightbox, a PDF in the browser's own viewer. Pictures are fetched once as blobs (with the
// session cookie) and kept as object URLs in a small LRU, so the chip, the lightbox and the next
// visit to the same message share one fetch. The kind is read from the extension first, because
// the declared MIME type is sender-controlled; SVG is never previewed (it can carry script).

import { classifyAttachmentRisk } from './attachmentRisk.js';

export const THUMB_MAX_BYTES = 8 * 1024 * 1024;
export const THUMB_CACHE_MAX = 40;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif']);
const IMAGE_MIME = /^image\/(jpe?g|pjpeg|png|gif|webp|bmp|x-ms-bmp|heic|heif|avif)$/;

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** A raster picture the browser may draw (HEIC only where the browser can; the chip falls back). */
export function isPreviewableImage(att) {
  if (!att) return false;
  const name = att.filename ?? att.name;
  if (classifyAttachmentRisk(name, att.type).level !== 'ok') return false;
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return true;
  // No extension we know (or none at all): trust a raster image type.
  return !ext || ext === 'bin' || ext === 'dat' ? IMAGE_MIME.test(String(att.type || '').toLowerCase().split(';')[0].trim()) : false;
}

export function isPdfAttachment(att) {
  if (!att) return false;
  const name = att.filename ?? att.name;
  if (classifyAttachmentRisk(name, att.type).level !== 'ok') return false;
  const ext = extOf(name);
  return ext === 'pdf' || (!ext && String(att.type || '').toLowerCase().startsWith('application/pdf'));
}

/**
 * A long file name split for middle truncation: `head` may be cut with an ellipsis, `tail` (the
 * extension plus two characters before it) always shows, so "10101023637468_September.pdf" reads
 * "10101023637468_Sep…er.pdf" in a narrow chip. Short names and names without an extension keep
 * everything in `head`.
 */
export function splitFilename(name, min = 16) {
  const chars = Array.from(String(name || ''));
  const m = /\.[^.\s]{1,8}$/.exec(String(name || ''));
  if (!m || chars.length <= min) return { head: chars.join(''), tail: '' };
  const tailLen = Array.from(m[0]).length + 2;
  return { head: chars.slice(0, -tailLen).join(''), tail: chars.slice(-tailLen).join('') };
}

/** The same as text, for a fixed character budget: "10101023637468_Sep…09.pdf". */
export function middleTruncate(name, max = 25) {
  const chars = Array.from(String(name || ''));
  if (chars.length <= max) return chars.join('');
  const { tail } = splitFilename(name, 0);
  const keep = Array.from(tail).length;
  if (!keep || keep >= max - 2) return `${chars.slice(0, max - 1).join('')}…`;
  return `${chars.slice(0, max - 1 - keep).join('')}…${tail}`;
}

export function attachmentUrl(messageId, part, { inline = false } = {}) {
  return `/api/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}${inline ? '?inline=1' : ''}`;
}

// key → { promise, url }. Map order is recency: a hit is re-inserted at the end.
const cache = new Map();

function evict() {
  while (cache.size > THUMB_CACHE_MAX) {
    const [key, entry] = cache.entries().next().value;
    cache.delete(key);
    // Still in flight: whoever asked gets its URL, which is let go a minute later.
    if (entry.url) URL.revokeObjectURL(entry.url);
    else entry.promise.then((url) => setTimeout(() => URL.revokeObjectURL(url), 60_000), () => {});
  }
}

/** The object URL already made for this attachment, or null. Does not fetch. */
export function peekAttachmentUrl(messageId, part) {
  return cache.get(`${messageId}\u0000${part}`)?.url || null;
}

/** An object URL for the attachment's bytes, fetched once and cached (LRU of THUMB_CACHE_MAX). */
export function getAttachmentObjectUrl(messageId, part) {
  const key = `${messageId}\u0000${part}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }
  const entry = { url: null, promise: null };
  entry.promise = fetch(attachmentUrl(messageId, part, { inline: true }), { credentials: 'include' })
    .then((res) => {
      if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`);
      return res.blob();
    })
    .then((blob) => {
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    })
    .catch((err) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    });
  cache.set(key, entry);
  evict();
  return entry.promise;
}

/** Test hook: drop (and revoke) everything cached. */
export function clearAttachmentCache() {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
}

export function attachmentCacheSize() {
  return cache.size;
}
