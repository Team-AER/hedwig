// Minimal pub/sub bus for keyboard shortcut actions.
// Keys are action names (strings); handlers are zero-argument functions.
// Components subscribe in a useEffect and unsubscribe on cleanup.

const handlers = {};

export const shortcutBus = {
  on(action, handler) {
    if (!handlers[action]) handlers[action] = new Set();
    handlers[action].add(handler);
  },
  off(action, handler) {
    handlers[action]?.delete(handler);
  },
  // Whether anything is listening for an action right now (the Hedwig reader asks, so a key that
  // upstream acts on is not also acted on by Hedwig).
  has(action) {
    return Boolean(handlers[action]?.size);
  },
  emit(action) {
    handlers[action]?.forEach(h => { try { h(); } catch (e) { console.error('shortcut handler error', e); } });
  },
};
