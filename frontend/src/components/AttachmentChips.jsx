import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classifyAttachmentRisk } from '../utils/attachmentRisk.js';
import {
  THUMB_MAX_BYTES, attachmentUrl, getAttachmentObjectUrl, isPdfAttachment, isPreviewableImage,
  peekAttachmentUrl, splitFilename,
} from '../utils/attachmentPreview.js';
import AttachmentLightbox from './AttachmentLightbox.jsx';

// A message's attachments: one chip per file, and "Download all" (a zip) when there is more
// than one. A risky file (see utils/attachmentRisk.js) needs a second click, and the first one
// says why; "Download all" asks first whenever any file in it would.
//
// Extracted from MessagePane so the Hedwig reader can show the same row. `look="classic"` is
// MessagePane's own markup, unchanged; `look="hedwig"` is the reader's tile (220×48, radius 8,
// hairline, over the --hw-* palette).
//
// A picture shows a 40×40 thumbnail (fetched once it scrolls into view, up to 8 MB) and opens in
// a lightbox; a PDF opens in the browser's viewer in a new tab; anything else downloads. Long
// names are cut in the middle so the extension stays visible.

// riskArmed value for the "Download all" link. A Symbol, so no attachment part can ever equal it.
const DOWNLOAD_ALL = Symbol('downloadAll');

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(type, size = 18) {
  const t = (type || '').toLowerCase();
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: size > 18 ? 1.5 : 1.75, 'aria-hidden': 'true' };
  if (t.startsWith('image/')) return (
    <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
  );
  if (t === 'application/pdf') return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('word') || t.includes('document')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('sheet') || t.includes('excel') || t.includes('csv')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="10" y1="13" x2="10" y2="17"/><line x1="8" y1="15" x2="12" y2="15"/></svg>
  );
  if (t.includes('zip') || t.includes('compressed') || t.includes('archive')) return (
    <svg {...p}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="11" x2="16" y2="11"/></svg>
  );
  if (t.startsWith('video/')) return (
    <svg {...p}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
  );
  if (t.startsWith('audio/')) return (
    <svg {...p}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
  );
  return (
    <svg {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
  );
}

function DownloadGlyph({ size, stroke = 'currentColor', style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" style={style} aria-hidden="true">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function saveUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// What a click on the chip does: download, preview in the lightbox, or open in a new tab.
function ActionGlyph({ kind, size, stroke, style }) {
  if (kind === 'download') return <DownloadGlyph size={size} stroke={stroke} style={style} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" style={style} aria-hidden="true" data-glyph={kind}>
      {kind === 'preview'
        ? <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>
        : <><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>}
    </svg>
  );
}

/** Fetch one attachment with the session cookie and save it under its own name. */
export async function downloadAttachment(messageId, part, filename) {
  const res = await fetch(attachmentUrl(messageId, part), {
    credentials: 'include'
  });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  saveUrl(url, filename);
  URL.revokeObjectURL(url);
}

/**
 * A PDF in a new tab, in the browser's own viewer: the attachment route with ?inline=1, which the
 * backend serves as application/pdf with an inline disposition. Opened synchronously from the
 * click, so no popup blocker stands in the way; where no tab opens (a shell that refuses
 * window.open), it downloads instead.
 */
export function openPdfAttachment(messageId, part, filename) {
  const w = window.open(attachmentUrl(messageId, part, { inline: true }), '_blank');
  if (w) { try { w.opener = null; } catch { /* cross-origin already */ } return Promise.resolve(); }
  return downloadAttachment(messageId, part, filename);
}

/**
 * The file's name, cut in the middle when it does not fit: the head takes the ellipsis, the
 * extension (and two characters before it) always shows. The full name is the tooltip.
 */
export function MiddleName({ name, style }) {
  const { head, tail } = splitFilename(name);
  return (
    <span data-attachment-name="" title={name} style={{ display: 'flex', minWidth: 0, whiteSpace: 'nowrap', ...style }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{head}</span>
      {tail && <span style={{ flexShrink: 0 }}>{tail}</span>}
    </span>
  );
}

/**
 * The 40×40 thumbnail of a picture attachment (radius 6, cover). Fetched only once the chip is on
 * screen; a neutral box while it loads; `fallback` (the file glyph) if it cannot be drawn.
 */
export function AttachmentThumb({ messageId, part, fallback, fill, size = 40, radius = 6 }) {
  const ref = useRef(null);
  const [url, setUrl] = useState(() => peekAttachmentUrl(messageId, part));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const cached = peekAttachmentUrl(messageId, part);
    setUrl(cached);
    if (cached) return undefined;
    let alive = true;
    const load = () => getAttachmentObjectUrl(messageId, part)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    const el = ref.current;
    if (typeof IntersectionObserver === 'undefined' || !el) { load(); return () => { alive = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [messageId, part]);
  return (
    <span
      ref={ref}
      data-attachment-thumb={failed ? 'failed' : url ? 'ready' : 'loading'}
      style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: failed ? 'transparent' : fill }}
    >
      {failed ? fallback : url ? (
        <img src={url} alt="" draggable={false} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : null}
    </span>
  );
}

const LOOKS = {
  classic: {
    wrap: { marginBottom: 20 },
    count: { fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 },
    all: (armed) => ({ fontSize: 12, color: armed ? 'var(--red)' : 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }),
    red: 'var(--red)', amber: 'var(--amber)', quiet: 'var(--text-tertiary)',
    fill: 'var(--bg-secondary)', hoverFill: 'var(--bg-tertiary)', border: 'var(--border)',
    ink: 'var(--text-primary)', glyph: 'var(--text-secondary)', iconSize: 18, thumbFill: 'var(--bg-tertiary)',
  },
  hedwig: {
    wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
    count: { fontSize: 11, color: 'var(--hw-muted)', fontWeight: 600 },
    all: (armed) => ({ fontSize: 12, fontWeight: 500, color: armed ? 'var(--hw-red, #B3261E)' : 'var(--hw-accent-ink)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }),
    red: 'var(--hw-red, #B3261E)', amber: 'var(--hw-attention-ink)', quiet: 'var(--hw-muted)',
    fill: 'transparent', hoverFill: 'var(--hw-hover)', border: 'var(--hw-line)',
    ink: 'var(--hw-ink)', glyph: 'var(--hw-muted)', iconSize: 20, thumbFill: 'var(--hw-field)',
  },
};

export default function AttachmentChips({ messageId, attachments, look = 'classic' }) {
  const { t } = useTranslation();
  const L = LOOKS[look] || LOOKS.classic;
  const hedwig = look === 'hedwig';
  // riskArmed: a risky attachment needs a second click to download; the first
  // arms the button and shows why. Holds the attachment's part, or DOWNLOAD_ALL.
  const [riskArmed, setRiskArmed] = useState(null);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [hovered, setHovered] = useState(null);
  // The lightbox's position among this message's pictures, or null when it is closed.
  const [preview, setPreview] = useState(null);
  useEffect(() => { setRiskArmed(null); setPreview(null); }, [messageId]);
  const closePreview = useCallback(() => setPreview(null), []);

  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length || !messageId) return null;
  const images = list.filter(isPreviewableImage).map((att) => ({ messageId, part: att.part, filename: att.filename, size: att.size }));

  const handleDownload = async (part, filename) => {
    setDownloadingPart(part);
    try {
      await downloadAttachment(messageId, part, filename);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setDownloadingPart(null);
    }
  };
  // A picture previews, a PDF opens in a tab, anything else downloads.
  const handleOpen = (att) => {
    if (isPreviewableImage(att)) {
      const at = images.findIndex((img) => img.part === att.part);
      if (at >= 0) { setPreview(at); return; }
    }
    if (isPdfAttachment(att)) {
      openPdfAttachment(messageId, att.part, att.filename).catch((err) => console.error('Download error:', err));
      return;
    }
    handleDownload(att.part, att.filename);
  };
  const downloadPreviewed = (item, url) => {
    if (url) saveUrl(url, item.filename);
    else handleDownload(item.part, item.filename);
  };

  // "Download all" hands over every file at once, so it asks first whenever one of them would. While
  // it does, the link has no href, so a right-click "Save link as", a middle click or a long press has
  // nothing to fetch; the confirming click starts the download itself.
  const anyRiskyAttachment = list.some(att =>
    ['block', 'warn'].includes(classifyAttachmentRisk(att.filename, att.type).level));
  const downloadAllArmed = riskArmed === DOWNLOAD_ALL;
  const downloadAllUrl = `/api/mail/messages/${messageId}/attachments.zip`;
  const confirmDownloadAll = () => {
    if (!downloadAllArmed) { setRiskArmed(DOWNLOAD_ALL); return; }
    setRiskArmed(null);
    const a = document.createElement('a');
    a.href = downloadAllUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div style={L.wrap} data-attachments={hedwig ? '' : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hedwig ? 0 : 8 }}>
        <div style={L.count}>
          {t('message.attachment', { count: list.length })}
        </div>
        {list.length > 1 && (
          <a
            {...(anyRiskyAttachment ? {
              role: 'button',
              tabIndex: 0,
              onClick: confirmDownloadAll,
              onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmDownloadAll(); } },
            } : { href: downloadAllUrl, download: true })}
            data-download-all=""
            aria-label={t('message.downloadAllZip')}
            title={t('message.downloadAllZip')}
            className={hedwig ? 'hw-icon-btn' : undefined}
            style={{ ...L.all(downloadAllArmed), minWidth: 24, height: 24, justifyContent: 'center', borderRadius: 6, padding: downloadAllArmed ? '0 6px' : 0 }}
          >
            <DownloadGlyph size={14} />
            {downloadAllArmed && t('message.attachmentRisk.armed', { label: t('message.downloadAll') })}
          </a>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {list.map((att, i) => {
          const risk = classifyAttachmentRisk(att.filename, att.type);
          const risky = risk.level === 'block' || risk.level === 'warn';
          const riskColor = risk.level === 'block' ? L.red : risk.level === 'warn' ? L.amber : L.quiet;
          const armed = riskArmed === att.part;
          const busy = downloadingPart === att.part;
          const riskText = risk.level === 'ok' ? '' : risk.doubleExt
            ? t('message.attachmentRisk.doubleExt', { ext: risk.doubleExt })
            : t(`message.attachmentRisk.${risk.level}`, { ext: risk.ext });
          const over = hovered === i;
          const kind = isPreviewableImage(att) ? 'preview' : isPdfAttachment(att) ? 'open' : 'download';
          return (
          <button
            key={i}
            type={hedwig ? 'button' : undefined}
            onClick={() => {
              if (risky && !armed) { setRiskArmed(att.part); return; }
              setRiskArmed(null);
              handleOpen(att);
            }}
            disabled={busy}
            data-attachment={hedwig ? '' : undefined}
            style={hedwig ? {
              display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box',
              width: 220, maxWidth: '100%', minHeight: 48, padding: '6px 10px', borderRadius: 8,
              background: over ? L.hoverFill : L.fill, border: `1px solid ${risky ? riskColor : L.border}`,
              cursor: busy ? 'wait' : 'pointer', color: L.ink, fontFamily: 'inherit', textAlign: 'left',
            } : {
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--bg-secondary)',
              border: `1px solid ${risky ? riskColor : 'var(--border)'}`,
              cursor: busy ? 'wait' : 'pointer',
              color: 'var(--text-primary)',
              transition: 'background 0.1s',
              maxWidth: 240,
            }}
            onMouseEnter={e => { if (hedwig) setHovered(i); else e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { if (hedwig) setHovered(null); else e.currentTarget.style.background = 'var(--bg-secondary)'; }}
            onFocus={hedwig ? () => setHovered(i) : undefined}
            onBlur={hedwig ? () => setHovered(null) : undefined}
          >
            {isPreviewableImage(att) && (!att.size || att.size <= THUMB_MAX_BYTES) ? (
              <AttachmentThumb
                messageId={messageId}
                part={att.part}
                fill={L.thumbFill}
                fallback={<span style={{ display: 'flex', color: L.glyph }}>{fileIcon('image/', L.iconSize)}</span>}
              />
            ) : (
              <span style={{ display: 'flex', flexShrink: 0, color: L.glyph }}>{fileIcon(att.type, L.iconSize)}</span>
            )}
            <div style={{ minWidth: 0, textAlign: 'left', flex: hedwig ? 1 : undefined }}>
              <MiddleName name={att.filename} style={{ fontSize: 12, fontWeight: 500 }} />
              {(busy || att.size > 0) && (
                <div style={{ fontSize: 11, color: L.quiet, fontVariantNumeric: hedwig ? 'tabular-nums' : undefined }}>
                  {busy ? t('message.downloading') : formatBytes(att.size)}
                </div>
              )}
              {risk.level !== 'ok' && (
                <div style={{ fontSize: 11, color: riskColor, fontWeight: risk.level === 'block' ? 600 : 400, whiteSpace: 'normal' }}>
                  {armed ? t('message.attachmentRisk.armed', { label: riskText }) : riskText}
                </div>
              )}
            </div>
            {hedwig
              ? <ActionGlyph kind={kind} size={14} stroke={L.glyph} style={{ flexShrink: 0, opacity: over || armed ? 1 : 0, transition: 'opacity 120ms ease' }} />
              : <ActionGlyph kind={kind} size={13} stroke="var(--text-tertiary)" style={{ flexShrink: 0 }} />}
          </button>
          );
        })}
      </div>
      {preview !== null && images[preview] && (
        <AttachmentLightbox
          items={images}
          index={preview}
          onIndex={setPreview}
          onClose={closePreview}
          onDownload={downloadPreviewed}
          formatSize={formatBytes}
        />
      )}
    </div>
  );
}
