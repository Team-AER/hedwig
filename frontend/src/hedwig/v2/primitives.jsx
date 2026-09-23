// v2 design primitives (docs/hedwig/design/*.dc.html). Glass sheets over the paper ground,
// hairlines instead of boxes, Instrument Serif for titles and for every reason Hedwig gives (in
// italic), DM Mono for times and counts, one accent. No pills, no uppercase eyebrows, no
// left-border cards, no avatars. Inline styles over --hw-* variables, as upstream does.
import { createContext, forwardRef, useContext, useEffect, useState } from 'react';

export const V = {
  paper: 'var(--hw-paper, #F4F2EC)',
  ink: 'var(--hw-ink, #17181A)',
  muted: 'var(--hw-muted, #66696D)',
  accent: 'var(--hw-accent, #E0561A)',
  accentInk: 'var(--hw-accent-ink, #9E3B0E)',
  // Icons and text on a solid accent fill: white on the light accent, the paper on the dark one.
  onAccent: 'var(--hw-on-accent, #FFFFFF)',
  // Small secondary text on an accent-tinted slip: muted grey fails contrast there, ink at 80% does not.
  inkSoft: 'color-mix(in srgb, var(--hw-ink, #17181A) 80%, transparent)',
  accentTint: 'var(--hw-accent-tint, rgba(224,86,26,0.12))',
  glass: 'var(--hw-glass, rgba(255,255,255,0.52))',
  edge: 'var(--hw-edge, rgba(255,255,255,0.72))',
  line: 'var(--hw-line, rgba(23,24,26,0.09))',
  line2: 'var(--hw-line2, rgba(23,24,26,0.18))',
  tint: 'var(--hw-tint, rgba(23,24,26,0.045))',
  red: 'var(--hw-red, #B3261E)',
  serif: "var(--hw-font-display, 'Instrument Serif', Georgia, serif)",
  why: "var(--hw-font-why, 'Instrument Serif', Georgia, serif)",
  sans: "var(--hw-font-body, 'Instrument Sans', system-ui, sans-serif)",
  mono: "var(--hw-font-mono, 'DM Mono', ui-monospace, monospace)",
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
/** A glass sheet: translucent fill, backdrop blur, 1px edge, the soft drop shadow. */
export const Sheet = forwardRef(function Sheet({ as: As = 'div', radius = 26, phone = false, className = '', style, children, ...rest }, ref) {
  return (
    <As
      ref={ref}
      {...rest}
      className={`hw-sheet${phone ? ' hw-sheet-phone' : ''}${className ? ` ${className}` : ''}`}
      style={{ position: 'relative', boxSizing: 'border-box', borderRadius: radius, color: V.ink, ...style }}
    >
      {children}
    </As>
  );
});

/** The two blurred light fields the ground carries: accent top-right, blue bottom-left. */
export function LightFields({ phone = false }) {
  const base = { position: 'absolute', borderRadius: '50%', pointerEvents: 'none' };
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      <div style={{ ...base, width: phone ? 420 : 760, height: phone ? 320 : 520, right: phone ? -160 : -140, top: phone ? -120 : -180, background: V.accent, opacity: 'var(--hw-field-a, 0.22)', filter: `blur(${phone ? 70 : 90}px)` }} />
      <div style={{ ...base, width: phone ? 420 : 640, height: phone ? 420 : 640, left: phone ? -180 : 120, bottom: phone ? -160 : -320, background: 'var(--hw-field-blue, #3B5A8A)', opacity: 'var(--hw-field-b, 0.16)', filter: `blur(${phone ? 80 : 110}px)` }} />
    </div>
  );
}

/** A hairline. `inset` indents it to the row padding (12px on desktop rows). */
export function Hair({ inset = 0, strong = false, style }) {
  return <div role="presentation" style={{ height: 1, flexShrink: 0, background: strong ? V.line2 : V.line, margin: inset ? `0 ${inset}px` : 0, ...style }} />;
}

/**
 * A reason Hedwig gives, in italic serif. With `onOpen` it is a door: a real button that opens
 * the why sheet (layer, signals, and "Change this").
 */
export function Why({ children, tone = 'muted', size = 16, onOpen, label, style, hit = false, as: As = 'span' }) {
  const color = tone === 'accent' ? V.accentInk : tone === 'ink' ? V.ink : V.muted;
  const s = { fontFamily: V.why, fontStyle: 'italic', fontWeight: 400, fontSize: size, lineHeight: 1.25, color, ...style };
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
        {children}
      </button>
    );
  }
  return <As style={s}>{children}</As>;
}

/** A big serif figure with a caption: the ledger strip cells, the deadline slip, the Brief. */
export function Figure({ value, caption, sub, accent = false, size = 36, style, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...style }}>
      <span style={{ fontFamily: V.serif, fontWeight: 400, fontSize: size, lineHeight: 1.05, color: accent ? V.accentInk : V.ink, letterSpacing: '-0.01em', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      {(caption || sub) && (
        <span style={{ fontSize: 13, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {caption}
          {sub && <><br /><span style={{ color: V.muted }}>{sub}</span></>}
        </span>
      )}
      {children}
    </div>
  );
}

/** An accent-tinted object: the deadline slip, the day's question, a rescue row. */
export function Slip({ as: As = 'div', children, style, radius = 16, ...rest }) {
  return (
    <As {...rest} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '16px 18px', borderRadius: radius, background: V.accentTint, color: V.ink, boxSizing: 'border-box', ...style }}>
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
                ? <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: V.accent }} />
                : <span aria-hidden="true" style={{ fontFamily: V.mono, fontSize: 11, lineHeight: '13px', minHeight: 13, color: t.countAccent ? V.accentInk : 'inherit' }}>{t.count ?? ''}</span>}
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
              flex: '1 1 0', height: 44, border: 0, borderBottom: `2px solid ${on ? V.ink : 'transparent'}`, background: 'none',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 500, color: on ? V.ink : V.muted, cursor: 'pointer', padding: '0 6px',
            }}
          >
            {t.label}{t.count != null && t.count !== '' ? <span style={{ fontFamily: V.mono, fontSize: 11, marginLeft: 6 }}>{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── Controls ───────────────────────────────────────────────────────────────
export function Btn({ solid = false, accent = false, size = 'md', children, style, type = 'button', ...rest }) {
  const h = size === 'lg' ? 44 : size === 'phone' ? 40 : 36;
  return (
    <button
      type={type}
      className={solid || accent ? 'hw-btn-solid' : 'hw-btn'}
      {...rest}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: h, padding: size === 'phone' ? '0 16px' : '0 14px',
        borderRadius: 9, border: `1px solid ${solid || accent ? 'transparent' : V.line2}`,
        background: accent ? V.accent : solid ? V.ink : 'transparent', color: accent ? V.onAccent : solid ? V.paper : V.ink,
        fontFamily: 'inherit', fontSize: size === 'phone' ? 14 : 13, fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * The underlined text action ("Review or undo", "Nudge", "Change"). `hit` widens the touch target
 * to 44×44 without changing how it looks (phone).
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

/** A 44×44 icon button (phone targets). */
export function IconBtn({ label, children, solid = false, accent = false, style, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={solid || accent ? 'hw-btn-solid' : 'hw-btn-quiet'}
      {...rest}
      style={{
        width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, border: 0, padding: 0,
        background: accent ? V.accent : solid ? V.ink : 'transparent', color: accent ? V.onAccent : solid ? V.paper : V.ink, cursor: 'pointer', flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

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
              flex: '1 1 0', minWidth: 0, height: size, borderRadius: 9, border: '1px solid transparent', padding: '0 6px',
              background: on ? V.ink : 'transparent', color: on ? V.paper : V.muted, fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Dot({ color = V.accent, size = 7, style }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block', ...style }} />;
}

export function Mono({ children, size = 11, color = V.muted, style }) {
  return <span style={{ fontFamily: V.mono, fontSize: size, color, whiteSpace: 'nowrap', ...style }}>{children}</span>;
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
 * A view's header. On desktop it sits at the top of the pane's sheet; on a phone it is its own
 * glass sheet pinned over the scrolling content (rounded at the bottom), as in the phone mockups.
 */
export function ViewHead({ title, sub, actions, children, phone, before, compact = false }) {
  const titleEl = compact
    ? null
    : (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: phone ? 10 : 12, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontFamily: V.serif, fontWeight: 400, fontSize: 40, lineHeight: 1, letterSpacing: '-0.015em', whiteSpace: 'nowrap' }}>{title}</h1>
        {sub && <span style={{ fontSize: 13, color: V.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
        <span style={{ flexGrow: 1 }} />
        {actions}
      </div>
    );
  if (phone) {
    return (
      <Sheet
        as="header"
        phone
        radius={0}
        style={{
          position: 'sticky', top: 0, zIndex: 3, flexShrink: 0, borderTop: 0, borderRadius: '0 0 28px 28px',
          padding: `calc(var(--sat, env(safe-area-inset-top, 0px)) + ${compact ? 10 : 18}px) ${compact ? 12 : 20}px ${children ? 0 : 18}px`,
          display: 'flex', flexDirection: 'column', gap: 10, margin: '0 0 8px',
        }}
      >
        {before}
        {titleEl}
        {children}
      </Sheet>
    );
  }
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 12px 18px', flexShrink: 0 }}>
      {before}
      {titleEl}
      {children}
    </header>
  );
}

/** The scrolling body of a v2 view; `phone` leaves room for the floating tab bar. */
export function ViewBody({ children, phone, label, style, padded = true }) {
  return (
    <section
      aria-label={label}
      className="hw-v2 hw-scroll"
      style={{
        flex: 1, minHeight: 0, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden',
        color: V.ink, fontFamily: V.sans, fontSize: 14, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums',
        padding: phone ? `0 ${padded ? 16 : 0}px calc(var(--hw-tabbar-space, 96px))` : (padded ? '26px 14px 16px' : 0),
        position: 'relative', ...style,
      }}
    >
      {children}
    </section>
  );
}

export function Quiet({ children, style }) {
  return <div role="status" style={{ padding: '18px 12px', color: V.muted, fontSize: 14, ...style }}>{children}</div>;
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
