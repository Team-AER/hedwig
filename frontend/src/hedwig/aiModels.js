// Settings → AI Assistant: the model picker's options. The list comes from POST /api/admin/ai/models
// ({ models: [{ id, label, status, available }] }): llm-proxy's chat models with their status, or
// another server's GET /models ids. Pure so node --test can pin it.

/**
 * <option>s for the picker: usable models first, then the ones the server marks offline (shown
 * but not selectable), and the saved model kept selectable at the top when the server no longer
 * offers it, so opening the page never silently changes it.
 */
export function modelOptions(models = [], current = '', { offlineLabel = 'offline', missingLabel = 'not offered by this server' } = {}) {
  const list = Array.isArray(models) ? models.filter((m) => m && typeof m.id === 'string' && m.id) : [];
  // The catalog's display names often carry the id already ("deepseek-v4.1-flash (ollama)").
  const name = (m) => (!m.label || m.label.includes(m.id) ? (m.label || m.id) : `${m.label} — ${m.id}`);
  const options = list.map((m) => ({
    value: m.id,
    label: m.available === false ? `${name(m)} · ${m.status || offlineLabel}` : name(m),
    disabled: m.available === false && m.id !== current,
  }));
  const value = typeof current === 'string' ? current.trim() : '';
  if (value && !list.some((m) => m.id === value)) {
    options.unshift({ value, label: `${value} · ${missingLabel}`, disabled: false });
  }
  return options;
}

/** True when the saved model is one the server lists as usable. */
export function modelIsUsable(models = [], current = '') {
  return Array.isArray(models) && models.some((m) => m && m.id === current && m.available !== false);
}
