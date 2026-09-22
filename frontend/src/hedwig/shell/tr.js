// Translation helper for shell chrome. Keys live under `hedwig.shell.*`; until a locale file
// carries one, i18next returns the English default given here, so the strings are routed
// through i18n without waiting on translations. `vars` interpolate as {{name}}.
import i18n from 'i18next';

export function tr(key, english, vars) {
  return i18n.t(`hedwig.shell.${key}`, { defaultValue: english, ...vars });
}
