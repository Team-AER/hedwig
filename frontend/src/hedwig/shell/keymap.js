// Key sequences for registry commands ('g a', 'mod+\\'), kept pure for testing. The DOM side
// lives in useKeymap.js.
//
// Hedwig bindings sit beside upstream's shortcut system (utils/defaultShortcuts.js), never over
// it: a Hedwig sequence that upstream would already act on — the same two-key sequence, a first
// key upstream binds on its own, or the same modifier combo — is reported as a conflict and not
// bound, so upstream shortcuts and the user's overrides keep working exactly as before.

// Normalise one chord: 'mod+\\', 'shift+f6', 'g'. 'mod' means Cmd on macOS and Ctrl elsewhere.
export function normaliseChord(chord) {
  const parts = String(chord).split('+');
  const key = parts.pop() || '+';
  const mods = new Set(parts.map((p) => p.toLowerCase()).map((p) => (p === 'cmd' || p === 'meta' || p === 'ctrl' ? 'mod' : p)));
  const order = ['mod', 'alt', 'shift'].filter((m) => mods.has(m));
  return [...order, keyName(key, order.length > 0)].join('+');
}

// Single characters keep their case ('J' is not 'j', as upstream treats them) unless a modifier
// is held; named keys ('F6', 'Escape') are compared case-insensitively.
function keyName(key, withModifier) {
  if (key.length === 1) return withModifier ? key.toLowerCase() : key;
  return key.toLowerCase();
}

export function parseKeys(keys) {
  if (!keys || typeof keys !== 'string') return [];
  return keys.trim().split(/\s+/).filter(Boolean).map(normaliseChord);
}

// The chord for a keydown event, or null for a bare modifier press. Shift is only recorded for
// non-printing keys: '?' already implies it.
export function chordFromEvent(e) {
  const key = e.key;
  if (!key || ['Control', 'Meta', 'Alt', 'Shift', 'CapsLock'].includes(key)) return null;
  const mods = [];
  if (e.metaKey || e.ctrlKey) mods.push('mod');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey && key.length > 1) mods.push('shift');
  return [...mods, keyName(key, mods.length > 0)].join('+');
}

// Human label: 'g a' → 'G then A'-style pieces for <kbd>, '⌘\\' for modifier combos.
export function formatKeys(keys, isMac = true) {
  return parseKeys(keys).map((chord) => chord.split('+').map((p) => {
    if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (p === 'alt') return isMac ? '⌥' : 'Alt';
    if (p === 'shift') return isMac ? '⇧' : 'Shift';
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }).join(isMac ? '' : '+'));
}

// Does a Hedwig sequence collide with upstream's effective shortcuts?
//   plainMap: upstream key → action for plain keys ('gi', 'j', '#', 'Delete')
//   modMap:   upstream bare key → action for ctrl/cmd combos
// Returns the upstream action name it collides with, or null.
export function upstreamConflict(seq, plainMap = {}, modMap = {}) {
  if (!seq.length) return null;
  const first = seq[0];
  if (first.startsWith('mod+')) {
    const rest = first.slice(4);
    return !rest.includes('+') && modMap[rest.toLowerCase()] ? modMap[rest.toLowerCase()] : null;
  }
  if (first.includes('+')) return null;
  const upstreamKey = (k) => (k.length === 1 ? k : k.toLowerCase());
  const byKey = new Map(Object.entries(plainMap).map(([k, action]) => [upstreamKey(k), action]));
  // Upstream stores two-key sequences concatenated ('gi') and special keys by name ('Delete').
  if (seq.every((c) => !c.includes('+'))) {
    const joined = seq.join('');
    if (byKey.has(joined)) return byKey.get(joined);
  }
  // Upstream acts on a first key it binds by itself before our second key arrives.
  if (seq.length > 1 && byKey.has(first)) return byKey.get(first);
  return null;
}

// Build a matcher over [{ id, seq }]. feed(chord) returns { run: id } on a complete match,
// { pending: true } while a prefix is in progress, or null when nothing matches.
export function createMatcher(bindings) {
  let buffer = [];
  const list = bindings.filter((b) => b.seq.length);
  return {
    reset() { buffer = []; },
    pending() { return buffer.length > 0; },
    feed(chord) {
      const attempt = [...buffer, chord];
      const exact = list.find((b) => b.seq.length === attempt.length && b.seq.every((c, i) => c === attempt[i]));
      if (exact) { buffer = []; return { run: exact.id }; }
      const prefix = list.some((b) => b.seq.length > attempt.length && attempt.every((c, i) => b.seq[i] === c));
      if (prefix) { buffer = attempt; return { pending: true }; }
      // A dead sequence may still be the start of a new one.
      buffer = [];
      if (attempt.length > 1) return this.feed(chord);
      return null;
    },
  };
}
