// Translation helpers for the v2 views and shell. Unlike the v1 `tr` (which adds the `hedwig.`
// prefix), these take the full key, `hedwig.v2.…`, so the locale test can find every key in the
// source. The English default is repeated here so a string still renders before i18next has
// loaded its resources (and in node tests).
import i18n from 'i18next';

export function tv(key, english, vars) {
  const out = i18n.t(key, { defaultValue: english, ...vars });
  return typeof out === 'string' ? out : interpolate(english, vars);
}

/**
 * A count-dependent string without i18next's plural machinery: `one` is used for exactly 1 and
 * `many` for everything else, so locales whose plural rules have more categories phrase their
 * `many` form so it reads for any number. Each argument is [key, english]; `n` is interpolated.
 */
export function tvn(n, one, many, vars) {
  const [key, english] = n === 1 ? one : many;
  return tv(key, english, { n, ...vars });
}

function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}
