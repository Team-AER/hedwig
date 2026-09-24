// Accessible dropdown menu for shell chrome: a real button that opens a role="menu" list,
// arrow keys move between items, Escape closes and returns focus to the button. Rendered in a
// portal with fixed positioning so a pane's overflow never clips it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.jsx';

export function MenuButton({
  label,               // accessible name for the trigger
  items,               // [{ id, label, icon?, hint?, checked?, disabled?, onSelect }] | { type: 'header'|'separator', label? }
  children,            // trigger contents
  align = 'left',
  width = 260,
  buttonStyle,
  buttonClassName = 'hw-btn',
  title,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const list = typeof items === 'function' ? (open ? items() : []) : items;

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    const maxHeight = Math.max(160, window.innerHeight - r.bottom - 16);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), maxHeight });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return undefined;
    const first = menuRef.current?.querySelector('[role^="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, pos, close]);

  const onMenuKey = (e) => {
    const nodes = [...(menuRef.current?.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])') || [])];
    const i = nodes.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); nodes[(i + 1) % nodes.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nodes[(i - 1 + nodes.length) % nodes.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); nodes[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

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
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="hw-sheet"
          data-material="content"
          data-popover=""
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width, maxHeight: pos.maxHeight,
            overflowY: 'auto', zIndex: 9000, padding: 5,
            color: 'var(--hw-ink)', borderRadius: 12, fontFamily: 'var(--hw-font-body)', fontSize: 13,
            animation: 'hw-pop-in var(--motion-fast, 120ms) var(--ease-standard, ease) both',
          }}
        >
          {list.map((item, i) => {
            if (item.type === 'separator') return <div key={`sep${i}`} role="separator" style={{ height: 1, margin: '6px 10px', background: 'var(--hw-line)' }} />;
            if (item.type === 'header') {
              return (
                <div key={`h${i}`} role="presentation" style={{ padding: '8px 8px 4px', fontFamily: 'var(--hw-font-body)', fontSize: 11, lineHeight: '14px', fontWeight: 600, color: 'var(--hw-muted)' }}>
                  {item.label}
                </div>
              );
            }
            const checkable = item.checked !== undefined;
            return (
              <button
                key={item.id || i}
                type="button"
                role={checkable ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkable ? Boolean(item.checked) : undefined}
                aria-disabled={item.disabled ? 'true' : undefined}
                className="hw-menu-item"
                tabIndex={-1}
                onClick={() => { if (item.disabled) return; close(); item.onSelect?.(); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', minHeight: 28,
                  border: 0, borderRadius: 6, background: 'transparent', color: 'inherit',
                  fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: item.disabled ? 'default' : 'pointer',
                }}
              >
                <span style={{ width: 16, display: 'inline-flex', color: 'var(--hw-muted)' }}>
                  {checkable ? (item.checked ? <Icon name="check" size={14} /> : null) : <Icon name={item.icon} size={14} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: item.checked ? 600 : 400 }}>
                  {item.label}
                </span>
                {item.hint && <span style={{ fontSize: 11, color: 'var(--hw-muted)' }}>{item.hint}</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
