// The optional 'hedwig' font set (Instrument Serif, Instrument Sans, DM Mono) comes from one Google
// Fonts css2 request. The Hedwig themes default to the 'system' set (fonts.js), which needs no
// download, so the link is injected only while the effective font set is 'hedwig': fonts.js
// applyFontSet writes the set's --font-* properties on <html>, and a MutationObserver on that
// element's style attribute notices when the Instrument pair becomes active. The CSP in nginx.conf
// already allows fonts.googleapis.com / fonts.gstatic.com. Every stack ends in a system face, so a
// blocked or offline request only changes the look, never the layout's usability.
export const HEDWIG_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap';

const LINK_ID = 'hedwig-fonts';

/** True when the font set applied on <html> is the Hedwig (Instrument) set. */
export function hedwigSetActive(root = typeof document === 'undefined' ? null : document.documentElement) {
  if (!root) return false;
  return /Instrument Sans/.test(root.style.getPropertyValue('--font-sans') || '');
}

/** Injects the Google Fonts link (once). Call only when the effective set is 'hedwig'. */
export function ensureHedwigFonts() {
  if (typeof document === 'undefined' || document.getElementById(LINK_ID)) return;
  const pre = document.createElement('link');
  pre.rel = 'preconnect';
  pre.href = 'https://fonts.gstatic.com';
  pre.crossOrigin = 'anonymous';
  document.head.appendChild(pre);
  const link = document.createElement('link');
  link.id = LINK_ID;
  link.rel = 'stylesheet';
  link.href = HEDWIG_FONTS_HREF;
  document.head.appendChild(link);
}

let watching = false;

/** Loads the Hedwig fonts now if their set is active, and whenever it becomes active later. */
export function watchHedwigFonts() {
  if (typeof document === 'undefined') return;
  if (hedwigSetActive()) ensureHedwigFonts();
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  const obs = new MutationObserver(() => {
    if (!hedwigSetActive()) return;
    ensureHedwigFonts();
    obs.disconnect();
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}
