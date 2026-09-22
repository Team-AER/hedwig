// Shared UI primitives for Hedwig views. Inline styles over the shell's --hw-* tokens, each with
// a fallback to the light "Hedwig" value so views render before the theme is installed.
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  classifyError, formatWhen, formatAgo, initials, linkifyCitations, categoryTone, hashIndex, formatCount,
} from './helpers.js';
import { openMessage, openSettings, useDismiss } from './hooks.js';
import { tr } from './i18n.js';

export const T = {
  ground: 'var(--hw-ground, #F3EEE4)',
  surface: 'var(--hw-surface, #FFFDF9)',
  raised: 'var(--hw-raised, #EFE8DB)',
  border: 'var(--hw-border, #E2DACB)',
  ink: 'var(--hw-ink, #1B1A17)',
  muted: 'var(--hw-muted, #6B665C)',
  teal: 'var(--hw-teal, #1F6B66)',
  tealTint: 'var(--hw-teal-tint, #D7E8E5)',
  tealText: 'var(--hw-teal-text, #155450)',
  amber: 'var(--hw-amber, #B56E1A)',
  amberTint: 'var(--hw-amber-tint, #F5E3C8)',
  amberText: 'var(--hw-amber-text, #7A4A0E)',
  red: 'var(--hw-red, #A8432E)',
  redTint: 'color-mix(in srgb, var(--hw-red, #A8432E) 14%, transparent)',
  display: "var(--hw-font-display, 'Fraunces', Georgia, serif)",
  body: "var(--hw-font-body, 'IBM Plex Sans', system-ui, sans-serif)",
  mono: "var(--hw-font-mono, 'IBM Plex Mono', ui-monospace, monospace)",
};

export const TONES = {
  amber: { bg: T.amberTint, fg: T.amberText, dot: T.amber },
  teal: { bg: T.tealTint, fg: T.tealText, dot: T.teal },
  red: { bg: T.redTint, fg: T.red, dot: T.red },
  neutral: { bg: T.raised, fg: T.muted, dot: T.muted },
  ink: { bg: T.ink, fg: T.surface, dot: T.ink },
};

// Small stroke icons used inside views (the shell's icons.jsx covers navigation icons).
const GLYPHS = {
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  check: 'M5 12.5l4.5 4.5L19 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  archive: 'M4 7h16M5 7l1 12h12l1-12M10 11h4',
  pin: 'M12 17v4M8 3h8l-1 6 3 3H6l3-3z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  send: 'M4 12l16-8-6 16-2-7z',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  play: 'M8 5l11 7-11 7z',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-3.5-3.5',
  ask: 'M4 5h16v11H9l-5 4z',
};

export function Glyph({ name, size = 15, stroke = 1.8, style }) {
  const d = GLYPHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...style }}>
      <path d={d} />
    </svg>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────
/** Scrollable pane body with the standard padding. */
export function ViewFrame({ children, style, label, padded = true, background = T.surface }) {
  return (
    <section aria-label={label} style={{
      height: '100%', minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
      background, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45, overflow: 'auto',
      padding: padded ? '18px 20px' : 0, ...style,
    }}>
      {children}
    </section>
  );
}

export function Title({ children, sub, right, level = 1, style }) {
  const H = level === 1 ? 'h1' : 'h2';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', ...style }}>
      <H style={{ margin: 0, fontFamily: T.display, fontSize: level === 1 ? 24 : 18, fontWeight: 600, letterSpacing: '-0.01em' }}>{children}</H>
      {sub != null && <span style={{ fontSize: 12, color: T.muted }}>{sub}</span>}
      {right && <><span style={{ flexGrow: 1 }} />{right}</>}
    </div>
  );
}

export function SectionLabel({ children, right, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>{children}</div>
      {right && <><span style={{ flexGrow: 1 }} />{right}</>}
    </div>
  );
}

export function Card({ children, style, tone, as: As = 'div', ...rest }) {
  const dark = tone === 'ink';
  return (
    <As {...rest} style={{
      padding: '14px 16px', borderRadius: 10, boxSizing: 'border-box',
      background: dark ? T.ink : T.surface, color: dark ? T.surface : T.ink,
      border: dark ? 'none' : `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 8, ...style,
    }}>
      {children}
    </As>
  );
}

// ── Chips ────────────────────────────────────────────────────────────────────
export function Chip({ children, tone = 'neutral', size = 'sm', style, title }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: size === 'md' ? '4px 10px' : '2px 8px',
      borderRadius: 999, background: t.bg, color: t.fg, fontSize: size === 'md' ? 12 : 11, fontWeight: 500,
      whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', ...style,
    }}>
      {children}
    </span>
  );
}

/** Triage reason chip: amber for needs you, teal for waiting/informational, red for spam. */
export function ReasonChip({ triage, children, size }) {
  const tone = categoryTone(triage?.category);
  // Never shrink: the chip is the row's headline reason; the muted "why" text truncates instead.
  return <Chip tone={tone} size={size} style={{ flexShrink: 0, maxWidth: 'none' }}>{children}</Chip>;
}

export function Dot({ color, size = 8, style }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block', ...style }} />;
}

/** Filter pill (radio-like). */
export function Pill({ active, children, onClick, count, ...rest }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} {...rest} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
      border: `1px solid ${active ? T.ink : T.border}`, background: active ? T.ink : 'transparent',
      color: active ? T.surface : T.ink, font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
    }}>
      {children}
      {count != null && <span style={{ fontFamily: T.mono, fontSize: 11, opacity: 0.75 }}>{formatCount(count)}</span>}
    </button>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────
export function Button({ variant = 'secondary', size = 'md', children, style, busy, disabled, type = 'button', ...rest }) {
  const v = {
    primary: { background: T.ink, color: T.surface, border: `1px solid ${T.ink}` },
    secondary: { background: T.surface, color: T.ink, border: `1px solid ${T.border}` },
    ghost: { background: 'transparent', color: T.ink, border: '1px solid transparent' },
    danger: { background: 'transparent', color: T.red, border: `1px solid ${T.border}` },
    inverse: { background: T.surface, color: T.ink, border: `1px solid ${T.surface}` },
    inverseGhost: { background: 'transparent', color: T.surface, border: `1px solid ${T.muted}` },
  }[variant];
  const pad = size === 'sm' ? '4px 10px' : '7px 12px';
  return (
    <button type={type} disabled={disabled || busy} aria-busy={busy || undefined} {...rest} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: pad, borderRadius: 7,
      font: 'inherit', fontSize: size === 'sm' ? 12 : 13, fontWeight: variant === 'primary' ? 500 : 400,
      cursor: disabled || busy ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap', ...v, ...style,
    }}>
      {busy && <Spinner size={12} />}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, onClick, size = 28, style, active, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} {...rest} style={{
      width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7,
      border: `1px solid ${active ? T.border : 'transparent'}`, background: active ? T.raised : 'transparent',
      color: T.muted, cursor: 'pointer', padding: 0, flexShrink: 0, ...style,
    }}>
      {typeof icon === 'string' ? <Glyph name={icon} /> : icon}
    </button>
  );
}

// ── States ───────────────────────────────────────────────────────────────────
export function Spinner({ size = 16, label }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: T.muted, fontSize: 13 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ animation: 'hw-spin 0.9s linear infinite' }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <style>{'@keyframes hw-spin{to{transform:rotate(360deg)}}'}</style>
      {label && <span>{label}</span>}
    </span>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner label={label} /></div>;
}

export function Empty({ title, children, action, icon }) {
  return (
    <div style={{ padding: '32px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center', color: T.muted }}>
      {icon}
      {title && <div style={{ fontFamily: T.display, fontSize: 18, fontWeight: 600, color: T.ink }}>{title}</div>}
      {children && <div style={{ fontSize: 13, maxWidth: 380 }}>{children}</div>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry, compact }) {
  const msg = typeof error === 'string' ? error : error?.message || 'Something went wrong';
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '6px 10px' : '10px 12px', borderRadius: 8,
      background: T.redTint, color: T.red, fontSize: 13,
    }}>
      <span style={{ flexGrow: 1, minWidth: 0 }}>{msg}</span>
      {onRetry && <Button size="sm" onClick={() => onRetry()}>{tr('ui.retry', 'Retry')}</Button>}
    </div>
  );
}

/**
 * The calm state for an error, chosen by kind: missing route (404), feature off (403/503),
 * budget spent (429), or a real error with retry.
 */
export function StateView({ error, onRetry, what = 'This view', compact }) {
  const kind = classifyError(error);
  if (!kind) return null;
  if (kind === 'missing') {
    return <Empty title={compact ? undefined : 'Not available yet'}>{what} is not available on this server yet.</Empty>;
  }
  if (kind === 'off') {
    return (
      <Empty title={compact ? undefined : 'Turned off'} action={<Button size="sm" onClick={() => openSettings()}>{tr('ui.openHedwigSettings', 'Open Hedwig settings')}</Button>}>
        {what} is switched off for your account. You can turn it on in Hedwig settings; mail keeps working either way.
      </Empty>
    );
  }
  if (kind === 'budget') {
    return (
      <Empty title={compact ? undefined : 'Daily budget reached'} action={<Button size="sm" onClick={() => openSettings()}>{tr('ui.seeTodaySUsage', 'See today’s usage')}</Button>}>
        Today’s model budget for this feature is used up. It resets at midnight; everything already indexed still works.
      </Empty>
    );
  }
  return <div style={{ padding: compact ? 0 : 12 }}><ErrorBox error={error} onRetry={onRetry} /></div>;
}

/** Inline error for a failed mutation: budget and feature-off get a friendlier line. */
export function ActionError({ error, onDismiss }) {
  if (!error) return null;
  const kind = classifyError(error);
  const text = kind === 'budget' ? 'Today’s model budget for this is used up. It resets at midnight.'
    : kind === 'off' ? 'That feature is switched off in Hedwig settings.'
      : kind === 'missing' ? 'Not available on this server yet.'
        : error.message || 'Something went wrong';
  return (
    <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 8, background: T.redTint, color: T.red, fontSize: 12 }}>
      <span style={{ flexGrow: 1 }}>{text}</span>
      {onDismiss && <IconButton label="Dismiss" icon="close" size={22} onClick={onDismiss} style={{ color: T.red }} />}
    </div>
  );
}

// ── Time, people, accounts ───────────────────────────────────────────────────
export function RelativeTime({ value, mode = 'when', style }) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const text = mode === 'ago' ? formatAgo(d) : formatWhen(d);
  return <time dateTime={d.toISOString()} title={d.toLocaleString()} style={{ whiteSpace: 'nowrap', ...style }}>{text}</time>;
}

export function AccountDot({ account, size = 10, title }) {
  const color = account?.color || 'var(--hw-muted, #6B665C)';
  return <span aria-label={title || account?.name} title={title || account?.name} role="img" style={{ width: size, height: size, borderRadius: 3, background: color, flexShrink: 0, display: 'inline-block' }} />;
}

const AVATAR_TONES = [T.teal, T.amber, T.ink, T.muted];

export function Avatar({ name, email, size = 36 }) {
  const bg = AVATAR_TONES[hashIndex(email || name, AVATAR_TONES.length)];
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: '50%', background: bg, color: T.surface, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: Math.round(size * 0.36),
    }}>
      {initials(name, email)}
    </span>
  );
}

// ── Markdown with citations ──────────────────────────────────────────────────
const CITE_CSS = `
.hw-md p{margin:0 0 8px}.hw-md p:last-child{margin-bottom:0}.hw-md ul,.hw-md ol{margin:0 0 8px;padding-left:20px}
.hw-md h1,.hw-md h2,.hw-md h3{font-family:var(--hw-font-display, 'Fraunces', Georgia, serif);font-weight:600;margin:10px 0 6px;font-size:16px}
.hw-md code{font-family:var(--hw-font-mono, 'IBM Plex Mono', monospace);font-size:12px;background:var(--hw-raised, #EFE8DB);padding:1px 4px;border-radius:4px}
.hw-md a{color:var(--hw-teal, #1F6B66)}
.hw-md .hw-cite{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;margin:0 1px;
  vertical-align:super;font:500 10px/1 var(--hw-font-mono, 'IBM Plex Mono', monospace);color:var(--hw-teal-text, #155450);
  background:var(--hw-teal-tint, #D7E8E5);border:0;border-radius:4px;cursor:pointer}
.hw-md .hw-cite:hover,.hw-md .hw-cite:focus-visible{background:var(--hw-teal, #1F6B66);color:var(--hw-surface, #FFFDF9)}`;

/**
 * Render markdown (marked + DOMPurify). `[n]` citations become buttons: `resolveCite(n)` returns a
 * message id (or a MessageLite) to open; `[msg:<id>]` opens that message directly.
 */
export function Markdown({ text, resolveCite, onCite, style }) {
  const html = useMemo(() => {
    let raw;
    try { raw = marked.parse(String(text || ''), { gfm: true, breaks: true, async: false }); } catch { raw = ''; }
    const withCites = linkifyCitations(raw).replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    return DOMPurify.sanitize(withCites, { ADD_ATTR: ['target', 'data-cite', 'data-msg'] });
  }, [text]);

  const onClick = (e) => {
    const el = e.target.closest?.('[data-cite],[data-msg]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.msg) { openMessage(el.dataset.msg); return; }
    const n = Number(el.dataset.cite);
    if (onCite) { onCite(n); return; }
    const target = resolveCite?.(n);
    if (!target) return;
    if (typeof target === 'string') openMessage(target);
    else openMessage(target.id, { lite: target });
  };

  return (
    <>
      <style>{CITE_CSS}</style>
      {/* Clicks are delegated to the citation <button>s inside, which are keyboard-focusable. */}
      <div className="hw-md" onClick={onClick} style={{ fontSize: 14, overflowWrap: 'anywhere', ...style }} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

// ── Stats and charts ─────────────────────────────────────────────────────────
export function StatTile({ label, value, sub, tone, children }) {
  const color = tone ? TONES[tone]?.dot : T.ink;
  return (
    <Card style={{ gap: 2, padding: '12px 14px', minWidth: 0 }}>
      <span style={{ fontSize: 12, color: T.muted }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 500, color }}>{value ?? '–'}</span>
      {sub && <span style={{ fontSize: 12, color: T.muted }}>{sub}</span>}
      {children}
    </Card>
  );
}

export function TileGrid({ children, min = 170 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 12 }}>{children}</div>;
}

/** Single-series trend line (2px, round caps) with an end dot. */
export function Sparkline({ points, width = 160, height = 36, color = T.teal, label }) {
  if (!points) return null;
  const last = points.split(' ').pop()?.split(',').map(Number);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r="4" fill={color} stroke={T.surface} strokeWidth="2" />}
    </svg>
  );
}

/**
 * Grouped column chart: rows [{ label, values: [n, n] }], series [{ name, color }]. Hovering a
 * column group shows its values; ticks on a single y axis; a legend is always shown for 2+ series.
 */
export function ColumnChart({ rows, series, height = 160, label, formatLabel = (l) => l }) {
  const [hover, setHover] = useState(null);
  const boxRef = useRef(null);
  const [W, setW] = useState(480);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(200, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(1, ...rows.flatMap((r) => r.values.map((v) => Number(v) || 0)));
  const nice = niceCeil(max);
  const H = height;
  const padL = 34;
  const padB = 20;
  const plotW = W - padL - 4;
  const plotH = H - padB - 6;
  const band = plotW / Math.max(1, rows.length);
  const barW = Math.min(12, Math.max(2, (band - 4) / series.length - 2));
  const ticks = [0, nice / 2, nice];
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotW / 56))));
  return (
    <div ref={boxRef} style={{ position: 'relative', width: '100%' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ display: 'block' }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const y = 6 + plotH - (t / nice) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W} y1={y} y2={y} stroke={T.border} strokeWidth="1" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill={T.muted} fontFamily="var(--hw-font-mono, monospace)">{formatCount(t)}</text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const x0 = padL + i * band + (band - (barW + 2) * series.length + 2) / 2;
          return (
            <g key={r.label} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * band} y={0} width={band} height={H - padB} fill={hover === i ? T.raised : 'transparent'} opacity="0.6" />
              {r.values.map((v, k) => {
                const h = ((Number(v) || 0) / nice) * plotH;
                const x = x0 + k * (barW + 2);
                const y = 6 + plotH - h;
                return h > 0 ? <path key={k} d={roundedTop(x, y, barW, h, Math.min(4, barW / 2, h))} fill={series[k].color} /> : null;
              })}
              {i % every === 0 && (
                <text x={padL + i * band + band / 2} y={H - 5} textAnchor="middle" fontSize="10" fill={T.muted}>{formatLabel(r.label)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && rows[hover] && (
        <div role="tooltip" style={{
          position: 'absolute', top: 0, left: Math.min(W - 150, Math.max(0, padL + hover * band + band + 6)), pointerEvents: 'none',
          background: T.ink, color: T.surface, borderRadius: 6, padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap',
        }}>
          <div style={{ fontWeight: 600 }}>{formatLabel(rows[hover].label)}</div>
          {series.map((sr, k) => (
            <div key={sr.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Dot color={sr.color} /> {sr.name}: <span style={{ fontFamily: T.mono }}>{formatCount(rows[hover].values[k])}</span>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: T.muted, marginTop: 6 }}>
          {series.map((sr) => <span key={sr.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: sr.color }} />{sr.name}</span>)}
        </div>
      )}
    </div>
  );
}

function niceCeil(v) {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

function roundedTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Thin horizontal meter (0..1) used for rates and budget usage. */
export function Meter({ value, color = T.teal, width = 80, label }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={v}
      style={{ display: 'inline-block', width, height: 6, borderRadius: 3, background: T.raised, overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${v * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
    </span>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────
/**
 * columns: [{ key, label, width?, render?(row), mono?, align? }]. onRowClick makes rows buttons
 * (Enter/Space activate). selectedKey highlights a row.
 */
export function Table({ columns, rows, rowKey = (r, i) => r.id ?? i, onRowClick, selectedKey, empty = 'Nothing here yet', label }) {
  const template = columns.map((c) => c.width || 'minmax(0, 1fr)').join(' ');
  const cell = (c) => ({
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: c.mono ? T.mono : undefined, fontSize: c.mono ? 12 : 13, textAlign: c.align || 'left',
    color: c.muted ? T.muted : undefined,
  });
  return (
    <div role="table" aria-label={label} style={{ borderRadius: 10, background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
      <div role="row" style={{ display: 'grid', gridTemplateColumns: template, gap: 10, padding: '8px 14px', borderBottom: `1px solid ${T.border}` }}>
        {columns.map((c) => (
          <span role="columnheader" key={c.key} style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, textAlign: c.align || 'left' }}>{c.label}</span>
        ))}
      </div>
      {!rows?.length && <div style={{ padding: '14px', fontSize: 13, color: T.muted }}>{empty}</div>}
      {rows?.map((r, i) => {
        const k = rowKey(r, i);
        const selected = selectedKey != null && k === selectedKey;
        return (
          <div role="row" key={k} tabIndex={onRowClick ? 0 : undefined} aria-selected={onRowClick ? selected : undefined}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } } : undefined}
            style={{
              display: 'grid', gridTemplateColumns: template, gap: 10, alignItems: 'center', padding: '9px 14px',
              borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${T.raised}`, cursor: onRowClick ? 'pointer' : undefined,
              background: selected ? T.raised : undefined, outlineOffset: -2,
            }}>
            {columns.map((c) => <span role="cell" key={c.key} style={cell(c)}>{c.render ? c.render(r) : r[c.key]}</span>)}
          </div>
        );
      })}
    </div>
  );
}

// ── Overlays ─────────────────────────────────────────────────────────────────
/** Anchored popover; place inside a position:relative wrapper. Escape / outside click closes. */
export function Popover({ open, onClose, children, align = 'right', width = 320, label, style }) {
  const ref = useRef(null);
  useDismiss(ref, open, onClose);
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label={label} style={{
      position: 'absolute', top: 'calc(100% + 4px)', [align]: 0, zIndex: 40, width, maxWidth: '90vw', boxSizing: 'border-box',
      borderRadius: 12, background: T.surface, border: `1px solid ${T.border}`, boxShadow: '0 12px 32px rgba(27,26,23,0.14)',
      padding: 8, color: T.ink, ...style,
    }}>
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, active, danger, hint }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 0, borderRadius: 7,
      background: active ? T.raised : 'transparent', color: danger ? T.red : T.ink, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
    }}>
      <span style={{ flexGrow: 1 }}>{children}</span>
      {hint && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{hint}</span>}
    </button>
  );
}

/** Modal dialog. Escape and the backdrop close it. */
export function Dialog({ open, onClose, title, subtitle, icon, children, footer, width = 420 }) {
  const ref = useRef(null);
  const id = useId();
  useDismiss(ref, open, onClose);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(27,26,23,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} style={{
        width, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', boxSizing: 'border-box', padding: 20, borderRadius: 14,
        background: T.surface, color: T.ink, border: `1px solid ${T.border}`, boxShadow: '0 12px 32px rgba(27,26,23,0.12)',
        display: 'flex', flexDirection: 'column', gap: 14, fontFamily: T.body, fontSize: 14,
      }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {icon}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
            <h2 id={id} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
            {subtitle && <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>{subtitle}</span>}
          </div>
          <IconButton label="Close" icon="close" onClick={onClose} />
        </div>
        {children}
        {footer && <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────
/** Compact MessageLite row that opens the message. */
export function MessageLiteRow({ message, prefix, dense }) {
  if (!message) return null;
  return (
    <button type="button" onClick={() => openMessage(message.id, { lite: message })} style={{
      display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', padding: dense ? '5px 0' : '7px 0', border: 0,
      borderTop: `1px solid ${T.raised}`, background: 'transparent', color: T.ink, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
    }}>
      {prefix}
      <AccountDot account={message.account} size={8} />
      <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: message.is_read === false ? 600 : 400 }}>{message.subject || '(no subject)'}</span>
        <span style={{ color: T.muted }}> · {message.from_name || message.from_email}</span>
      </span>
      <RelativeTime value={message.date} style={{ fontSize: 12, color: T.muted }} />
    </button>
  );
}

// ── Form bits ────────────────────────────────────────────────────────────────
export const inputStyle = {
  height: 34, boxSizing: 'border-box', padding: '0 10px', border: `1px solid ${T.border}`, borderRadius: 8,
  background: T.surface, color: T.ink, font: 'inherit', fontSize: 13, minWidth: 0,
};

export const TextInput = forwardRef(function TextInput({ style, ...rest }, ref) {
  return <input ref={ref} {...rest} style={{ ...inputStyle, ...style }} />;
});

export function Select({ style, children, ...rest }) {
  return <select {...rest} style={{ ...inputStyle, paddingRight: 6, ...style }}>{children}</select>;
}

export const TextArea = forwardRef(function TextArea({ style, ...rest }, ref) {
  return <textarea ref={ref} {...rest} style={{ ...inputStyle, height: 'auto', minHeight: 72, padding: '8px 10px', resize: 'vertical', lineHeight: 1.45, ...style }} />;
});

export function Checkbox({ checked, onChange, label, sub, mono, disabled }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, accentColor: 'var(--hw-ink, #1B1A17)' }} />
      <span>
        <span style={mono ? { fontFamily: T.mono, fontWeight: 500 } : undefined}>{label}</span>
        {sub && <><br /><span style={{ color: T.muted, fontSize: 12 }}>{sub}</span></>}
      </span>
    </label>
  );
}

/** Tab strip (role=tablist). */
export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} style={{
          padding: '3px 10px', borderRadius: 999, border: `1px solid ${value === t.id ? T.ink : T.border}`,
          background: value === t.id ? T.ink : 'transparent', color: value === t.id ? T.surface : T.ink, font: 'inherit', fontSize: 12, cursor: 'pointer',
        }}>
          {t.label}{t.count != null && <span style={{ fontFamily: T.mono, marginLeft: 6, opacity: 0.75 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Key-hint footer ("e archive · x not for me"). */
export function KeyHints({ hints }) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 16px', borderTop: `1px solid ${T.border}`, fontSize: 11, color: T.muted, fontFamily: T.mono }}>
      {hints.map(([k, v]) => <span key={k}><strong style={{ fontWeight: 500, color: T.ink }}>{k}</strong> {v}</span>)}
    </div>
  );
}
