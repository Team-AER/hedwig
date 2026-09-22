// Document-level key sequences for registry commands. Runs beside MailApp's own handler and
// never fires inside inputs, editors, the compose window or the admin panel; see keymap.js for
// how collisions with upstream shortcuts are resolved (upstream wins).
import { useEffect } from 'react';
import { useStore } from '../../store/index.js';
import { buildKeyMap, buildModKeyMap } from '../../utils/defaultShortcuts.js';
import { listCommands, runCommand } from '../registry.js';
import { parseKeys, chordFromEvent, upstreamConflict, createMatcher } from './keymap.js';
import { useRegistryVersion } from './useRegistry.js';

const SEQUENCE_TIMEOUT_MS = 1000;
const warned = new Set();

function isEditable(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable="true"], [role="textbox"], .ProseMirror'));
}

// Effective bindings: command id → keys, or null when upstream owns that sequence. Exported for
// the palette so it shows only keys that actually work.
export function effectiveBindings(shortcuts) {
  const plain = buildKeyMap(shortcuts || {});
  const mod = buildModKeyMap(shortcuts || {});
  const out = new Map();
  const taken = new Map();
  for (const c of listCommands()) {
    const seq = parseKeys(c.keys);
    if (!seq.length) continue;
    // Two commands on one sequence: the one registered first keeps it.
    const sig = seq.join(' ');
    if (taken.has(sig)) { out.set(c.id, null); continue; }
    const conflict = upstreamConflict(seq, plain, mod);
    if (conflict) {
      if (!warned.has(c.id)) {
        warned.add(c.id);
        console.warn(`[hedwig] "${c.keys}" for ${c.id} is already bound to MailFlow's ${conflict} shortcut; MailFlow's binding wins.`);
      }
      out.set(c.id, null);
    } else {
      taken.set(sig, c.id);
      out.set(c.id, { keys: c.keys, seq });
    }
  }
  return out;
}

export function useKeymap(enabled) {
  const shortcuts = useStore((s) => s.shortcuts);
  const version = useRegistryVersion();

  useEffect(() => {
    if (!enabled) return undefined;
    const bindings = [...effectiveBindings(shortcuts).entries()]
      .filter(([, b]) => b)
      .map(([id, b]) => ({ id, seq: b.seq }));
    const matcher = createMatcher(bindings);
    let timer = null;

    const onKeyDown = (e) => {
      if (e.isComposing || e.repeat) return;
      const st = useStore.getState();
      if (st.composing || st.showAdmin) return;
      if (isEditable(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const chord = chordFromEvent(e);
      if (!chord) return;
      if (chord === 'escape') { matcher.reset(); return; }
      clearTimeout(timer);
      const r = matcher.feed(chord);
      if (r?.run) {
        e.preventDefault();
        runCommand(r.run);
      } else if (r?.pending) {
        timer = setTimeout(() => matcher.reset(), SEQUENCE_TIMEOUT_MS);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, shortcuts, version]);
}
