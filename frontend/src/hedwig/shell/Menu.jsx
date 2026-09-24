// Accessible dropdown menu for shell chrome: a real button that opens a role="menu" list,
// arrow keys move between items, Escape closes and returns focus to the button. Rendered in a
// portal with fixed positioning so a pane's overflow never clips it. On a phone (or with
// `sheet`) the same items open as a bottom sheet with 44px rows, a heading and Done.
//
// Items:
//   { id, label, description?, icon?, hint?, checked?, radio?, disabled?, onSelect }
//       `checked` makes it a menuitemcheckbox, or a menuitemradio with `radio: true`;
//       `description` is a 12px muted line under the label.
//   { type: 'radio', id, label?, ariaLabel?, options: [{ id, label, checked, onSelect }] }
//       a segmented radio group (role="group" of menuitemradio); picking one keeps the menu open.
//   { type: 'header', label } · { type: 'separator' }
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.jsx';
import { tr } from './tr.js';

const PHONE_MAX = 768;
const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

function HeaderRow({ label, sheet }) {
  return (
    <div role="presentation" style={{
      padding: sheet ? '14px 12px 6px' : '10px 8px 4px', fontFamily: 'var(--hw-font-body)',
      fontSize: 11, lineHeight: '14px', fontWeight: 600, color: 'var(--hw-muted)',
    }}>
      {label}
    </div>
  );
}

function RadioRow({ item, sheet, onPick }) {
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const nodes = [...e.currentTarget.querySelectorAll('[role="menuitemradio"]')];
    const i = nodes.indexOf(document.activeElement);
    nodes[(i + (e.key === 'ArrowRight' ? 1 : -1) + nodes.length) % nodes.length]?.focus();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: sheet ? '4px 12px 8px' : '2px 8px 6px' }}>
      {item.label && <span id={`hw-menu-radio-${item.id}`} style={{ fontSize: 13, color: 'var(--hw-ink)', flexShrink: 0, minWidth: 0 }}>{item.label}</span>}
      <div
        role="group"
        aria-labelledby={item.label ? `hw-menu-radio-${item.id}` : undefined}
        aria-label={item.label ? undefined : (item.ariaLabel || item.id)}
        data-menu-radio={item.id}
        onKeyDown={onKeyDown}
        style={{ flex: 1, display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--hw-field, rgba(0,0,0,0.045))' }}
      >
        {item.options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="menuitemradio"
            aria-checked={Boolean(o.checked)}
            tabIndex={-1}
            className="hw-menu-seg"
            onClick={() => onPick(o)}
            style={{
              flex: '1 1 0', minWidth: 0, height: sheet ? 36 : 24, border: 0, borderRadius: 6, cursor: 'pointer',
              background: o.checked ? 'var(--hw-content, #fff)' : 'transparent',
              boxShadow: o.checked ? '0 0 0 .5px var(--hw-line2, rgba(0,0,0,.14)), 0 1px 2px rgba(0,0,0,.08)' : 'none',
              color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 12, fontWeight: o.checked ? 600 : 500,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item, sheet, onPick }) {
  const checkable = item.checked !== undefined;
  const role = checkable ? (item.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
  const described = Boolean(item.description);
  return (
    <button
      type="button"
      role={role}
      aria-checked={checkable ? Boolean(item.checked) : undefined}
      aria-disabled={item.disabled ? 'true' : undefined}
      aria-description={item.description || undefined}
      data-menu-item={item.id}
      className="hw-menu-item"
      tabIndex={-1}
      onClick={() => { if (!item.disabled) onPick(item); }}
      style={{
        width: '100%', display: 'flex', alignItems: described ? 'flex-start' : 'center', gap: 8,
        padding: described ? (sheet ? '10px 12px' : '6px 8px') : (sheet ? '0 12px' : '0 8px'),
        minHeight: sheet ? 44 : 28, boxSizing: 'border-box',
        border: 0, borderRadius: sheet ? 10 : 6, background: 'transparent', color: item.disabled ? 'var(--hw-muted)' : 'inherit',
        fontFamily: 'inherit', fontSize: sheet ? 15 : 13, textAlign: 'left', cursor: item.disabled ? 'default' : 'pointer',
      }}
    >
      <span aria-hidden="true" style={{ width: 16, height: described ? 18 : 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', color: checkable ? 'var(--hw-accent)' : 'var(--hw-muted)' }}>
        {checkable ? (item.checked ? <Icon name="check" size={14} /> : null) : <Icon name={item.icon} size={14} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: item.checked ? 600 : 400, lineHeight: '18px' }}>
          {item.label}
        </span>
        {described && (
          <span data-menu-description="" style={{ fontSize: 12, lineHeight: '16px', color: 'var(--hw-muted)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
            {item.description}
          </span>
        )}
      </span>
      {item.hint && <span style={{ fontSize: 11, color: 'var(--hw-muted)', flexShrink: 0, lineHeight: '18px' }}>{item.hint}</span>}
    </button>
  );
}

/**
 * Menu items as shown: an id seen before is shown once (a caller extending a shared list, like the
 * rail adding its own Appearance and Settings rows to the View menu, does not double them), and
 * separators never lead, trail or come twice in a row. Pure.
 */
export function tidyItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item) continue;
    if (item.type === 'separator') {
      if (out.length && out[out.length - 1].type !== 'separator') out.push(item);
      continue;
    }
    if (item.id && item.type !== 'header') {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

/** The rows of a menu (shared by the dropdown and the phone sheet). Exported for tests. */
export function MenuRows({ list, sheet = false, onPick }) {
  return list.map((item, i) => {
    if (item.type === 'separator') return <div key={`sep${i}`} role="separator" style={{ height: 1, margin: sheet ? '6px 12px' : '5px 8px', background: 'var(--hw-line)' }} />;
    if (item.type === 'header') return <HeaderRow key={`h${i}`} label={item.label} sheet={sheet} />;
    if (item.type === 'radio') return <RadioRow key={item.id || `r${i}`} item={item} sheet={sheet} onPick={(o) => onPick(o, { keepOpen: true })} />;
    return <ItemRow key={item.id || i} item={item} sheet={sheet} onPick={(it) => onPick(it, { keepOpen: Boolean(it.keepOpen) })} />;
  });
}

export function MenuButton({
  label,               // accessible name for the trigger
  items,               // see above; or a function returning them (called while open)
  children,            // trigger contents
  align = 'left',
  width = 260,
  buttonStyle,
  buttonClassName = 'hw-btn',
  title,
  heading,             // optional title at the top of the menu (always shown on the phone sheet)
  sheet = false,       // true: always a bottom sheet; 'auto': a sheet below 768px (the View menu); false: never
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [, bump] = useState(0);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const asSheet = sheet === true || (sheet === 'auto' && typeof window !== 'undefined' && window.innerWidth < PHONE_MAX);
  const list = tidyItems(typeof items === 'function' ? (open ? items() : []) : items);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    if (asSheet) { setPos({ sheet: true }); return; }
    const r = btnRef.current.getBoundingClientRect();
    const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    const maxHeight = Math.max(160, window.innerHeight - r.bottom - 16);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), maxHeight });
  }, [open, align, width, asSheet]);

  useEffect(() => {
    if (!open) return undefined;
    const first = menuRef.current?.querySelector(`${ITEM_SELECTOR}[aria-checked="true"]`) || menuRef.current?.querySelector(ITEM_SELECTOR);
    first?.focus();
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, pos, close]);

  const onMenuKey = (e) => {
    const nodes = [...(menuRef.current?.querySelectorAll(ITEM_SELECTOR) || [])];
    const i = nodes.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); nodes[(i + 1) % nodes.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nodes[(i - 1 + nodes.length) % nodes.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); nodes[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  // A pick closes the menu, except in a radio group (the appearance switch shows its effect at once).
  const onPick = (item, { keepOpen = false } = {}) => {
    if (keepOpen) { item.onSelect?.(); bump((n) => n + 1); return; }
    close();
    item.onSelect?.();
  };

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={heading || label}
      onKeyDown={onMenuKey}
      className="hw-sheet"
      data-material="content"
      data-popover=""
      data-menu-sheet={asSheet ? '' : undefined}
      style={asSheet
        ? {
          position: 'fixed', left: 0, right: 0, bottom: 0, maxHeight: '85vh', overflowY: 'auto', zIndex: 9001,
          padding: '0 8px calc(12px + env(safe-area-inset-bottom, 0px))', color: 'var(--hw-ink)', borderRadius: '14px 14px 0 0',
          fontFamily: 'var(--hw-font-body)', fontSize: 15,
          animation: 'hw-fade-in var(--motion-normal, 180ms) var(--ease-emphasized, ease) both',
        }
        : {
          position: 'fixed', top: pos?.top, left: pos?.left, width, maxHeight: pos?.maxHeight,
          overflowY: 'auto', zIndex: 9000, padding: 5,
          color: 'var(--hw-ink)', borderRadius: 12, fontFamily: 'var(--hw-font-body)', fontSize: 13,
          animation: 'hw-pop-in var(--motion-fast, 120ms) var(--ease-standard, ease) both',
        }}
    >
      {asSheet && (
        <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', height: 48, padding: '0 4px 0 12px', background: 'var(--hw-content, #fff)' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600 }}>{heading || label}</span>
          <button type="button" onClick={() => close()} style={{ minWidth: 44, height: 44, border: 0, background: 'transparent', color: 'var(--hw-accent)', fontFamily: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
            {tr('menu.done', 'Done')}
          </button>
        </div>
      )}
      {!asSheet && heading && <div role="presentation" style={{ padding: '6px 8px 2px', fontSize: 13, fontWeight: 600 }}>{heading}</div>}
      <MenuRows list={list} sheet={asSheet} onPick={onPick} />
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title || label}
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        style={buttonStyle}
      >
        {children}
      </button>
      {open && pos && createPortal(
        asSheet
          ? (
            <>
              <div aria-hidden="true" data-menu-backdrop="" style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.28)' }} />
              {menu}
            </>
          )
          : menu,
        document.body,
      )}
    </>
  );
}
