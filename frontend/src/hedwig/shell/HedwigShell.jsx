// The Hedwig desktop and tablet shell: the paper ground with its two light fields, the pane tree
// drawn as glass sheets, the overlay sheet for views opened on request, and pop-out windows. The
// top bar only appears for layouts without the rail (which carries the wordmark, search and
// settings itself). MailApp renders it in place of its classic desktop layout when
// useHedwig.shellMode is 'hedwig'; everything else MailApp mounts (compose, admin, palette,
// toasts, windows) is unchanged.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { applyLayout } from '../../layouts.js';
import { getView } from '../registry.js';
import { Icon } from '../icons.jsx';
import { ensureHedwigStyles, ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { deviceClass } from './layouts.js';
import { getTemplate } from './templates.js';
import { PaneNode } from './PaneTree.jsx';
import { ViewHost } from './ViewHost.jsx';
import TopBar from './TopBar.jsx';
import { useKeymap } from './useKeymap.js';
import { useRegistryVersion } from './useRegistry.js';
import { useViewRequests } from './useViewRequests.js';
import * as M from './model.js';
import { LightFields } from '../v2/primitives.jsx';
import { tr } from './tr.js';

const FloatingWindow = lazy(() => import('../../components/FloatingWindow.jsx'));

const DENSITY = {
  compact: { py: 7, px: 12 },
  comfortable: { py: 11, px: 14 },
  spacious: { py: 16, px: 16 },
};

function restoreUpstreamLayout() {
  const savedListWidth = Number(localStorage.getItem('mailflow_list_width')) || undefined;
  applyLayout(useStore.getState().layout, savedListWidth);
}

// Row padding from the layout's density; without one, upstream's preset decides as before.
function useDensity(density) {
  const upstreamLayout = useStore((s) => s.layout);
  useEffect(() => {
    const d = DENSITY[density];
    if (!d) { restoreUpstreamLayout(); return undefined; }
    const root = document.documentElement;
    root.style.setProperty('--layout-row-py', `${d.py}px`);
    root.style.setProperty('--layout-row-px', `${d.px}px`);
    return restoreUpstreamLayout;
  }, [density, upstreamLayout]);
}

function useDevice() {
  const [device, setDevice] = useState(() => (deviceClass(window.innerWidth) === 'desktop' ? 'desktop' : 'tablet'));
  useEffect(() => {
    const onResize = () => setDevice(deviceClass(window.innerWidth) === 'desktop' ? 'desktop' : 'tablet');
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return device;
}

// Upstream's contacts toggle (Sidebar, MessageList) opens contacts as a view.
function useContactsBridge() {
  const showContacts = useStore((s) => s.showContacts);
  useEffect(() => {
    const shell = useShell.getState();
    if (showContacts) shell.handleViewRequest({ id: 'core.contacts', props: {}, nonce: `contacts-${Date.now()}` });
    else if (shell.overlay?.id === 'core.contacts') useShell.setState({ overlay: null });
  }, [showContacts]);
}

// Picking a preset in MessageList's own layout menu switches the pane layout to match while an
// upstream preset is on screen; a Hedwig layout keeps its panes and just takes the row density.
function useUpstreamLayoutBridge() {
  const layout = useStore((s) => s.layout);
  const last = useRef(layout);
  useEffect(() => {
    if (last.current === layout) return;
    last.current = layout;
    const { templateId, applyTemplate } = useShell.getState();
    if (getTemplate(templateId)?.upstreamLayout && templateId !== layout && getTemplate(layout)) applyTemplate(layout);
  }, [layout]);
}

function OverlayDrawer() {
  useRegistryVersion();
  const overlay = useShell((s) => s.overlay);
  const panelRef = useRef(null);
  const returnFocus = useRef(null);

  useEffect(() => {
    if (!overlay) return undefined;
    returnFocus.current = document.activeElement;
    const el = panelRef.current;
    requestAnimationFrame(() => { if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true }); });
    return () => {
      const back = returnFocus.current;
      if (back && document.contains(back)) back.focus?.({ preventScroll: true });
    };
  }, [overlay?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the drawer when focus is in it or nowhere in particular (a view that
  // disables its input while working drops focus to the body).
  const open = Boolean(overlay);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const st = useStore.getState();
      if (st.composing || st.showAdmin || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const active = document.activeElement;
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
      e.preventDefault();
      useShell.getState().closeOverlay();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!overlay) return null;
  const view = getView(overlay.id);
  const title = view?.title || overlay.id;
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label={title}
      className="hw-sheet"
      style={{
        position: 'absolute', top: 'var(--hw-shell-pad, 24px)', right: 'var(--hw-shell-pad, 24px)', bottom: 'var(--hw-shell-pad, 24px)', zIndex: 40,
        width: 'clamp(360px, 42%, 680px)', maxWidth: 'calc(100% - 2 * var(--hw-shell-pad, 24px))', borderRadius: 26, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', outline: 'none', boxShadow: '0 40px 90px -30px var(--hw-shadow-color)',
        // Floats over other sheets, so its glass is nearly opaque.
        '--hw-glass': 'color-mix(in srgb, var(--hw-paper) 95%, transparent)',
        animation: 'hw-drawer-in var(--motion-normal, 180ms) var(--ease-emphasized, ease) both',
      }}
    >
      <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 22px', borderBottom: '1px solid var(--hw-line)' }}>
        <span style={{ fontFamily: 'var(--hw-font-display)', fontSize: 20, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <button type="button" className="hw-btn-quiet" aria-label={tr('overlay.dockNamed', 'Add {{title}} to the layout', { title })} title={tr('overlay.dock', 'Add to the layout')} onClick={() => useShell.getState().dockOverlay()} style={{ ...ui.quietIconButton, width: 28, height: 28 }}>
          <Icon name="dock" size={15} />
        </button>
        <button type="button" className="hw-btn-quiet" aria-label={tr('overlay.close', 'Close {{title}}', { title })} title={tr('overlay.closeHint', 'Close (Esc)')} onClick={() => useShell.getState().closeOverlay()} style={{ ...ui.quietIconButton, width: 28, height: 28 }}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <ViewHost
        key={overlay.key}
        paneKey={overlay.key}
        viewId={overlay.id}
        props={overlay.props}
        onChangeView={(id) => useShell.setState({ overlay: { ...overlay, id, props: {} } })}
      />
    </aside>
  );
}

function Popouts() {
  useRegistryVersion();
  const popouts = useShell((s) => s.popouts);
  if (!popouts.length) return null;
  const order = [...popouts].sort((a, b) => a.z - b.z).map((p) => p.key);
  return (
    <Suspense fallback={null}>
      {popouts.map((p) => {
        const title = getView(p.id)?.title || p.id;
        return (
          <FloatingWindow
            key={p.key}
            rect={p.rect}
            zIndex={1300 + order.indexOf(p.key)}
            title={title}
            accentColor="var(--hw-accent)"
            onFocus={() => useShell.getState().raisePopout(p.key)}
            onCommitRect={(rect) => useShell.getState().movePopout(p.key, rect)}
            onMinimize={() => useShell.getState().dockPopout(p.key)}
            onClose={() => useShell.getState().closePopout(p.key)}
            minimizeLabel={tr('popout.dock', 'Dock into the layout')}
            closeLabel={tr('overlay.close', 'Close {{title}}', { title })}
          >
            <ViewHost paneKey={p.key} viewId={p.id} props={p.props} onChangeView={(id) => useShell.setState((s) => ({ popouts: s.popouts.map((x) => (x.key === p.key ? { ...x, id, props: {} } : x)) }))} />
          </FloatingWindow>
        );
      })}
    </Suspense>
  );
}

export default function HedwigShell({ onOpenPalette }) {
  const device = useDevice();
  const tree = useShell((s) => s.tree);
  const ready = useShell((s) => s.ready);
  const userId = useStore((s) => s.user?.id);

  useEffect(() => { ensureHedwigStyles(); }, []);
  useEffect(() => {
    const shell = useShell.getState();
    const flush = shell.saveState === 'pending' ? shell.flushSave() : Promise.resolve();
    flush.finally(() => useShell.getState().init(device));
  }, [device, userId]);
  useEffect(() => () => {
    if (useShell.getState().saveState === 'pending') useShell.getState().flushSave();
  }, []);

  // Views (the rail's ⌘K, a phone header's search) open the palette through the shell.
  const paletteRef = useRef(onOpenPalette);
  paletteRef.current = onOpenPalette;
  useEffect(() => {
    useShell.setState({ openPalette: () => paletteRef.current?.() });
    return () => useShell.setState({ openPalette: null });
  }, []);
  useViewRequests();
  useContactsBridge();
  useUpstreamLayoutBridge();
  useDensity(tree?.density);
  useKeymap(true);

  const hasRail = Boolean(tree && M.panesHosting(tree, 'hedwig.rail').length);
  const pad = device === 'desktop' ? 24 : 16;
  const gap = device === 'desktop' ? 20 : 14;

  return (
    <div style={{
      flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden',
      background: 'var(--hw-paper)', color: 'var(--hw-ink)', fontFamily: 'var(--hw-font-body)',
      fontSize: 14, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums', WebkitFontSmoothing: 'antialiased',
      '--hw-shell-pad': `${pad}px`, '--hw-gap': `${gap}px`,
    }}>
      <LightFields />
      {!hasRail && <TopBar onOpenPalette={onOpenPalette} />}
      <main aria-label={tr('panes', 'Panes')} style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative', overflow: 'hidden', padding: hasRail ? pad : `${Math.round(pad / 2)}px ${pad}px ${pad}px`, zIndex: 1 }}>
        {ready && tree ? <PaneNode node={tree} /> : <div aria-busy="true" style={{ flex: 1 }} />}
        <OverlayDrawer />
      </main>
      <Popouts />
    </div>
  );
}
