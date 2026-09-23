// Hedwig's type comes from one Google Fonts css2 request: Instrument Serif (regular and italic),
// Instrument Sans 400/500/600 and DM Mono 400/500. The CSP in nginx.conf already allows
// fonts.googleapis.com / fonts.gstatic.com. Every stack in tokens.js ends in a system face, so a
// blocked or offline request only changes the look, never the layout's usability.
export const HEDWIG_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap';

const LINK_ID = 'hedwig-fonts';

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
