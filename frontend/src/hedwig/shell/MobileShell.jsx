// Phone chrome for the Hedwig shell (DESIGN-AUDIT-2026-09-24 §g): one column of full-bleed opaque
// content, a view stack per tab where each v2 view draws its own top bar, and the bottom tab bar.
// Glass only on the two bars (the `bar` material); no floating sheets and no big radii. Tabs are an
// icon plus a 10px label with counts as badges (orange for Needs you): Screener · People · Reading
// · Records · Brief.
// Upstream's mobile list → message → back flow stays as it is underneath: opening a message in
// upstream's reader (or the classic list, from the palette) shows it, and backing out returns to
// the stack.
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { getView } from '../registry.js';
import { Icon } from '../icons.jsx';
import { ensureHedwigStyles, ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { ViewHost } from './ViewHost.jsx';
import { useRegistryVersion } from './useRegistry.js';
import { useViewRequests } from './useViewRequests.js';
import { TAB_BAR_HEIGHT, useHedwigTabBar } from './tabBar.js';
import { tr } from './tr.js';
import { ViewMenuButton } from './TopBar.jsx';
import { useV2, countText } from '../v2/state.js';
import { PhoneContext, Sheet } from '../v2/primitives.jsx';
import { tv } from '../v2/i18n.js';

export const PHONE_TABS = ['screener', 'people', 'reading', 'records', 'brief'];

const ROOTS = {
  screener: 'hedwig.screener',
  people: 'hedwig.stream.people',
  reading: 'hedwig.stream.reading',
  records: 'hedwig.stream.records',
  brief: 'hedwig.brief',
};

export function rootFor(tab) {
  const id = ROOTS[tab];
  return id && getView(id) ? id : null;
}

function briefTime(fields) {
  const f = (fields || []).find((x) => x.key === 'insights.briefingTime');
  return (f && typeof f.value === 'string' && f.value) || '07:00';
}

const TAB_ICONS = { screener: 'door-open', people: 'users', reading: 'book-open', records: 'receipt', brief: 'newspaper' };

function TabBar({ current, onSelect }) {
  const counts = useV2((s) => s.counts);
  const more = useV2((s) => s.countsMore);
  const fields = useV2((s) => s.settingsFields);
  const items = useMemo(() => [
    { id: 'screener', label: tv('hedwig.v2.rail.screener', 'Screener'), count: countText(counts, more, 'screener') },
    { id: 'people', label: tv('hedwig.v2.stream.people', 'People'), count: countText(counts, more, 'people'), attention: true },
    { id: 'reading', label: tv('hedwig.v2.stream.reading', 'Reading'), count: countText(counts, more, 'reading') },
    { id: 'records', label: tv('hedwig.v2.stream.records', 'Records'), count: countText(counts, more, 'records') },
    // The Brief's "count" is its time of day: said in the label, not drawn as a badge.
    { id: 'brief', label: tv('hedwig.v2.tab.brief', 'Brief'), count: briefTime(fields), noBadge: true },
  ], [counts, more, fields]);
  return (
    <Sheet
      phone
      material="bar"
      radius={0}
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 850, borderTop: '0.5px solid var(--hw-line2)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)', fontFamily: 'var(--hw-font-body)',
      }}
    >
      <nav aria-label={tv('hedwig.v2.tab.label', 'Streams')} style={{ display: 'flex', height: TAB_BAR_HEIGHT }}>
        {items.map((t) => {
          const on = t.id === current;
          const has = t.count != null && t.count !== '';
          return (
            <button
              key={t.id}
              type="button"
              aria-current={on ? 'page' : undefined}
              aria-label={has ? `${t.label}, ${t.count}` : t.label}
              onClick={() => onSelect(t.id)}
              style={{
                flex: '1 1 0', minWidth: 44, minHeight: 44, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                border: 0, background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', position: 'relative',
                color: on ? 'var(--hw-accent)' : 'var(--hw-muted)',
              }}
            >
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <Icon name={TAB_ICONS[t.id]} size={24} strokeWidth={on ? 1.75 : 1.5} />
                {has && !t.noBadge && (
                  <span aria-hidden="true" style={{
                    position: 'absolute', top: -4, left: 16, minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box', borderRadius: 8,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums', color: 'var(--hw-content)', background: t.attention ? 'var(--hw-attention-ink)' : 'var(--hw-muted)',
                  }}>{t.count}</span>
                )}
              </span>
              <span style={{ fontSize: 10, lineHeight: '12px', fontWeight: on ? 600 : 500, whiteSpace: 'nowrap' }}>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </Sheet>
  );
}

// Views that are not v2 (the v1 Ask, upstream's list, settings) get a small header sheet with
// Back and the view's title; v2 views draw their own.
function PlainHeader({ title, depth, onBack, onOpenPalette }) {
  const headRef = useRef(null);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [title]);
  return (
    <Sheet as="header" phone material="bar" radius={0} style={{ borderBottom: '0.5px solid var(--hw-line2)', padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 4px) 4px 4px', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, zIndex: 3 }}>
      {depth > 0 && (
        <button type="button" className="hw-btn-quiet" aria-label={tr('mobile.back', 'Back')} onClick={onBack} style={{ ...ui.iconButton, width: 44, height: 44, borderRadius: 8, color: 'var(--hw-accent)' }}>
          <Icon name="chevron-left" size={24} />
        </button>
      )}
      <span ref={headRef} tabIndex={-1} style={{ ...ui.display, fontSize: 17, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', outline: 'none', paddingLeft: depth > 0 ? 0 : 12 }}>{title}</span>
      <button type="button" className="hw-btn-quiet" aria-label={tr('mobile.search', 'Search and commands')} onClick={onOpenPalette} style={{ ...ui.iconButton, width: 44, height: 44, borderRadius: 8 }}>
        <Icon name="search" size={20} />
      </button>
      {depth === 0 && <ViewMenuButton variant="phone" />}
    </Sheet>
  );
}

function StackScreen({ entry, depth, onBack, onOpenPalette }) {
  useRegistryVersion();
  const view = getView(entry.id);
  const title = view?.title || entry.id;
  const v2 = entry.id.startsWith('hedwig.stream.') || ['hedwig.screener', 'hedwig.thread', 'hedwig.brief', 'hedwig.today', 'hedwig.list', 'hedwig.ledger', 'hedwig.waiting', 'hedwig.drafts', 'hedwig.ask'].includes(entry.id);
  const nav = useMemo(() => ({ phone: true, depth, back: onBack, openPalette: onOpenPalette }), [depth, onBack, onOpenPalette]);
  return (
    <PhoneContext.Provider value={nav}>
      <section aria-label={title} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        {!v2 && <PlainHeader title={title} depth={depth} onBack={onBack} onOpenPalette={onOpenPalette} />}
        <ViewHost paneKey={entry.key} viewId={entry.id} props={entry.props} />
      </section>
    </PhoneContext.Provider>
  );
}

export default function HedwigMobile({ onOpenPalette }) {
  useRegistryVersion();
  const tab = useShell((s) => (PHONE_TABS.includes(s.mobileTab) ? s.mobileTab : 'people'));
  const stacks = useShell((s) => s.stacks);
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const selectedFolder = useStore((s) => s.selectedFolder);
  const selectedAccountId = useStore((s) => s.selectedAccountId);
  const drawerOpen = useStore((s) => s.mobileSidebarOpen);
  const { visible } = useHedwigTabBar(true);
  const paletteRef = useRef(onOpenPalette);
  paletteRef.current = onOpenPalette;

  useEffect(() => { ensureHedwigStyles(); }, []);
  useEffect(() => {
    useShell.setState({ openPalette: () => paletteRef.current?.() });
    return () => useShell.setState({ openPalette: null });
  }, []);
  useViewRequests({ phone: true });

  // Seed the current tab's stack with its root view the first time it is shown.
  const root = rootFor(tab);
  useEffect(() => {
    const s = useShell.getState();
    if (root && !(s.stacks[tab] || []).length) s.setStack(tab, [{ key: `root-${tab}`, id: root, props: {} }]);
  }, [tab, root]);

  // Choosing a folder in upstream's drawer means "show me that folder": push upstream's list.
  const drawerAt = useRef(0);
  useEffect(() => { if (drawerOpen) drawerAt.current = Date.now(); }, [drawerOpen]);
  const folderRef = useRef(`${selectedAccountId}|${selectedFolder}`);
  useEffect(() => {
    const now = `${selectedAccountId}|${selectedFolder}`;
    if (folderRef.current === now) return;
    folderRef.current = now;
    if (!drawerOpen && Date.now() - drawerAt.current > 1500) return;
    const s = useShell.getState();
    const stack = s.stacks[s.mobileTab] || [];
    if (stack[stack.length - 1]?.id !== 'core.list') s.pushView('core.list');
  }, [selectedAccountId, selectedFolder, drawerOpen]);

  const select = (id) => {
    const s = useShell.getState();
    const store = useStore.getState();
    if (store.selectedMessageId) store.setSelectedMessage(null);
    if (store.showContacts) store.setShowContacts(false);
    const r = rootFor(id);
    const stack = s.stacks[id] || [];
    if (s.mobileTab === id && stack.length > 1) s.setStack(id, stack.slice(0, 1));
    else if (!stack.length && r) s.setStack(id, [{ key: `root-${id}`, id: r, props: {} }]);
    s.setMobileTab(id);
  };

  const onBack = useMemo(() => () => useShell.getState().popView(), []);
  const openPalette = useMemo(() => () => paletteRef.current?.(), []);

  const stack = stacks[tab] || [];
  const top = stack[stack.length - 1];
  const topView = top ? getView(top.id) : null;
  // Upstream owns the screen while a message is open in its reading pane.
  const showStack = Boolean(top) && !selectedMessageId;
  const showBar = visible && !(showStack && topView?.hideTabBar);
  const barSpace = `calc(${TAB_BAR_HEIGHT}px + 12px + env(safe-area-inset-bottom, 0px))`;

  return (
    <>
      {showStack && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 800, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'var(--hw-content)', color: 'var(--hw-ink)', fontFamily: 'var(--hw-font-body)', fontSize: 15, lineHeight: 1.4,
          WebkitFontSmoothing: 'antialiased', fontVariantNumeric: 'tabular-nums',
          '--hw-tabbar-space': showBar ? barSpace : 'env(safe-area-inset-bottom, 16px)',
        }}>
          <StackScreen key={top.key} entry={top} depth={stack.length - 1} onBack={onBack} onOpenPalette={openPalette} />
        </div>
      )}
      {showBar && <TabBar current={tab} onSelect={select} />}
    </>
  );
}
