// Upstream MailFlow surfaces as pane views. They read and write upstream's store exactly as in
// the classic shell (selected account, folder, message), so a Hedwig view that sets the selected
// message drives core.thread with no extra wiring.
import { lazy, Suspense } from 'react';
import { registerView, getView } from '../registry.js';
import { useStore } from '../../store/index.js';
import { usePluginSlot } from '../../plugins/PluginSlot.jsx';
import Sidebar from '../../components/Sidebar.jsx';
import MessageList from '../../components/MessageList.jsx';
import ReadingPane from '../../components/ReadingPane.jsx';
import { Icon } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { useRegistryVersion, groupedViews } from './useRegistry.js';
import { tr } from './tr.js';

const ContactsPage = lazy(() => import('../../components/ContactsPage.jsx'));

// Upstream components size themselves for the classic shell; .hw-fill makes them fill the pane,
// and --list-width scoped here makes MessageList's width follow the pane instead of the root.
// .hw-fill also puts them on the pane's glass (see styles.js): no opaque slab, no second border.
function Fill({ children }) {
  return (
    <div className="hw-fill hw-scroll" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', '--list-width': '100%' }}>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 22, height: 22, border: '2px solid var(--hw-border)', borderTopColor: 'var(--hw-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    </div>
  );
}

function NavView() { return <Fill><Sidebar /></Fill>; }
function ListView() { return <Fill><MessageList /></Fill>; }
function ThreadView() { return <Fill><ReadingPane /></Fill>; }
function ContactsView() {
  return <Fill><Suspense fallback={<Spinner />}><ContactsPage /></Suspense></Fill>;
}

// The upstream right-sidebar plugin seam (GTD fills it) as a pane of its own.
function PluginSidebarView({ paneId }) {
  const accounts = useStore((s) => s.accounts);
  const selectedAccountId = useStore((s) => s.selectedAccountId);
  const ctx = { accounts, selectedAccountId, onCollapse: () => useShell.getState().closePane(paneId), toggleHint: '' };
  const providers = usePluginSlot('right-sidebar', ctx);
  if (!providers.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--hw-muted)', fontSize: 13 }}>
        {tr('pluginSidebar.empty', 'No plugin is filling this sidebar. Turn on a plugin such as GTD in Settings → Plugins.')}
      </div>
    );
  }
  return <Fill>{providers[0].render(ctx)}</Fill>;
}

// What a freshly split pane shows until a view is chosen.
function PickerView({ paneId }) {
  useRegistryVersion();
  const replace = (id) => useShell.getState().replaceView(paneId, id);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '26px 26px 32px', background: 'transparent', color: 'var(--hw-ink)' }}>
      <h2 style={{ ...ui.display, margin: '0 0 4px', fontSize: 30 }}>{tr('picker.title', 'Choose a view')}</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--hw-muted)' }}>{tr('picker.body', 'Any view can live in any pane. Plugin views appear here once their plugin is on.')}</p>
      {groupedViews().map((g) => (
        <section key={g.group} aria-label={g.label} style={{ marginBottom: 18 }}>
          <div style={{ ...ui.label, marginBottom: 8 }}>{g.label}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
            {g.views.map((v) => (
              <button
                key={v.id}
                type="button"
                className="hw-btn"
                onClick={() => replace(v.id)}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', textAlign: 'left', border: `1px solid ${v.pluginId ? 'var(--hw-teal)' : 'var(--hw-border)'}`, borderRadius: 10, background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                <span style={{ color: v.pluginId ? 'var(--hw-teal)' : 'var(--hw-muted)', marginTop: 2 }}><Icon name={v.icon || 'grid'} size={16} /></span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{v.title || v.id}</span>
                  <span style={{ fontSize: 11, color: 'var(--hw-muted)', fontFamily: 'var(--hw-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.id}</span>
                  {v.description && <span style={{ fontSize: 12, color: 'var(--hw-muted)' }}>{v.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const CORE_VIEWS = [
  // chrome: no pane header outside arrange mode. paneWidth: a column width that overrides the
  // pane's size while it returns a number (upstream's collapsed sidebar is 60px wide).
  {
    id: 'core.nav', title: 'Folders', icon: 'nav', group: 'mail', chrome: true, component: NavView, description: 'Accounts, folders and labels',
    paneWidth: () => (useStore.getState().sidebarCollapsed ? 60 : null),
  },
  { id: 'core.list', title: 'Message list', icon: 'list', group: 'mail', component: ListView, description: 'The mail list for the selected folder' },
  { id: 'core.thread', title: 'Reading pane', icon: 'thread', group: 'mail', component: ThreadView, description: 'The selected message or conversation' },
  { id: 'core.contacts', title: 'Contacts', icon: 'contacts', group: 'mail', component: ContactsView, description: 'Address book' },
  { id: 'core.pluginSidebar', title: 'Plugin sidebar', icon: 'plugin', group: 'plugins', component: PluginSidebarView, description: 'The right-hand sidebar plugins such as GTD fill' },
  { id: 'core.picker', title: 'Choose a view', icon: 'grid', group: 'mail', hidden: true, component: PickerView },
];

export function registerCoreViews() {
  for (const v of CORE_VIEWS) {
    if (!getView(v.id)) registerView(v);
  }
}
