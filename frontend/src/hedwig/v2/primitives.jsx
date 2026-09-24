// v2 design primitives (docs/hedwig/design/DESIGN-AUDIT-2026-09-24.md). Glass for navigation,
// opaque content sheets for mail, hairlines instead of boxes, the system type stack at 400/500/600,
// tabular figures, one blue accent and orange only for attention. Avatars are allowed; still no
// pills, no uppercase eyebrows, no left-border cards, no italic, no serif. Inline styles over
// --hw-* variables, as upstream does.
import { createContext, forwardRef, useContext, useEffect, useState } from 'react';
import { tv } from './i18n.js';
import { Icon } from '../icons.jsx';
import { AVATAR_HUES } from '../theme/tokens.js';

const SYSTEM = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', InterVariable, Inter, Roboto, 'Helvetica Neue', Arial, sans-serif";

export const V = {
  paper: 'var(--hw-paper, #EEF0F3)',
  ink: 'var(--hw-ink, #1D1D1F)',
  muted: 'var(--hw-muted, #5E5E63)',
  accent: 'var(--hw-accent, #007AFF)',
  accentInk: 'var(--hw-accent-ink, #0062CC)',
  // Icons and text on a solid accent fill.
  onAccent: 'var(--hw-on-accent, #FFFFFF)',
  // Small secondary text on a tinted slip: ink at 80% keeps contrast where muted grey may not.
  inkSoft: 'color-mix(in srgb, var(--hw-ink, #1D1D1F) 80%, transparent)',
  accentTint: 'var(--hw-accent-tint, rgba(0,122,255,0.12))',
  glass: 'var(--hw-glass, rgba(248,248,250,0.72))',
  edge: 'var(--hw-edge, rgba(255,255,255,0.6))',
  line: 'var(--hw-line, rgba(0,0,0,0.08))',
  line2: 'var(--hw-line2, rgba(0,0,0,0.14))',
  // The hover fill (old name).
  tint: 'var(--hw-tint, rgba(0,0,0,0.04))',
  red: 'var(--hw-red, #B3261E)',
  // Opaque content sheet, toolbar glass, control fill (search, summary, chips), hover and
  // selected fills, and the attention orange (unread dot, Needs you, deadlines) with its text ink.
  content: 'var(--hw-content, #FFFFFF)',
  bar: 'var(--hw-bar, rgba(255,255,255,0.78))',
  field: 'var(--hw-field, rgba(0,0,0,0.045))',
  hover: 'var(--hw-hover, rgba(0,0,0,0.04))',
  select: 'var(--hw-select, rgba(0,0,0,0.07))',
  attention: 'var(--hw-attention, #E0561A)',
  attentionInk: 'var(--hw-attention-ink, #A8420F)',
  // Type. serif and why resolve to the body face (kept so old call sites do not break); mono is
  // for tracking numbers, one-time codes and code only; numbers use sans + tabular-nums (Mono).
  sans: `var(--hw-font-body, ${SYSTEM})`,
  serif: `var(--hw-font-display, ${SYSTEM})`,
  why: `var(--hw-font-why, ${SYSTEM})`,
  mono: 'var(--hw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  code: 'var(--hw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
};

// ── Phone context: MobileShell provides it; views read it to draw the phone layout ────────
export const PhoneContext = createContext(null);

export function usePhone() {
  const ctx = useContext(PhoneContext);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    if (ctx) return undefined;
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ctx]);
  return ctx || (narrow ? { phone: true, depth: 0 } : null);
}

// ── Surfaces ───────────────────────────────────────────────────────────────
/**
 * A sheet. `material`: 'content' (opaque, the default: lists, the reader, pages), 'glass' (the
 * rail: translucent with backdrop blur) or 'bar' (thin toolbar glass the content scrolls under;
 * the phone's top and bottom bars). Radius 14 by default; phone bars pass 0.
 */
export const Sheet = forwardRef(function Sheet({ as: As = 'div', radius = 14, phone = false, material = 'content', className = '', style, children, ...rest }, ref) {
  return (
    <As
      ref={ref}
      data-material={material}
      {...rest}
      className={`hw-sheet${phone ? ' hw-sheet-phone' : ''}${className ? ` ${className}` : ''}`}
      style={{ position: 'relative', boxSizing: 'border-box', borderRadius: radius, color: V.ink, ...style }}
    >
      {children}
    </As>
  );
});

/** The one cool light field the ground carries, top left (spec §e). */
export function LightFields({ phone = false }) {
  return (
    <div aria-hidden="true" className="hw-glow" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      <div style={{
        position: 'absolute', borderRadius: '50%', pointerEvents: 'none',
        width: phone ? 420 : 820, height: phone ? 320 : 600, left: phone ? -160 : -200, top: phone ? -140 : -220,
        background: 'var(--hw-glow, #9DB4D6)', opacity: 'var(--hw-glow-opacity, 0.18)', filter: `blur(${phone ? 80 : 120}px)`,
      }} />
    </div>
  );
}

/** A hairline. `inset` indents it to the row padding (12px on desktop rows). */
export function Hair({ inset = 0, strong = false, style }) {
  return <div role="presentation" style={{ height: 1, flexShrink: 0, background: strong ? V.line2 : V.line, margin: inset ? `0 ${inset}px` : 0, ...style }} />;
}

// ── People ─────────────────────────────────────────────────────────────────
function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Up to two initials from a display name, or the address's first letter. */
export function initialsOf(name, email) {
  const clean = String(name || '').replace(/["'<>()[\]]/g, ' ').trim();
  const words = clean.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w) && !w.includes('@'));
  if (words.length >= 2) return (Array.from(words[0])[0] + Array.from(words[words.length - 1])[0]).toUpperCase();
  if (words.length === 1) return Array.from(words[0]).slice(0, 1).join('').toUpperCase();
  const local = String(email || clean || '').split('@')[0].replace(/[^\p{L}\p{N}]/gu, '');
  return (Array.from(local)[0] || '?').toUpperCase();
}

/** The avatar fill for an address (or name): one of eight muted hues, stable per sender. */
export function avatarHue(email, name) {
  const key = String(email || name || '').trim().toLowerCase();
  return AVATAR_HUES[hashOf(key) % AVATAR_HUES.length];
}

/**
 * A contact circle: initials 13px/600 white on a hue hashed from the address, or `src` (a cached
 * BIMI or Gravatar image) when given and it loads. `dashed` is the Screener's look: a 1px dashed
 * outline and muted initials instead of the fill. Decorative: the name beside it is the label.
 */
export function Avatar({ name, email, size = 36, dashed = false, src, style }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const showImg = Boolean(src) && failedSrc !== src;
  const fontSize = Math.max(9, Math.round(size * 0.36));
  return (
    <span
      aria-hidden="true"
      data-avatar=""
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box', overflow: 'hidden',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: dashed || showImg ? 'transparent' : avatarHue(email, name),
        border: dashed ? `1px dashed ${V.muted}` : 0,
        color: dashed ? V.muted : '#FFFFFF', fontFamily: V.sans, fontSize, fontWeight: 600,
        lineHeight: 1, letterSpacing: '0.01em', userSelect: 'none', ...style,
      }}
    >
      {showImg
        ? <img src={src} alt="" width={size} height={size} onError={() => setFailedSrc(src)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : initialsOf(name, email)}
    </span>
  );
}

// ── Reasons ────────────────────────────────────────────────────────────────
const REASON_GLYPHS = { info: 'info', sparkles: 'sparkles', alert: 'circle-alert' };

function reasonColor(tone) {
  if (tone === 'attention') return V.attentionInk;
  if (tone === 'accent') return V.accentInk;
  if (tone === 'ink') return V.ink;
  return V.muted;
}

/**
 * A reason Hedwig gives: 12px sans text behind a 12px glyph (`sparkles` for AI-written, `info`
 * for a rule, `alert` for Needs you; any icon name works, null for none). With `onOpen` it is a
 * door: a real button that opens the why popover (layer, signals, and "Change this").
 */
export function Reason({ glyph = 'info', tone = 'muted', size = 12, onOpen, label, children, style, hit = false, as: As = 'span' }) {
  const color = reasonColor(tone);
  const s = { fontFamily: V.sans, fontStyle: 'normal', fontWeight: 400, fontSize: size, lineHeight: 1.35, color, ...style };
  const icon = glyph ? REASON_GLYPHS[glyph] || glyph : null;
  const mark = icon
    ? <Icon name={icon} size={size} strokeWidth={1.75} style={{ display: 'inline-block', verticalAlign: '-0.15em', marginRight: 4 }} />
    : null;
  if (onOpen) {
    return (
      <button
        type="button"
        className={`hw-why-door${hit ? ' hw-hit' : ''}`}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}
        style={{ ...s, padding: 0, border: 0, background: 'none', textAlign: 'left', display: 'inline', cursor: 'pointer' }}
      >
        {mark}{children}
      </button>
    );
  }
  return <As style={s}>{mark}{children}</As>;
}

/**
 * The old name for a reason. Same as Reason (no italic, no serif) but without a glyph unless one
 * is asked for, and capped at 13px so call sites written for the 16px serif stay in scale.
 */
export function Why({ glyph = null, size, ...rest }) {
  return <Reason glyph={glyph} size={size ? Math.min(size, 13) : 12} {...rest} />;
}

/** A section header: 11px/600 muted, sentence case (spec §a, §b). */
export function SectionLabel({ children, as: As = 'div', style, ...rest }) {
  return (
    <As {...rest} style={{ fontFamily: V.sans, fontSize: 11, lineHeight: '14px', fontWeight: 600, color: V.muted, padding: '14px 8px 4px', margin: 0, ...style }}>
      {children}
    </As>
  );
}

/** A figure with a caption: ledger strip cells, the deadline slip, the Brief. 600, tabular, ≤22px. */
export function Figure({ value, caption, sub, accent = false, size = 20, style, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, ...style }}>
      <span style={{ fontFamily: V.sans, fontWeight: 600, fontSize: Math.min(size, 22), lineHeight: 1.15, color: accent ? V.attentionInk : V.ink, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      {(caption || sub) && (
        <span style={{ fontSize: 12, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {caption}
          {sub && <><br /><span style={{ color: V.muted }}>{sub}</span></>}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * A boxed object: the deadline slip, the day's question, a rescue row, cards. The summary box style
 * (radius 10, --field fill, hairline); `tone="accent"` keeps the old accent tint.
 */
export function Slip({ as: As = 'div', children, style, radius = 10, tone = 'field', ...rest }) {
  const tinted = tone === 'accent';
  return (
    <As {...rest} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 14px', borderRadius: radius, background: tinted ? V.accentTint : V.field, border: tinted ? 0 : `1px solid ${V.line}`, color: V.ink, boxSizing: 'border-box', ...style }}>
      {children}
    </As>
  );
}

/**
 * Text tabs with counts. `stacked` is the phone tab bar (label over count, aria-current);
 * `underline` is the header's segmented control (a real tablist).
 */
export function TextTabs({ items, value, onChange, variant = 'underline', label, style }) {
  if (variant === 'stacked') {
    return (
      <nav aria-label={label} style={{ display: 'flex', ...style }}>
        {items.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={on ? 'page' : undefined}
              aria-label={t.count != null && t.count !== '' ? `${t.label}, ${t.count}` : t.label}
              onClick={() => onChange(t.id)}
              style={{
                flex: '1 1 0', minWidth: 0, height: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 0, background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 600 : 500,
                color: on ? V.ink : V.muted,
              }}
            >
              <span style={{ whiteSpace: 'nowrap' }}>{t.label}</span>
              {on && t.dotWhenActive
                ? <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: V.attention }} />
                : <span aria-hidden="true" style={{ fontSize: 11, lineHeight: '13px', minHeight: 13, fontVariantNumeric: 'tabular-nums', color: t.countAccent ? V.attentionInk : 'inherit' }}>{t.count ?? ''}</span>}
            </button>
          );
        })}
      </nav>
    );
  }
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', ...style }}>
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              const i = items.findIndex((x) => x.id === t.id);
              if (e.key === 'ArrowRight') { e.preventDefault(); onChange(items[(i + 1) % items.length].id); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(items[(i - 1 + items.length) % items.length].id); }
            }}
            style={{
              flex: '1 1 0', height: 44, border: 0, borderBottom: `2px solid ${on ? V.accent : 'transparent'}`, background: 'none',
              fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 600 : 500, color: on ? V.ink : V.muted, cursor: 'pointer', padding: '0 6px',
            }}
          >
            {t.label}{t.count != null && t.count !== '' ? <span style={{ fontSize: 12, fontWeight: 500, color: V.muted, marginLeft: 6, fontVariantNumeric: 'tabular-nums' }}>{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── Controls ───────────────────────────────────────────────────────────────
/** A text button: 28px (md), radius 8. `accent` is the primary (blue fill); `solid` is ink. Phone: 44px targets. */
export function Btn({ solid = false, accent = false, size = 'md', children, style, type = 'button', ...rest }) {
  const h = size === 'lg' ? 44 : size === 'phone' ? 44 : 28;
  return (
    <button
      type={type}
      className={solid || accent ? 'hw-btn-solid' : 'hw-btn'}
      {...rest}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: h, padding: size === 'md' ? '0 10px' : '0 16px',
        borderRadius: 8, border: `1px solid ${solid || accent ? 'transparent' : V.line2}`,
        background: accent ? V.accent : solid ? V.ink : 'transparent', color: accent ? V.onAccent : solid ? V.paper : V.ink,
        fontFamily: 'inherit', fontSize: size === 'phone' ? 15 : 13, fontWeight: accent ? 600 : 500, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * The text action ("Review or undo", "Nudge", "Change"). `hit` widens the touch target to 44×44
 * without changing how it looks (phone). `muted` is the quiet grey variant; otherwise ink.
 */
export function LinkBtn({ children, muted = false, hit = false, style, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={`hw-link${hit ? ' hw-hit' : ''}`}
      {...rest}
      style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', fontFamily: V.sans, fontStyle: 'normal', fontSize: 13, fontWeight: 500, color: muted ? V.muted : V.ink, whiteSpace: 'nowrap', ...style }}
    >
      {children}
    </button>
  );
}

/** A 44×44 icon button (phone targets). Children are the glyph. */
export function IconBtn({ label, children, solid = false, accent = false, style, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={solid || accent ? 'hw-btn-solid' : 'hw-btn-quiet'}
      {...rest}
      style={{
        width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 0, padding: 0,
        background: accent ? V.accent : solid ? V.ink : 'transparent', color: accent ? V.onAccent : solid ? V.paper : V.ink, cursor: 'pointer', flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * A toolbar / rail icon button (spec §a, §c): 28×28, radius 6, a 16px Icon, the tooltip and
 * accessible name "label (kbd)". `primary` is the accent fill with a white glyph; `active` is a
 * toggle (aria-pressed; selected fill, glyph in the accent); `showLabel` adds a 13px/500 label
 * after the glyph (the reader's Done).
 */
export const IconButton = forwardRef(function IconButton({ icon, label, kbd, onClick, active, primary = false, disabled = false, size = 28, showLabel = false, style, children, ...rest }, ref) {
  const name = kbd ? `${label} (${kbd})` : label;
  const glyph = Math.round(size * 16 / 28);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={typeof active === 'boolean' ? active : undefined}
      data-primary={primary ? '' : undefined}
      disabled={disabled}
      onClick={onClick}
      className="hw-icon-btn"
      {...rest}
      style={{
        height: size, minWidth: size, width: showLabel ? 'auto' : size, boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: showLabel ? '0 10px 0 8px' : 0, border: 0, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
        background: primary ? V.accent : 'transparent', color: primary ? V.onAccent : V.ink,
        fontFamily: V.sans, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <Icon name={icon} size={glyph} />
      {showLabel && <span>{label}</span>}
      {children}
    </button>
  );
});

/**
 * The screener's stream picker: equal-width choices, the chosen one solid ink. A radio group:
 * one Tab stop (the chosen option), arrow keys move the choice, Home / End jump to the ends.
 */
export function Pick({ options, value, onChange, label, size = 40 }) {
  const current = options.some((o) => o.id === value) ? value : options[0]?.id;
  const onKeyDown = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const i = options.findIndex((o) => o.id === current);
    let j = null;
    if (keys[e.key]) j = (i + keys[e.key] + options.length) % options.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = options.length - 1;
    if (j === null) return;
    e.preventDefault();
    onChange(options[j].id);
    const buttons = e.currentTarget.querySelectorAll('[role="radio"]');
    buttons[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => {
        const on = o.id === current;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={on ? undefined : 'hw-btn'}
            style={{
              flex: '1 1 0', minWidth: 0, height: size, borderRadius: 8, border: '1px solid transparent', padding: '0 6px',
              background: on ? V.accent : 'transparent', color: on ? V.onAccent : V.muted, fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 600 : 500, cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A dot: the unread dot is 8px in the attention orange (spec §b). */
export function Dot({ color = V.attention, size = 8, style }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block', ...style }} />;
}

/**
 * Times, counts, dates and ordinals: the body face with tabular figures (the name is historical;
 * figures are no longer mono). `Num` is the same thing under an honest name.
 */
export function Mono({ children, size = 11, color = V.muted, style, title }) {
  return <span title={title} style={{ fontFamily: V.sans, fontVariantNumeric: 'tabular-nums', fontSize: size, color, whiteSpace: 'nowrap', ...style }}>{children}</span>;
}
export const Num = Mono;

/** Real monospace, for tracking numbers, one-time codes and code only. */
export function Code({ children, size = 12, color = V.ink, style, title }) {
  return <span title={title} style={{ fontFamily: V.code, fontSize: size, color, ...style }}>{children}</span>;
}

const GLYPHS = {
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-3.5-3.5',
  back: 'M15 5l-7 7 7 7',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M18 6 6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  send: 'M12 19V5M5 12l7-7 7 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  compose: 'M4 20h4L19 9l-4-4L4 16z',
};

export function Glyph({ name, size = 22, stroke = 1.6 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d={GLYPHS[name]} />
    </svg>
  );
}

// ── View scaffolding ───────────────────────────────────────────────────────
/**
 * A view's header. On desktop it sits at the top of the pane's sheet: title 17px/600, the count or
 * subtitle 12px muted on the same baseline. On a phone it is the top bar: full width, `bar`
 * material with a hairline under it, a 28px/700 large title (spec §g), no rounded corners.
 */
export function ViewHead({ title, sub, actions, children, phone, before, compact = false }) {
  // A view pushed onto a phone tab's stack gets a way back in its own header.
  const nav = useContext(PhoneContext);
  const back = phone && nav?.depth > 0 && nav.back ? nav.back : null;
  const titleEl = compact
    ? null
    : (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        {back && <IconBtn label={tv('hedwig.v2.thread.back', 'Back')} onClick={back} style={{ alignSelf: 'center', marginLeft: -12 }}><Glyph name="back" /></IconBtn>}
        <h1 style={{ margin: 0, fontFamily: V.sans, fontWeight: phone ? 700 : 600, fontSize: phone ? (back ? 22 : 28) : 17, lineHeight: phone ? 1.15 : '22px', letterSpacing: phone ? '-0.02em' : '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{title}</h1>
        {sub && <span style={{ fontSize: 12, color: V.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{sub}</span>}
        <span style={{ flexGrow: 1 }} />
        {actions}
      </div>
    );
  if (phone) {
    return (
      <Sheet
        as="header"
        phone
        material="bar"
        radius={0}
        style={{
          position: 'sticky', top: 0, zIndex: 3, flexShrink: 0, borderBottom: `0.5px solid ${V.line2}`,
          padding: `calc(var(--sat, env(safe-area-inset-top, 0px)) + ${compact ? 6 : 10}px) 16px ${children ? 8 : 10}px`,
          display: 'flex', flexDirection: 'column', gap: 8, margin: 0,
        }}
      >
        {before}
        {titleEl}
        {children}
      </Sheet>
    );
  }
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px 10px', flexShrink: 0 }}>
      {before}
      {titleEl}
      {children}
    </header>
  );
}

/** The scrolling body of a v2 view; `phone` is full-bleed and leaves room for the bottom bar. */
export function ViewBody({ children, phone, label, style, padded = true }) {
  return (
    <section
      aria-label={label}
      className="hw-v2 hw-scroll"
      style={{
        flex: 1, minHeight: 0, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden',
        color: V.ink, fontFamily: V.sans, fontSize: 13, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums',
        padding: phone ? `0 ${padded ? 16 : 0}px calc(var(--hw-tabbar-space, 96px))` : (padded ? '14px 12px 16px' : 0),
        background: phone ? V.content : undefined,
        position: 'relative', ...style,
      }}
    >
      {children}
    </section>
  );
}

export function Quiet({ children, style }) {
  return <div role="status" style={{ padding: '16px 12px', color: V.muted, fontSize: 13, ...style }}>{children}</div>;
}

export function ErrorLine({ error, onRetry, retryLabel }) {
  if (!error) return null;
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 12px', color: V.red, fontSize: 13, flexWrap: 'wrap' }}>
      <span>{error.message || String(error)}</span>
      {onRetry && <LinkBtn onClick={onRetry} style={{ color: V.red }}>{retryLabel}</LinkBtn>}
    </div>
  );
}
