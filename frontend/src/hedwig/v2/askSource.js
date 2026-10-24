import { useStore } from '../../store/index.js';

// Excerpts and geometry are ephemeral, never layout props or persisted settings.
let origin = null;
export function rememberAskSource(threadKey, source, rect) {
  origin = { user: useStore.getState().user?.id, threadKey, source, rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null };
}
export function askSource(threadKey) {
  const user = useStore.getState().user?.id;
  return user != null && origin?.threadKey === threadKey && origin.user === user ? origin : null;
}
export function rememberAskRect(threadKey, rect) {
  const entry = askSource(threadKey);
  if (entry) entry.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
let citationOrigin = null;
export function rememberCitation(message, rect) {
  citationOrigin = { user: useStore.getState().user?.id, messageId: message.id, threadKey: message.thread_key, rect };
}
export function takeCitation(item) {
  const user = useStore.getState().user?.id;
  if (user == null || citationOrigin?.user !== user || !(citationOrigin.messageId === item?.messageId || citationOrigin.threadKey && citationOrigin.threadKey === item?.threadId)) return null;
  const rect = citationOrigin.rect;
  citationOrigin = null;
  return rect;
}
export function sourceMotion(target, rect, { link = false } = {}) {
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (!target || media?.matches || typeof target.animate !== 'function') return () => {};
  let animation, connector;
  let settled = false;
  const stop = () => {
    if (settled) return;
    settled = true;
    media?.removeEventListener('change', changed);
    animation?.cancel();
    connector?.remove();
  };
  const changed = (e) => { if (e.matches) stop(); };
  try {
    const to = target.getBoundingClientRect();
    if (link && rect?.width && rect?.height) {
      connector = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      connector.setAttribute('aria-hidden', 'true');
      connector.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
      connector.classList.add('hw-source-connector');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      path.setAttribute('d', `M${x},${y} C${x + 40},${y} ${to.left - 24},${to.top + to.height / 2} ${to.left + 10},${to.top + to.height / 2}`);
      path.setAttribute('pathLength', '1');
      connector.append(path);
      document.body.append(connector);
      animation = path.animate([{ strokeDashoffset: 1, opacity: 0 }, { strokeDashoffset: 0, opacity: 1, offset: .7 }, { strokeDashoffset: 0, opacity: 0 }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } else {
      const from = rect?.width && rect?.height ? `translate(${rect.left - to.left}px,${rect.top - to.top}px) scale(${Math.min(1.4, rect.width / to.width)},.7)` : 'translateY(-18px) rotate(-1deg)';
      animation = target.animate([{ transform: from, opacity: .3 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    animation.finished.then(stop, stop);
    media?.addEventListener('change', changed);
  } catch { stop(); }
  return stop;
}
