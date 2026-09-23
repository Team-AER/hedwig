// Palette filtering, kept pure for tests. Every word of the query has to appear in the action's
// label or group, ignoring case, accents and punctuation, so "scheme dark" finds "Colour scheme:
// dark". Actions marked `fallback` (Ask Hedwig about the query, search mail for it) always match
// and come after the real matches, so Enter runs the command the user typed rather than a search.
export function paletteWords(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function paletteMatches(text, query) {
  const hay = paletteWords(text).join(' ');
  return paletteWords(query).every((w) => hay.includes(w));
}

export function filterPalette(actions, query) {
  if (!String(query || '').trim()) return actions;
  const hits = actions.filter((a) => !a.fallback && paletteMatches(`${a.label} ${a.group || ''}`, query));
  return [...hits, ...actions.filter((a) => a.fallback)];
}
