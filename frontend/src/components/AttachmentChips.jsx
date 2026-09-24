import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classifyAttachmentRisk } from '../utils/attachmentRisk.js';

// A message's attachments: one chip per file, and "Download all" (a zip) when there is more
// than one. A risky file (see utils/attachmentRisk.js) needs a second click, and the first one
// says why; "Download all" asks first whenever any file in it would.
//
// Extracted from MessagePane so the Hedwig reader can show the same row. `look="classic"` is
// MessagePane's own markup, unchanged; `look="hedwig"` is the reader's tile (220×48, radius 8,
// hairline, over the --hw-* palette).

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

/** Fetch one attachment with the session cookie and save it under its own name. */
export async function downloadAttachment(messageId, part, filename) {
  const res = await fetch(`/api/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}`, {
    credentials: 'include'
  });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const LOOKS = {
  classic: {
    wrap: { marginBottom: 20 },
    count: { fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 },
    all: (armed) => ({ fontSize: 12, color: armed ? 'var(--red)' : 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }),
    red: 'var(--red)', amber: 'var(--amber)', quiet: 'var(--text-tertiary)',
    fill: 'var(--bg-secondary)', hoverFill: 'var(--bg-tertiary)', border: 'var(--border)',
    ink: 'var(--text-primary)', glyph: 'var(--text-secondary)', iconSize: 18,
  },
  hedwig: {
    wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
    count: { fontSize: 11, color: 'var(--hw-muted)', fontWeight: 600 },
    all: (armed) => ({ fontSize: 12, fontWeight: 500, color: armed ? 'var(--hw-red, #B3261E)' : 'var(--hw-accent-ink)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }),
    red: 'var(--hw-red, #B3261E)', amber: 'var(--hw-attention-ink)', quiet: 'var(--hw-muted)',
    fill: 'transparent', hoverFill: 'var(--hw-hover)', border: 'var(--hw-line)',
    ink: 'var(--hw-ink)', glyph: 'var(--hw-muted)', iconSize: 20,
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
  useEffect(() => { setRiskArmed(null); }, [messageId]);

  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length || !messageId) return null;

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
            style={L.all(downloadAllArmed)}
          >
            <DownloadGlyph size={12} />
            {downloadAllArmed
              ? t('message.attachmentRisk.armed', { label: t('message.downloadAll') })
              : t('message.downloadAll')}
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
          return (
          <button
            key={i}
            type={hedwig ? 'button' : undefined}
            onClick={() => {
              if (risky && !armed) { setRiskArmed(att.part); return; }
              setRiskArmed(null);
              handleDownload(att.part, att.filename);
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
            <span style={{ display: 'flex', flexShrink: 0, color: L.glyph }}>{fileIcon(att.type, L.iconSize)}</span>
            <div style={{ minWidth: 0, textAlign: 'left', flex: hedwig ? 1 : undefined }}>
              <div style={{
                fontSize: 12, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {att.filename}
              </div>
              <div style={{ fontSize: 11, color: L.quiet, fontVariantNumeric: hedwig ? 'tabular-nums' : undefined }}>
                {busy ? t('message.downloading') : formatBytes(att.size)}
              </div>
              {risk.level !== 'ok' && (
                <div style={{ fontSize: 11, color: riskColor, fontWeight: risk.level === 'block' ? 600 : 400, whiteSpace: 'normal' }}>
                  {armed ? t('message.attachmentRisk.armed', { label: riskText }) : riskText}
                </div>
              )}
            </div>
            {hedwig
              ? <DownloadGlyph size={14} stroke={L.glyph} style={{ flexShrink: 0, opacity: over || armed ? 1 : 0, transition: 'opacity 120ms ease' }} />
              : <DownloadGlyph size={13} stroke="var(--text-tertiary)" style={{ flexShrink: 0 }} />}
          </button>
          );
        })}
      </div>
    </div>
  );
}
