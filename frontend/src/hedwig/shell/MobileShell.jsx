// Phone chrome for the Hedwig shell. Upstream's mobile list → message → back flow stays exactly
// as it is; Hedwig adds a bottom tab bar (Inbox, Ask, People, Compose) and a view stack drawn
// above upstream's list with its own back navigation. Opening a message from a Hedwig view
// shows upstream's reading pane; backing out of it returns to the view.
import { useEffect, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { getView } from '../registry.js';
import { Icon, OwlMark } from '../icons.jsx';
import { ensureHedwigStyles, ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { ViewHost } from './ViewHost.jsx';
import { useRegistryVersion } from './useRegistry.js';
import { useViewRequests } from './useViewRequests.js';
import { TAB_BAR_HEIGHT, useHedwigTabBar } from './tabBar.js';
import { tr } from './tr.js';

const TABS = [
  { id: 'inbox', label: () => tr('mobile.inbox', 'Inbox'), icon: 'inbox' },
  { id: 'ask', label: () => tr('mobile.ask', 'Ask'), icon: 'ask' },
  { id: 'people', label: () => tr('mobile.people', 'People'), icon: 'people' },
  { id: 'compose', label: () => tr('mobile.compose', 'Compose'), icon: 'compose' },
];

function rootFor(tab) {
  if (tab === 'inbox') return getView('hedwig.needs') ? 'hedwig.needs' : null;
  if (tab === 'ask') return getView('hedwig.ask') ? 'hedwig.ask' : null;
  if (tab === 'people') return getView('hedwig.people') ? 'hedwig.people' : null;
  return null;
}

function TabBar({ current, onSelect }) {
  return (
    <nav aria-label={tr('mobile.tabs', 'Hedwig')} style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 850,
      height: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      display: 'flex', justifyContent: 'space-around', alignItems: 'center',
      borderTop: '1px solid var(--hw-border)', background: 'var(--hw-ground)', fontFamily: 'var(--hw-font-body)',
    }}>
      {TABS.map((t) => {
        const active = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-label={t.label()}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(t.id)}
            style={{
              minWidth: 64, height: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
              border: 0, background: 'transparent', color: active ? 'var(--hw-ink)' : 'var(--hw-muted)',
              fontFamily: 'inherit', fontSize: 11, fontWeight: active ? 600 : 400, cursor: 'pointer',
            }}
          >
            <Icon name={t.icon} size={20} strokeWidth={2} />
            {t.label()}
          </button>
        );
      })}
    </nav>
  );
}

function StackScreen({ entry, depth, onBack, onOpenPalette }) {
  useRegistryVersion();
  const setMobileSidebarOpen = useStore((s) => s.setMobileSidebarOpen);
  const title = getView(entry.id)?.title || entry.id;
  const headRef = useRef(null);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [entry.key]);
  return (
    <section aria-label={title} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(var(--sat, 0px) + 10px) 16px 8px', flexShrink: 0 }}>
        {depth > 0 ? (
          <button type="button" className="hw-btn" aria-label={tr('mobile.back', 'Back')} onClick={onBack} style={{ ...ui.iconButton, width: 44, height: 44, borderRadius: 12, background: 'var(--hw-ground)' }}>
            <Icon name="chevron-left" size={20} strokeWidth={2} />
          </button>
        ) : (
          <button type="button" className="hw-btn" aria-label={tr('mobile.folders', 'Folders and accounts')} onClick={() => setMobileSidebarOpen(true)} style={{ ...ui.iconButton, width: 44, height: 44, borderRadius: 12, background: 'var(--hw-ground)' }}>
            <Icon name="nav" size={20} strokeWidth={2} />
          </button>
        )}
        <span ref={headRef} tabIndex={-1} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, outline: 'none' }}>
          <OwlMark size={20} />
          <span style={{ ...ui.display, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{depth > 0 ? title : 'Hedwig'}</span>
        </span>
        <button type="button" className="hw-btn" aria-label={tr('mobile.search', 'Search and commands')} onClick={onOpenPalette} style={{ ...ui.iconButton, width: 44, height: 44, borderRadius: 12, background: 'var(--hw-ground)' }}>
          <Icon name="search" size={18} strokeWidth={2} />
        </button>
      </div>
      <ViewHost paneKey={entry.key} viewId={entry.id} props={entry.props} />
    </section>
  );
}

export default function HedwigMobile({ onOpenPalette }) {
  useRegistryVersion();
  const tab = useShell((s) => s.mobileTab);
  const stacks = useShell((s) => s.stacks);
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const showContacts = useStore((s) => s.showContacts);
  const selectedFolder = useStore((s) => s.selectedFolder);
  const selectedAccountId = useStore((s) => s.selectedAccountId);
  const { visible } = useHedwigTabBar(true);

  useEffect(() => { ensureHedwigStyles(); }, []);
  useViewRequests({ phone: true });

  // First visit to a tab: seed its stack with the tab's root view when there is one.
  const inboxRoot = rootFor('inbox');
  useEffect(() => {
    const s = useShell.getState();
    if (s.stacks.inbox === null && inboxRoot) s.setStack('inbox', [{ key: 'root-inbox', id: inboxRoot, props: {} }]);
  }, [inboxRoot]);

  // Choosing a folder in upstream's drawer means "show me that folder": reveal upstream's list.
  const folderRef = useRef(`${selectedAccountId}|${selectedFolder}`);
  useEffect(() => {
    const now = `${selectedAccountId}|${selectedFolder}`;
    if (folderRef.current === now) return;
    folderRef.current = now;
    const s = useShell.getState();
    s.setMobileTab('inbox');
    s.setStack('inbox', []);
  }, [selectedAccountId, selectedFolder]);

  const select = (id) => {
    const s = useShell.getState();
    const store = useStore.getState();
    if (id === 'compose') { store.openCompose({ accountId: store.selectedAccountId || undefined }); return; }
    if (store.selectedMessageId) store.setSelectedMessage(null);
    if (id !== 'people' && store.showContacts) store.setShowContacts(false);
    const root = rootFor(id);
    const stack = s.stacks[id];
    if (id === 'inbox' && s.mobileTab === 'inbox') {
      // Inbox twice toggles between Needs you and upstream's full list.
      if (root) s.setStack('inbox', stack?.length ? [] : [{ key: 'root-inbox', id: root, props: {} }]);
    } else if (!stack?.length && root) {
      s.setStack(id, [{ key: `root-${id}`, id: root, props: {} }]);
    } else if (s.mobileTab === id && stack?.length > 1) {
      s.setStack(id, stack.slice(0, 1));
    }
    if (id === 'people' && !root) store.setShowContacts(true);
    s.setMobileTab(id);
  };

  const stack = (tab === 'people' && !rootFor('people')) ? [] : (stacks[tab] || []);
  const top = stack[stack.length - 1];
  // Upstream owns the screen while a message is open (its reading pane), and on the People tab
  // when contacts are upstream's.
  const showStack = Boolean(top) && !selectedMessageId && !(tab === 'people' && showContacts && !rootFor('people'));
  const current = showContacts && !rootFor('people') ? 'people' : tab;

  return (
    <>
      {showStack && (
        <div style={{
          position: 'fixed', left: 0, right: 0, top: 0, zIndex: 800,
          bottom: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
          display: 'flex', flexDirection: 'column', background: 'var(--hw-surface)', color: 'var(--hw-ink)',
          fontFamily: 'var(--hw-font-body)', fontSize: 15, lineHeight: 1.4,
        }}>
          <StackScreen key={top.key} entry={top} depth={stack.length - 1} onBack={() => useShell.getState().popView()} onOpenPalette={onOpenPalette} />
        </div>
      )}
      {visible && <TabBar current={current} onSelect={select} />}
    </>
  );
}
