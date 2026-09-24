// Smart dark mode for email bodies (the Apple Mail / Gmail approach).
//
// Under a dark app theme a mail is decided once its frame has parsed, in this order:
//   native    the mail says it supports dark (a color-scheme / supported-color-schemes meta that
//             names dark, a color-scheme declaration or a prefers-color-scheme: dark block in its
//             <style>): the frame's document is switched to color-scheme: dark and the sender's
//             own dark styles do the work. No filter.
//   already   the mail's effective background is already dark (relative luminance < 0.35): left
//             exactly as sent.
//   inverted  everything else: the content wrapper is inverted and hue-rotated (so hues, blue
//             links included, survive), and photos, logos and background images are inverted
//             back so they keep their colours. White paper lands on the dark card colour and
//             black text on an off-white, never pure white.
//
// Everything here except decideMailDark (which reads computed styles from a live frame) is pure,
// so node --test can cover it without a layout engine.

/** The frame's page colour in dark mode: the dark theme's --hw-content, so the card is seamless. */
export const MAIL_DARK_PAPER = '#1E1E20';
/** Below this relative luminance a mail's own background counts as dark already. */
export const DARK_LUMINANCE = 0.35;
/** Values of the ui.mailDark setting; the first is the default. */
export const MAIL_DARK_SETTINGS = ['smart', 'off'];

// The wrapper filter. invert(0.86) followed by contrast(1.05) maps white to ~#1F1F1F (the card)
// and black to ~#E0E0E0 (off-white); the contrast step lifts low-contrast grey text a little.
// hue-rotate(180deg) turns the inverted hues back, so a blue link stays blue.
export const MAIL_DARK_FILTER = 'invert(0.86) hue-rotate(180deg) contrast(1.05)';
// What media carries so the wrapper filter lands it back on its own colours: a full inversion
// and the same half-turn of hue. The wrapper's filter then maps it linearly into 12%..88%, the
// slight dimming a photo gets in any dark mail view.
export const MAIL_DARK_COUNTER = 'invert(1) hue-rotate(180deg)';
// What keeps its colours inside an inverted mail. .hw-keep is added by decideMailDark to anything
// whose background image comes from a stylesheet rather than an inline style or attribute.
export const MAIL_DARK_KEEP = 'img, picture, video, svg, canvas, [style*="background-image" i], [style*="url(" i], [background], .hw-keep';

// ── Colours ─────────────────────────────────────────────────────────────────────

const NAMED = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
};

/** { r, g, b, a } (0-255, alpha 0-1) from #rgb(a), #rrggbb(aa), rgb()/rgba() in either syntax, or a few names. */
export function parseColour(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) { const [r, g, b, a] = NAMED[s]; return { r, g, b, a }; }
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = 'f'] = hex.split('').map((c) => c);
      return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a };
    }
    return null;
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  let a = 1;
  if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
}

/**
 * WCAG relative luminance (0 black .. 1 white) of a colour string, or null when it cannot be
 * read or is fully transparent (a transparent layer has no luminance of its own).
 */
export function luminance(colour) {
  const c = parseColour(colour);
  if (!c || c.a === 0) return null;
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * The background a reader sees: the innermost mostly-opaque colour of a chain listed outermost
 * first (body, the scale wrapper, then each element that covers most of the wrapper). null when
 * every layer is transparent, which on a mail means the default white page.
 */
export function effectiveBackground(chain) {
  let out = null;
  for (const colour of Array.isArray(chain) ? chain : []) {
    const c = parseColour(colour);
    if (c && c.a >= 0.5) out = colour;
  }
  return out;
}

// ── The decision ────────────────────────────────────────────────────────────────

function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag.replace(/^<meta/i, ' '));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Whether the mail declares its own dark styles: a <meta name="color-scheme"> or
 * <meta name="supported-color-schemes"> whose content names dark, or a <style> that sets a
 * color-scheme naming dark or has a @media (prefers-color-scheme: dark) block.
 */
export function detectsNativeDark(html) {
  if (typeof html !== 'string' || !html) return false;
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name');
    const content = attr(tag, 'content');
    if (!name || !content) continue;
    if (/^\s*(color-scheme|supported-color-schemes)\s*$/i.test(name) && /(^|[\s,])dark([\s,]|$)/i.test(content.trim())) return true;
  }
  for (const block of html.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) || []) {
    const css = block.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(css)) return true;
    if (/(^|[\s;{])(supported-)?color-scheme\s*:\s*[^;}]*\bdark\b/i.test(css.replace(/prefers-color-scheme/gi, ''))) return true;
  }
  return false;
}

/**
 * 'native' | 'already' | 'inverted' for a mail. `background` is the effective background colour
 * (or its luminance as a number); null means nothing opaque, i.e. the default white page.
 */
export function pickMode({ native = false, background = null } = {}) {
  if (native) return 'native';
  const l = typeof background === 'number' ? background : luminance(background);
  if (l !== null && Number.isFinite(l) && l < DARK_LUMINANCE) return 'already';
  return 'inverted';
}

/** Whether a message gets the dark treatment at all: dark theme, the setting on, the sender not opted out. */
export function mailDarkWanted({ dark = false, setting = 'smart', senderPref = null } = {}) {
  return Boolean(dark) && setting !== 'off' && senderPref !== 'light';
}

/** The setting's value, defaulting anything unknown to 'smart'. */
export function normaliseMailDark(value) {
  return MAIL_DARK_SETTINGS.includes(value) ? value : MAIL_DARK_SETTINGS[0];
}

// ── The frame document ─────────────────────────────────────────────────────────

// The dark defaults for a mail that styles itself for dark. In <head>, before the mail, and at
// zero specificity, so any colour the sender sets wins.
const NATIVE_BASE = `:root { color-scheme: dark; background-color: ${MAIL_DARK_PAPER}; }
        :where(body) { color: #E4E4E6; }
        :where(a) { color: #8AB4F8; }
        :where(blockquote) { border-left: 3px solid #48484C; margin: 0; padding-left: 12px; color: #A1A1A6; }`;

const KEEP_SELECTOR = (scope) => MAIL_DARK_KEEP.split(/,\s*/).map((s) => `${scope} ${s}`).join(',\n        ');
const NESTED_KEEP = `:is(${MAIL_DARK_KEEP}) :is(${MAIL_DARK_KEEP})`;
// A remote image the server blocked is a flat #e8e8e8 SVG slot (blockRemoteImages in
// backend/src/services/emailSanitizer.js), not a picture: it darkens with the mail instead of
// glaring as a light box.
const BLOCKED_IMAGE = 'img[src^="data:image/svg+xml,"][src*="fill%3D%22%23e8e8e8%22"]';

// The decision's CSS hooks, keyed on the root's data-hw-dark, which the frame starts at
// "pending" (inverted, the common case, so a light mail never flashes white) or "native", and
// decideMailDark settles. "measure" is a transient state with no rules, so the mail's own
// backgrounds can be read.
const DARK_HOOKS = `html[data-hw-dark] { background-color: ${MAIL_DARK_PAPER} !important; }
        html[data-hw-dark="pending"] body, html[data-hw-dark="inverted"] body { background-color: transparent !important; background-image: none !important; }
        html[data-hw-dark="pending"] #mf-scale-wrapper, html[data-hw-dark="inverted"] #mf-scale-wrapper { filter: ${MAIL_DARK_FILTER}; }
        ${KEEP_SELECTOR('html[data-hw-dark="pending"] #mf-scale-wrapper')},
        ${KEEP_SELECTOR('html[data-hw-dark="inverted"] #mf-scale-wrapper')} { filter: ${MAIL_DARK_COUNTER}; }
        html[data-hw-dark="pending"] #mf-scale-wrapper ${NESTED_KEEP},
        html[data-hw-dark="inverted"] #mf-scale-wrapper ${NESTED_KEEP},
        html[data-hw-dark="pending"] #mf-scale-wrapper ${BLOCKED_IMAGE},
        html[data-hw-dark="inverted"] #mf-scale-wrapper ${BLOCKED_IMAGE} { filter: none; }`;

/**
 * The frame's srcdoc. Light (dark false) is the reader's document as it has always been: a
 * white page, dark text, `color-scheme: only light`. Dark carries the decision hooks above; a
 * native-dark mail also gets the dark defaults in <head> and no forced light colours.
 */
export function frameSrcDoc(html, { dark = false, native = false } = {}) {
  const content = String(html ?? '').replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1');
  const nativeDark = dark && native;
  const rootAttr = dark ? ` data-hw-dark="${nativeDark ? 'native' : 'pending'}"` : '';
  const scheme = nativeDark ? 'dark' : 'only light';
  const headStyle = nativeDark ? `\n      <style id="hw-dark-base">${NATIVE_BASE}</style>` : '';
  // Light: the white page and dark text, forced. Dark but not native: the same colours (they are
  // what gets inverted), without the white page. Native: the sender's colours over the head defaults.
  const bodyColours = !dark
    ? `background-color: #ffffff !important; color-scheme: light;
               font-family: -apple-system, Arial, sans-serif;
               font-size: 14px; line-height: 1.6; color: #1a1a1a;`
    : nativeDark
      ? `font-family: -apple-system, Arial, sans-serif;
               font-size: 14px; line-height: 1.6;`
      : `font-family: -apple-system, Arial, sans-serif;
               font-size: 14px; line-height: 1.6; color: #1a1a1a;`;
  const linkAndQuote = nativeDark
    ? ''
    : `
        a { color: #6366f1; }`;
  const quote = nativeDark
    ? ''
    : `
        blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }`;
  const hooks = dark ? `
        ${DARK_HOOKS}` : '';
  return `<!DOCTYPE html><html${rootAttr}><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="color-scheme" content="${scheme}">
      <meta name="referrer" content="no-referrer">
      <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
      <base target="_blank">${headStyle}
    </head><body><div id="mf-scale-wrapper">${content}</div><style>
        /* Injected AFTER email HTML so our rules win the source-order tiebreak
           for same-specificity !important declarations inside the email's own
           <style> blocks (which land in <body> after the email HTML). */
        html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
        body { margin: 0 !important; padding: 0 !important;
               ${bodyColours}
               word-wrap: break-word; overflow-wrap: break-word; }
        img { max-width: 100% !important; height: auto !important; }
        /* Force top-level wrapper tables to fill the viewport. Selectors cover
           both the legacy body > table pattern and the mf-scale-wrapper layer. */
        body > table, body > center > table,
        body > div > table, body > center > div > table,
        #mf-scale-wrapper > table, #mf-scale-wrapper > center > table,
        #mf-scale-wrapper > div > table, #mf-scale-wrapper > center > div > table {
          width: 100% !important;
        }
        /* Reset min-width on cells only — not on table elements, because fluid
           grid systems (e.g. Oracle Eloqua "tolkien") set min-width on inline-table
           column elements as a layout fallback when their calc() width resolves to 0. */
        td, th { min-width: 0 !important; }
        td { word-break: break-word; }
        th { overflow-wrap: normal; word-break: normal; }${linkAndQuote}
        pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }${quote}${hooks}
      </style></body></html>`;
}

// ── Reading a live frame ────────────────────────────────────────────────────────

const NOT_CONTENT = new Set(['STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE', 'BASE', 'HEAD']);
// An element this share of the wrapper's area (or more) is the mail's page; walk into it.
const COVERS = 0.8;
const MAX_DEPTH = 16;

function backgroundChain(doc, wrapper, win) {
  const bg = (el) => win.getComputedStyle(el).backgroundColor;
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  };
  const chain = [];
  if (doc.body) chain.push(bg(doc.body));
  chain.push(bg(wrapper));
  const full = area(wrapper);
  if (!(full > 0)) return chain;
  let node = wrapper;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let best = null;
    let bestArea = 0;
    for (const child of node.children) {
      if (NOT_CONTENT.has(child.tagName)) continue;
      const a = area(child);
      if (a > bestArea) { best = child; bestArea = a; }
    }
    if (!best || bestArea < COVERS * full) break;
    chain.push(bg(best));
    node = best;
  }
  return chain;
}

// Background images set from the mail's stylesheet cannot be matched by an attribute selector,
// so they are found by computed style and marked to keep their colours.
function markStyledBackgroundImages(wrapper, win) {
  for (const el of wrapper.querySelectorAll('*')) {
    if (el.classList.contains('hw-keep')) continue;
    const img = win.getComputedStyle(el).backgroundImage;
    if (img && img.includes('url(')) el.classList.add('hw-keep');
  }
}

/**
 * Decide and apply the mode on a frame's document; returns it, or null when the document is
 * not one of ours. Idempotent, so it can run again after the frame settles.
 */
export function decideMailDark(doc, { native = false } = {}) {
  const root = doc?.documentElement;
  const win = doc?.defaultView;
  const wrapper = doc?.getElementById?.('mf-scale-wrapper');
  if (!root || !win || !wrapper) return null;
  if (native) {
    root.setAttribute('data-hw-dark', 'native');
    root.style.setProperty('color-scheme', 'dark');
    return 'native';
  }
  const body = doc.body;
  // A body whose inline background is !important beats the stylesheet; an earlier run overrode
  // it inline, so put the sender's value back before reading it.
  if (body && body.dataset.hwBg !== undefined) {
    if (body.dataset.hwBg) body.style.setProperty('background-color', body.dataset.hwBg, body.dataset.hwBgPrio || '');
    else body.style.removeProperty('background-color');
    delete body.dataset.hwBg;
    delete body.dataset.hwBgPrio;
  }
  root.setAttribute('data-hw-dark', 'measure');
  let background = null;
  try {
    background = effectiveBackground(backgroundChain(doc, wrapper, win));
  } catch { /* unreadable: treat as the default white page */ }
  const mode = pickMode({ native: false, background });
  root.setAttribute('data-hw-dark', mode);
  if (mode === 'inverted') {
    if (body) {
      const left = parseColour(win.getComputedStyle(body).backgroundColor);
      if (left && left.a > 0) {
        body.dataset.hwBg = body.style.getPropertyValue('background-color');
        body.dataset.hwBgPrio = body.style.getPropertyPriority('background-color');
        body.style.setProperty('background-color', 'transparent', 'important');
      }
    }
    markStyledBackgroundImages(wrapper, win);
  }
  return mode;
}

// ── Per-sender choice ──────────────────────────────────────────────────────────

export const SENDER_PREFS_KEY = 'hedwig_mail_dark';
// Oldest choices are dropped past this many senders.
const MAX_SENDERS = 500;
const listeners = new Set();

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function senderKey(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** Every remembered choice: { [address]: 'light' }. Unreadable storage reads as none. */
export function readSenderPrefs(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(SENDER_PREFS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 'light' when the user asked to see this sender's mail in its original colours, else null. */
export function senderMailDark(email, storage = defaultStorage()) {
  const key = senderKey(email);
  if (!key) return null;
  return readSenderPrefs(storage)[key] === 'light' ? 'light' : null;
}

/**
 * Remember a choice for a sender: 'light' (original colours) is stored, anything else clears
 * it back to the default (darkened). Never throws.
 */
export function setSenderMailDark(email, choice, storage = defaultStorage()) {
  const key = senderKey(email);
  if (!key) return;
  const prefs = readSenderPrefs(storage);
  delete prefs[key];
  if (choice === 'light') prefs[key] = 'light';
  const keys = Object.keys(prefs);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SENDERS))) delete prefs[k];
  try {
    if (Object.keys(prefs).length) storage?.setItem(SENDER_PREFS_KEY, JSON.stringify(prefs));
    else storage?.removeItem(SENDER_PREFS_KEY);
  } catch { /* storage unavailable: the choice lasts for this view only */ }
  for (const fn of listeners) {
    try { fn(key); } catch { /* a listener's problem */ }
  }
}

/** Be told when a sender's choice changes (so every open message from them follows). */
export function subscribeSenderMailDark(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
