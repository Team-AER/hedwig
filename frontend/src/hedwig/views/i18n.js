// Translation helper for Hedwig views. Keys live under `hedwig.*`; until a locale file carries a
// key, i18next returns the English default passed here, so every string is routed through i18n
// without blocking on translations. `vars` are interpolated as {{name}}.
import i18n from 'i18next';

export function tr(key, english, vars) {
  return i18n.t(`hedwig.${key}`, { defaultValue: english, ...vars });
}
