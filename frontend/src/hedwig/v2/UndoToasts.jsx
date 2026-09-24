// The undo toasts (actions.js): fixed bottom-center, the thin "bar" glass, 13px, radius 8, at
// most three, newest on top. Each says what happened, with Undo (Z), or what failed, with Try
// again. Hover or focus holds the timer. Z or ⌘Z undoes the newest action from anywhere that is
// not a text field. Mounted once for the Hedwig session in its own root (mountUndoToasts), so
// the desktop panes and the phone stack share it.
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../../store/index.js';
import { Icon } from '../icons.jsx';
import { useUndo, undo, undoLast, retry, dismiss, holdToast, releaseToast } from './actions.js';
import { Sheet, V } from './primitives.jsx';
import { tv } from './i18n.js';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

function typingIn(el) {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || Boolean(el.closest?.('[contenteditable="true"]'));
}

/** Whether a keydown is the undo key: Z alone, or ⌘Z / Ctrl+Z (never with Shift: that is redo). */
export function isUndoKey(e) {
  if (!e || e.isComposing || e.repeat || e.altKey || e.shiftKey) return false;
  if (String(e.key || '').toLowerCase() !== 'z') return false;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  return mod ? !(IS_MAC ? e.ctrlKey : e.metaKey) : !e.metaKey && !e.ctrlKey;
}

function useUndoKey() {
  useEffect(() => {
    const onKey = (e) => {
      if (!isUndoKey(e) || typingIn(e.target) || typingIn(document.activeElement)) return;
      if (useStore.getState().composing) return;
      if (undoLast()) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
}

function ToastButton({ onClick, children, label, title, phone, accent = false, keys }) {
  return (
    <button
      type="button"
      className="hw-btn"
      onClick={onClick}
      aria-label={label}
      title={title || label}
      aria-keyshortcuts={keys}
      style={{
        minWidth: phone ? 44 : 28, height: phone ? 44 : 28, padding: children ? '0 8px' : 0, border: 0, borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        background: 'transparent', color: accent ? V.accentInk : V.muted, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {children || <Icon name="x" size={14} />}
    </button>
  );
}

function Toast({ toast, phone }) {
  const error = toast.tone === 'error';
  const undoLabel = tv('hedwig.v2.act.undo', 'Undo');
  return (
    <Sheet
      material="bar"
      radius={8}
      data-undo-toast={toast.id}
      data-tone={toast.tone}
      onMouseEnter={() => holdToast(toast.id)}
      onMouseLeave={() => releaseToast(toast.id)}
      onFocus={() => holdToast(toast.id)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) releaseToast(toast.id); }}
      style={{
        pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%', boxSizing: 'border-box',
        minHeight: phone ? 48 : 36, padding: phone ? '0 4px 0 14px' : '0 4px 0 12px',
        border: `1px solid ${V.line}`, boxShadow: '0 8px 24px -8px rgba(0,0,0,0.28)',
        color: error ? V.red : V.ink, fontFamily: V.sans, fontSize: 13, lineHeight: '18px',
      }}
    >
      {error && <span aria-hidden="true" style={{ display: 'inline-flex' }}><Icon name="circle-alert" size={14} /></span>}
      <span title={toast.detail || undefined} style={{ minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
        {toast.title}
      </span>
      {toast.canUndo && (
        <ToastButton accent phone={phone} onClick={() => undo(toast.id)} label={undoLabel} title={`${undoLabel} (Z)`} keys={IS_MAC ? 'Z Meta+Z' : 'Z Control+Z'}>
          {undoLabel}
        </ToastButton>
      )}
      {toast.retry && (
        <ToastButton accent phone={phone} onClick={() => retry(toast.id)} label={tv('hedwig.v2.action.retry', 'Try again')}>
          {tv('hedwig.v2.action.retry', 'Try again')}
        </ToastButton>
      )}
      <ToastButton phone={phone} onClick={() => dismiss(toast.id)} label={tv('hedwig.v2.act.dismiss', 'Dismiss')} />
    </Sheet>
  );
}

export default function UndoToasts() {
  const toasts = useUndo((s) => s.toasts);
  useUndoKey();
  const phone = typeof window !== 'undefined' && window.innerWidth < 768;
  return (
    <div
      role="region"
      aria-label={tv('hedwig.v2.act.region', 'Actions you can undo')}
      aria-live="polite"
      data-undo-toasts=""
      className="hw-v2"
      style={{
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', zIndex: 3100,
        bottom: phone ? 'calc(env(safe-area-inset-bottom, 0px) + 72px)' : 24,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        width: 'max-content', maxWidth: 'calc(100vw - 32px)', pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => <Toast key={t.id} toast={t} phone={phone} />)}
    </div>
  );
}

let host = null;
let root = null;

/** Mount the toasts for the Hedwig session (once; startV2Session). */
export function mountUndoToasts() {
  if (root || typeof document === 'undefined') return;
  host = document.createElement('div');
  host.setAttribute('data-undo-host', '');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<UndoToasts />);
}

export function unmountUndoToasts() {
  if (!root) return;
  const r = root;
  const h = host;
  root = null;
  host = null;
  r.unmount();
  h?.remove();
}
