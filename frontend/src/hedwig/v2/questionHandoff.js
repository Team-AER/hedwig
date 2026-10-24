// Cosmetic handoff only: the real question and request already exist before this runs.
export function questionHandoff(target, origin, media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: true }) {
  if (!target || !origin || media.matches || typeof target.animate !== 'function') return () => {};
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height || !origin.width || !origin.height) return () => {};
  const clone = target.cloneNode(true);
  const visibility = target.style.visibility;
  let animation;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    target.style.visibility = visibility;
    clone.remove();
    if (media.removeEventListener) media.removeEventListener('change', changed);
    else media.removeListener?.(changed);
  };
  const cancel = () => { animation?.cancel(); cleanup(); };
  const changed = (event) => { if (event.matches) cancel(); };
  try {
    clone.classList.add('hw-question-flight');
    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('tabindex');
    const computed = getComputedStyle(target);
    Object.assign(clone.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
      maxWidth: 'none', margin: 0, boxSizing: 'border-box', zIndex: 1000, pointerEvents: 'none',
      font: computed.font, background: computed.backgroundColor, color: computed.color,
      padding: computed.padding, borderRadius: computed.borderRadius, transformOrigin: 'top left',
    });
    document.body.appendChild(clone);
    animation = clone.animate([
      { transform: `translate(${origin.left - rect.left}px, ${origin.top - rect.top}px) scale(${origin.width / rect.width}, ${origin.height / rect.height})` },
      { transform: 'translate(0, 0) scale(1)' },
    ], { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
    target.style.visibility = 'hidden';
    animation.finished.then(cleanup, cleanup);
    if (media.addEventListener) media.addEventListener('change', changed);
    else media.addListener?.(changed);
  } catch { cancel(); }
  return cancel;
}
