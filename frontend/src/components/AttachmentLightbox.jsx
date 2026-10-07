import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { attachmentUrl, getAttachmentObjectUrl, peekAttachmentUrl } from '../utils/attachmentPreview.js';

// The attachment viewer: a message's pictures and PDFs, one at a time, over a scrim. A title bar
// in the Quick Look idiom carries the name and size, previous / next between the message's
// viewable attachments (buttons and ← →), open in a new tab, download and close. A picture shows
// at up to 90vw × 90vh; a PDF fills a tall sheet in the browser's own viewer, framed from the
// inline route (which lets this origin frame it), so it streams in and keeps the viewer's zoom,
// search and print. Esc, the × or a click outside close it. Focus stays inside while it is open
// and goes back to the chip that opened it. Colours come from the Hedwig tokens with the classic
// palette as the fallback, so it reads in both shells and both themes.

const C = {
  scrim: 'rgba(0,0,0,0.62)',
  content: 'var(--hw-content, var(--bg-elevated, var(--bg-secondary, #FFFFFF)))',
  ink: 'var(--hw-ink, var(--text-primary, #1D1D1F))',
  muted: 'var(--hw-muted, var(--text-secondary, #5E5E63))',
  line: 'var(--hw-line, var(--border, rgba(0,0,0,0.08)))',
  field: 'var(--hw-field, var(--bg-tertiary, rgba(0,0,0,0.045)))',
  shadow: 'var(--hw-shadow-pop, 0 12px 32px -8px rgba(0,0,0,0.28))',
};

const BAR = 48;

const ICONS = {
  prev: <polyline points="15 18 9 12 15 6" />,
  next: <polyline points="9 18 15 12 9 6" />,
  tab: <><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>,
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

function narrowScreen() {
  try { return Boolean(window.matchMedia?.('(max-width: 600px)').matches); } catch { return false; }
}

/**
 * A PDF in the browser's viewer. The frame's load event fires for an error page too, so the
 * frame's document decides: only a PDF document counts as shown (a failed fetch is a JSON page,
 * and a frame the browser refused has no document this page can read).
 */
function PdfFrame({ item, failedText, loadingText, retryText }) {
  const [state, setState] = useState({ key: null, status: 'loading', attempt: 0 });
  const key = `${item.messageId}:${item.part}`;
  const shown = state.key === key ? state : { key, status: 'loading', attempt: 0 };
  const onLoad = (e) => {
    let type;
    try { type = e.currentTarget.contentDocument?.contentType; } catch { type = null; }
    setState({ ...shown, status: type === 'application/pdf' ? 'ready' : 'failed' });
  };
  return (
    <div data-lightbox-state={shown.status} style={{ position: 'relative', flex: 1, minHeight: 0, background: C.field }}>
      <iframe
        key={`${key}:${shown.attempt}`}
        data-lightbox-pdf=""
        title={item.filename}
        src={attachmentUrl(item.messageId, item.part, { inline: true })}
        onLoad={onLoad}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', visibility: shown.status === 'ready' ? 'visible' : 'hidden' }}
      />
      {shown.status !== 'ready' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, fontSize: 13, color: C.muted, textAlign: 'center' }}>
          <span role={shown.status === 'failed' ? 'alert' : 'status'}>{shown.status === 'failed' ? failedText : loadingText}</span>
          {shown.status === 'failed' && (
            <button
              type="button"
              data-lightbox-retry=""
              onClick={() => setState({ key, status: 'loading', attempt: shown.attempt + 1 })}
              style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--hw-accent-ink, var(--accent, #007AFF))', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              {retryText}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `items`: [{ messageId, part, filename, size, kind: 'image' | 'pdf' }]; `index` the one shown.
 * `onIndex(i)` moves, `onClose()` closes, `onDownload(item, url)` saves one (url: the cached object
 * URL of a picture, if any), `onOpenInTab(item)` shows it in a new browser tab.
 */
export default function AttachmentLightbox({ items, index, onIndex, onClose, onDownload, onOpenInTab, formatSize = () => '' }) {
  const { t } = useTranslation();
  const item = items[index];
  const [state, setState] = useState(() => ({ key: null, url: null, failed: false }));
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const key = item ? `${item.messageId}:${item.part}` : null;
  const pdf = item?.kind === 'pdf';
  const many = items.length > 1;

  useEffect(() => {
    if (!item || pdf) return undefined;
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

  // Keys go to the viewer alone: window capture runs before every document listener (the
  // reader's and the list's shortcuts), and aria-modal tells the rest to stand down too. Inside
  // the PDF frame the browser's viewer has the keys (arrows scroll the document).
  useEffect(() => {
    const onKey = (e) => {
      const go = (d) => { e.preventDefault(); onIndex((index + d + items.length) % items.length); };
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft' && many) go(-1);
      else if (e.key === 'ArrowRight' && many) go(1);
      else if (e.key === 'Tab') {
        const nodes = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled]), iframe') || []);
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
  const label = many ? `${index + 1} / ${items.length}` : '';
  const narrow = narrowScreen();
  const sheet = pdf
    ? { width: narrow ? '100vw' : 'min(1040px, calc(100vw - 48px))', height: narrow ? '100vh' : 'calc(100vh - 48px)', borderRadius: narrow ? 0 : 12 }
    : { maxWidth: '90vw', maxHeight: '90vh', minWidth: 'min(360px, 90vw)', borderRadius: 12 };

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
        data-lightbox-kind={pdf ? 'pdf' : 'image'}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', ...sheet, boxSizing: 'border-box', background: C.content, color: C.ink, boxShadow: C.shadow, overflow: 'hidden', fontFamily: 'var(--hw-font-body, inherit)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: BAR, padding: '0 8px 0 16px', borderBottom: `1px solid ${C.line}`, boxSizing: 'border-box', flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', marginRight: 8 }}>
            <span data-lightbox-name="" title={item.filename} style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.filename}</span>
            <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{[size, label].filter(Boolean).join(' · ')}</span>
          </div>
          {many && (
            <>
              <IconBtn icon="prev" label={t('message.preview.previous')} onClick={() => onIndex((index - 1 + items.length) % items.length)} />
              <IconBtn icon="next" label={t('message.preview.next')} onClick={() => onIndex((index + 1) % items.length)} />
              <span aria-hidden="true" style={{ width: 1, height: 20, margin: '0 6px', background: C.line, flexShrink: 0 }} />
            </>
          )}
          {onOpenInTab && <IconBtn icon="tab" label={t('message.preview.openInTab')} onClick={() => onOpenInTab(item)} />}
          <IconBtn icon="download" label={t('message.preview.download')} onClick={() => onDownload(item, pdf ? null : shown.url)} />
          <IconBtn icon="close" btnRef={closeRef} label={t('message.preview.close')} onClick={onClose} />
        </div>
        {pdf ? (
          <PdfFrame item={item} failedText={t('message.preview.failedPdf')} loadingText={t('common.loading')} retryText={t('common.retry')} />
        ) : (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, background: C.field }}>
            {shown.url && (
              <img
                data-lightbox-img=""
                src={shown.url}
                alt={item.filename}
                onError={() => setState({ key, url: null, failed: true })}
                style={{ display: 'block', maxWidth: '90vw', maxHeight: `calc(90vh - ${BAR}px)`, objectFit: 'contain' }}
              />
            )}
            {!shown.url && (
              <span role={shown.failed ? 'alert' : 'status'} style={{ padding: 24, fontSize: 13, color: C.muted }}>
                {shown.failed ? t('message.preview.failed') : t('common.loading')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
