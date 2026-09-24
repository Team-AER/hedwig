// Renders a pane tree: splits with resizable splitters, tab groups, and a PaneFrame per view.
// Each pane is a sheet (radius 14): the rail (hedwig.rail) is glass, every other pane opaque
// content (DESIGN-AUDIT-2026-09-24 §e), and the splitters are the 8px gaps between sheets. Splitter
// drags move the DOM directly and commit the size once on release, so a drag never re-renders
// the mail list sixty times a second. A view registered with `wide: true` (the Daily Brief)
// takes the room of any sibling registered with `hideBesideWide: true` (the thread) while it is
// on screen, as in the Brief mockup.
import { Fragment, memo, useMemo, useRef } from 'react';
import { getView } from '../registry.js';
import { useStore } from '../../store/index.js';
import { Icon } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import * as M from './model.js';
import { useShell } from './state.js';
import { useRegistryVersion } from './useRegistry.js';
import { ViewHost } from './ViewHost.jsx';
import { viewMenuItems } from './viewMenu.js';
import { MenuButton } from './Menu.jsx';
import { tr } from './tr.js';

const KEY_STEP = 16;
const SHEET_RADIUS = 14;

// Navigation is glass; everything that holds mail or a page is opaque content.
export function materialFor(viewId) {
  return viewId === 'hedwig.rail' ? 'glass' : 'content';
}

export function PaneNode({ node }) {
  if (!node) return null;
  if (node.type === 'split') return <SplitNode node={node} />;
  if (node.type === 'tabs') return <TabsNode node={node} />;
  return <PaneFrame node={node} />;
}

function titleOf(node) {
  if (!node) return '';
  if (node.type === 'view') return getView(node.id)?.title || node.id;
  if (node.type === 'tabs') return node.children.map(titleOf).join(', ');
  return node.children.map(titleOf).join(' and ');
}

const SplitNode = memo(function SplitNode({ node }) {
  const refs = useRef([]);
  const row = node.dir === 'row';
  // A view may ask for a narrower column than its pane (core.nav while upstream's sidebar is
  // collapsed). Re-render when that state flips.
  useStore((s) => s.sidebarCollapsed);
  const viewOf = (c) => (c.type === 'view' ? getView(c.id) : null);
  const wideOn = row && node.children.some((c) => viewOf(c)?.wide);
  const hidden = node.children.map((c) => wideOn && Boolean(viewOf(c)?.hideBesideWide));

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: node.dir, overflow: 'visible' }}>
      {node.children.map((child, i) => {
        const narrow = row && child.type === 'view' ? viewOf(child)?.paneWidth?.() : null;
        const wide = wideOn && viewOf(child)?.wide;
        const size = wide ? null : (narrow ?? node.sizes[i]);
        const prevVisible = hidden.slice(0, i).some((h) => !h);
        return (
          <Fragment key={child.key}>
            {i > 0 && !hidden[i] && prevVisible && <Splitter node={node} index={i - 1} refs={refs} row={row} />}
            <div
              ref={(el) => { refs.current[i] = el; }}
              style={{
                display: hidden[i] ? 'none' : 'flex', position: 'relative', minWidth: 0, minHeight: 0,
                flex: size == null ? '1 1 0' : `0 1 ${size}px`,
                ...(size == null ? (row ? { minWidth: M.MIN_PANE_PX } : { minHeight: M.MIN_PANE_PX / 1.5 }) : null),
              }}
            >
              <PaneNode node={child} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
});

// Which child a splitter between `index` and `index + 1` resizes: the fixed one next to it, or
// the one before it when both are flexible (it becomes fixed at its current size).
function resizeTarget(sizes, index) {
  if (sizes[index] != null) return { target: index, sign: 1 };
  if (sizes[index + 1] != null) return { target: index + 1, sign: -1 };
  return { target: index, sign: 1 };
}

function Splitter({ node, index, refs, row }) {
  const measure = () => refs.current.map((el) => (el ? (row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height) : 0));
  const { target } = resizeTarget(node.sizes, index);
  const labelA = titleOf(node.children[index]);
  const labelB = titleOf(node.children[index + 1]);

  const limits = (measured, t) => {
    const room = node.sizes.reduce((sum, s, j) => (j !== t && s == null ? sum + Math.max(0, measured[j] - M.MIN_PANE_PX) : sum), 0);
    return { min: M.MIN_PANE_PX, max: measured[t] + room };
  };

  const commit = (t, px) => useShell.getState().edit((tree) => M.resizeChild(tree, node.key, t, px));

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const measured = measure();
    const { target: t, sign } = resizeTarget(node.sizes, index);
    const { min, max } = limits(measured, t);
    const start = row ? e.clientX : e.clientY;
    const el = refs.current[t];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = 'true';
    document.body.style.cursor = row ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    let current = Math.round(measured[t]);
    const onMove = (mv) => {
      const delta = ((row ? mv.clientX : mv.clientY) - start) * sign;
      current = Math.round(Math.min(max, Math.max(min, measured[t] + delta)));
      if (el) el.style.flex = `0 1 ${current}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      delete handle.dataset.dragging;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (current !== Math.round(measured[t])) commit(t, current);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (e) => {
    const grow = row ? 'ArrowRight' : 'ArrowDown';
    const shrink = row ? 'ArrowLeft' : 'ArrowUp';
    if (e.key !== grow && e.key !== shrink && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.key === 'Enter') { resetBoth(); return; }
    const measured = measure();
    const { target: t, sign } = resizeTarget(node.sizes, index);
    const { min, max } = limits(measured, t);
    const step = (e.shiftKey ? KEY_STEP * 4 : KEY_STEP) * (e.key === grow ? 1 : -1) * sign;
    commit(t, Math.min(max, Math.max(min, measured[t] + step)));
  };

  const resetBoth = () => useShell.getState().edit((tree) => M.resetSize(M.resetSize(tree, node.key, index), node.key, index + 1));

  return (
    <div
      role="separator"
      tabIndex={0}
      className="hw-splitter"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={tr('splitter.label', 'Resize {{a}} and {{b}}', { a: labelA, b: labelB })}
      aria-valuenow={node.sizes[target] ?? undefined}
      aria-valuemin={M.MIN_PANE_PX}
      title={tr('splitter.hint', 'Drag to resize · double-click to reset')}
      onPointerDown={onPointerDown}
      onDoubleClick={resetBoth}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative', flex: '0 0 var(--hw-gap, 8px)', zIndex: 5, touchAction: 'none',
        cursor: row ? 'col-resize' : 'row-resize',
        [row ? 'width' : 'height']: 'var(--hw-gap, 8px)',
      }}
    >
      <span style={{
        position: 'absolute', borderRadius: 1, background: 'transparent',
        ...(row ? { top: '12%', bottom: '12%', left: 'calc(50% - 1px)', width: 2 } : { left: '12%', right: '12%', top: 'calc(50% - 1px)', height: 2 }),
      }} />
    </div>
  );
}

function TabsNode({ node }) {
  useRegistryVersion();
  const edit = useShell((s) => s.edit);
  const onKey = (e, i) => {
    const n = node.children.length;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    if (j == null) return;
    e.preventDefault();
    edit((t) => M.setActiveTab(t, node.key, j));
    requestAnimationFrame(() => document.getElementById(`hw-tab-${node.children[j].key}`)?.focus());
  };
  return (
    <div className="hw-sheet" data-material="content" style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: SHEET_RADIUS, overflow: 'hidden' }}>
      <div role="tablist" aria-label={tr('tabs.label', 'Pane tabs')} style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '0 10px', height: 36, flexShrink: 0, borderBottom: '1px solid var(--hw-line)', overflowX: 'auto' }}>
        {node.children.map((c, i) => {
          const active = i === node.active;
          const title = getView(c.id)?.title || c.id;
          return (
            <div key={c.key} style={{ display: 'flex', alignItems: 'center', borderBottom: active ? '2px solid var(--hw-accent)' : '2px solid transparent' }}>
              <button
                id={`hw-tab-${c.key}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`hw-tabpanel-${c.key}`}
                tabIndex={active ? 0 : -1}
                onClick={() => edit((t) => M.setActiveTab(t, node.key, i))}
                onKeyDown={(e) => onKey(e, i)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px 0 8px', height: '100%', border: 0, background: 'transparent', color: active ? 'var(--hw-ink)' : 'var(--hw-muted)', fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {title}
              </button>
              <button type="button" className="hw-btn-quiet" aria-label={tr('tabs.close', 'Close {{title}} tab', { title })} onClick={() => useShell.getState().closePane(c.key)} style={{ ...ui.quietIconButton, width: 20, height: 20 }}>
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        <MenuButton
          label={tr('tabs.add', 'Add a tab')}
          items={() => viewMenuItems(null, (id) => edit((t) => M.addTab(t, node.key, M.view(id))))}
          buttonClassName="hw-btn-quiet"
          buttonStyle={{ ...ui.quietIconButton, alignSelf: 'center', marginLeft: 2 }}
        >
          <Icon name="plus" size={14} />
        </MenuButton>
      </div>
      {node.children.map((c, i) => (
        <div key={c.key} id={`hw-tabpanel-${c.key}`} role="tabpanel" aria-labelledby={`hw-tab-${c.key}`} style={{ flex: 1, minHeight: 0, display: i === node.active ? 'flex' : 'none' }}>
          <PaneFrame node={c} inTabs />
        </div>
      ))}
    </div>
  );
}

export function PaneFrame({ node, inTabs = false }) {
  useRegistryVersion();
  const arrange = useShell((s) => s.arrange);
  const headersAlways = useShell((s) => Boolean(s.tree?.headers));
  const isFocused = useShell((s) => s.focused === node.key);
  const flash = useShell((s) => s.flash === node.key);
  const transient = useShell((s) => s.transient[node.key]);
  const view = getView(node.id);
  const title = view?.title || node.id;
  const showHeader = arrange || (headersAlways && !view?.chrome && !inTabs);
  const props = useMemo(() => (transient ? { ...(node.props || {}), ...transient } : node.props), [node.props, transient]);

  const onFocusCapture = () => {
    if (useShell.getState().focused !== node.key) useShell.setState({ focused: node.key });
  };

  return (
    <section
      data-pane-key={node.key}
      data-flash={flash ? 'true' : undefined}
      tabIndex={-1}
      aria-label={title}
      onFocusCapture={onFocusCapture}
      onPointerDownCapture={onFocusCapture}
      className={inTabs ? 'hw-pane' : 'hw-pane hw-sheet'}
      data-material={inTabs ? undefined : materialFor(node.id)}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', borderRadius: inTabs ? 0 : SHEET_RADIUS, overflow: 'hidden', background: inTabs ? 'transparent' : undefined }}
    >
      {showHeader && <PaneHeader node={node} view={view} title={title} focused={isFocused} />}
      <ViewHost
        paneKey={node.key}
        viewId={node.id}
        props={props}
        follows={node.follows}
        onChangeView={(id) => useShell.getState().replaceView(node.key, id)}
      />
    </section>
  );
}

function PaneHeader({ node, view, title, focused }) {
  const s = useShell.getState;
  const followsTitle = node.follows ? (getView(node.follows)?.title || node.follows) : null;
  const btn = (label, icon, onClick) => (
    <button type="button" className="hw-btn-quiet" aria-label={label} title={label} onClick={onClick} style={ui.quietIconButton}>
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div style={{
      height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px 0 10px',
      borderBottom: '1px solid var(--hw-line)',
      background: focused ? 'var(--hw-select)' : 'transparent', fontSize: 12, color: 'var(--hw-ink)',
    }}>
      <MenuButton
        label={tr('pane.changeView', '{{title}} — change view', { title })}
        items={() => viewMenuItems(node.id, (id) => s().replaceView(node.key, id))}
        buttonClassName="hw-btn-quiet"
        buttonStyle={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 6px', border: 0, borderRadius: 6, background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', minWidth: 0 }}
      >
        <Icon name={view?.icon || 'grid'} size={13} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <Icon name="chevron-down" size={12} />
      </MenuButton>
      {followsTitle && <span title={tr('pane.follows', 'Follows {{title}}', { title: followsTitle })} style={{ color: 'var(--hw-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{tr('pane.followsShort', 'follows {{title}}', { title: followsTitle })}</span>}
      <span style={{ flex: 1 }} />
      {btn(tr('pane.splitRight', 'Split right'), 'split-right', () => { s().focus(node.key); s().splitFocused('row'); })}
      <MenuButton
        label={tr('pane.more', 'More for {{title}}', { title })}
        align="right"
        width={220}
        buttonClassName="hw-btn-quiet"
        buttonStyle={ui.quietIconButton}
        items={() => [
          { id: 'down', label: tr('pane.splitDown', 'Split down'), icon: 'split-down', onSelect: () => { s().focus(node.key); s().splitFocused('column'); } },
          { id: 'tab', label: tr('pane.addTab', 'Add a tab here'), icon: 'tabs', onSelect: () => s().edit((t) => M.addTab(t, node.key, M.view('core.picker'))) },
          { id: 'earlier', label: tr('pane.earlier', 'Move earlier'), icon: 'chevron-left', onSelect: () => s().edit((t) => M.moveBy(t, node.key, -1)) },
          { id: 'later', label: tr('pane.later', 'Move later'), icon: 'chevron-right', onSelect: () => s().edit((t) => M.moveBy(t, node.key, 1)) },
          { id: 'pop', label: tr('pane.popout', 'Pop out to a window'), icon: 'popout', onSelect: () => s().popOut(node.key) },
        ]}
      >
        <Icon name="more" size={14} />
      </MenuButton>
      {btn(tr('pane.close', 'Close pane'), 'close', () => s().closePane(node.key))}
    </div>
  );
}
