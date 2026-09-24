import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getAttachmentObjectUrl, peekAttachmentUrl } from '../utils/attachmentPreview.js';

// A message's pictures, one at a time, over a scrim: the picture at up to 90vw × 90vh on the
// content material, its name and size under it, previous / next between the message's pictures
// (buttons and ← →), a download button, and close on Esc, the × or a click outside. Focus stays
// inside while it is open and goes back to the chip that opened it. Colours come from the Hedwig
// tokens with the classic palette as the fallback, so it reads in both shells and both themes.

const C = {
  scrim: 'rgba(0,0,0,0.62)',
  content: 'var(--hw-content, var(--bg-elevated, var(--bg-secondary, #FFFFFF)))',
  ink: 'var(--hw-ink, var(--text-primary, #1D1D1F))',
  muted: 'var(--hw-muted, var(--text-secondary, #5E5E63))',
  line: 'var(--hw-line, var(--border, rgba(0,0,0,0.08)))',
  field: 'var(--hw-field, var(--bg-tertiary, rgba(0,0,0,0.045)))',
  shadow: 'var(--hw-shadow-pop, 0 12px 32px -8px rgba(0,0,0,0.28))',
};

const ICONS = {
  prev: <polyline points="15 18 9 12 15 6" />,
  next: <polyline points="9 18 15 12 9 6" />,
  close: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  download: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
};

function IconBtn({ icon, label, onClick, disabled, style, btnRef }) {
  return (
    <button
      ref={btnRef}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      data-lightbox-btn={icon}
      className="hw-icon-btn"
      style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: C.ink, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, flexShrink: 0, ...style }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[icon]}</svg>
    </button>
  );
}

/**
 * `items`: [{ messageId, part, filename, size }]; `index` the one shown. `onIndex(i)` moves,
 * `onClose()` closes, `onDownload(item, url)` saves one (url: the cached object URL, if any).
 */
export default function AttachmentLightbox({ items, index, onIndex, onClose, onDownload, formatSize = () => '' }) {
  const { t } = useTranslation();
  const item = items[index];
  const [state, setState] = useState(() => ({ key: null, url: null, failed: false }));
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const key = item ? `${item.messageId}:${item.part}` : null;
  const many = items.length > 1;

  useEffect(() => {
    if (!item) return undefined;
    let alive = true;
    const cached = peekAttachmentUrl(item.messageId, item.part);
    setState({ key, url: cached, failed: false });
    if (!cached) {
      getAttachmentObjectUrl(item.messageId, item.part)
        .then((url) => { if (alive) setState({ key, url, failed: false }); })
        .catch(() => { if (alive) setState({ key, url: null, failed: true }); });
    }
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the close button on open; give focus back to whatever had it on close.
  useEffect(() => {
    const before = document.activeElement;
    closeRef.current?.focus();
    return () => { if (before && typeof before.focus === 'function' && document.contains(before)) before.focus(); };
  }, []);

  // Keys go to the lightbox alone: window capture runs before every document listener (the
  // reader's and the list's shortcuts), and aria-modal tells the rest to stand down too.
  useEffect(() => {
    const onKey = (e) => {
      const go = (d) => { e.preventDefault(); onIndex((index + d + items.length) % items.length); };
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft' && many) go(-1);
      else if (e.key === 'ArrowRight' && many) go(1);
      else if (e.key === 'Tab') {
        const nodes = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled])') || []);
        if (nodes.length) {
          const at = nodes.indexOf(document.activeElement);
          const next = e.shiftKey ? (at <= 0 ? nodes.length - 1 : at - 1) : (at === nodes.length - 1 ? 0 : at + 1);
          e.preventDefault();
          nodes[next].focus();
        }
      } else return;
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, items.length, many, onClose, onIndex]);

  if (!item) return null;
  const shown = state.key === key ? state : { url: null, failed: false };
  const size = formatSize(item.size);
  const label = items.length > 1 ? `${index + 1} / ${items.length}` : '';

  return createPortal(
    <div
      data-lightbox=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.scrim, animation: 'hw-fade-in 160ms ease 1' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={item.filename}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', maxWidth: '90vw', maxHeight: '90vh', minWidth: 'min(320px, 90vw)', borderRadius: 12, background: C.content, color: C.ink, boxShadow: C.shadow, overflow: 'hidden', fontFamily: 'var(--hw-font-body, inherit)' }}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, background: C.field }}>
          {shown.url && (
            <img
              data-lightbox-img=""
              src={shown.url}
              alt={item.filename}
              onError={() => setState({ key, url: null, failed: true })}
              style={{ display: 'block', maxWidth: '90vw', maxHeight: 'calc(90vh - 52px)', objectFit: 'contain' }}
            />
          )}
          {!shown.url && (
            <span role={shown.failed ? 'alert' : 'status'} style={{ padding: 24, fontSize: 13, color: C.muted }}>
              {shown.failed ? t('message.preview.failed') : t('common.loading')}
            </span>
          )}
          {many && (
            <>
              <IconBtn icon="prev" label={t('message.preview.previous')} onClick={() => onIndex((index - 1 + items.length) % items.length)} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', background: C.content, boxShadow: `0 0 0 .5px ${C.line}` }} />
              <IconBtn icon="next" label={t('message.preview.next')} onClick={() => onIndex((index + 1) % items.length)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: C.content, boxShadow: `0 0 0 .5px ${C.line}` }} />
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, padding: '0 8px 0 16px', borderTop: `1px solid ${C.line}`, boxSizing: 'border-box' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span data-lightbox-name="" title={item.filename} style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.filename}</span>
            <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{[size, label].filter(Boolean).join(' · ')}</span>
          </div>
          <IconBtn icon="download" label={t('message.preview.download')} onClick={() => onDownload(item, shown.url)} />
          <IconBtn icon="close" btnRef={closeRef} label={t('message.preview.close')} onClick={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
