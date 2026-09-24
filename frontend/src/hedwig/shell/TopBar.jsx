// The Hedwig top bar (only for a layout without the rail): brand, the command palette trigger,
// sync status, the Tier 2 note and the View menu. The View menu is the one switcher, here and
// behind the rail's "…": the Hedwig layouts with a line each, saved layouts, Customize layout…,
// Appearance, Settings, and last the classic MailFlow shell (not a one-click button: it hides
// every v2 view, and was too easy to land in by accident). On a phone it opens as a sheet.
import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { Icon, OwlMark } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { listPanes } from './model.js';
import { HEDWIG_TEMPLATES } from './templates.js';
import { customLayoutsFor } from './layouts.js';
import { MenuButton } from './Menu.jsx';
import { tr } from './tr.js';
import { TierNote } from '../v2/TierNote.jsx';
import { useV2 } from '../v2/state.js';
import { tv } from '../v2/i18n.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function latestSync(accounts) {
  let best = 0;
  for (const a of accounts || []) {
    const t = a.last_sync ? Date.parse(a.last_sync) : 0;
    if (t > best) best = t;
  }
  return best || null;
}

export function SyncStatus({ compact = false }) {
  const accounts = useStore((s) => s.accounts);
  const setShowAdmin = useStore((s) => s.setShowAdmin);
  const setAdminTab = useStore((s) => s.setAdminTab);
  const [lastEvent, setLastEvent] = useState(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const onSync = () => setLastEvent(Date.now());
    window.addEventListener('mailflow:sync_done', onSync);
    const iv = setInterval(() => tick((n) => n + 1), 10000);
    return () => { window.removeEventListener('mailflow:sync_done', onSync); clearInterval(iv); };
  }, []);

  const n = accounts?.length || 0;
  if (!n) return null;
  const failing = accounts.filter((a) => a.sync_error).length;
  const last = Math.max(lastEvent || 0, latestSync(accounts) || 0) || null;
  const text = failing
    ? `${failing} of ${n} account${n === 1 ? '' : 's'} need${failing === 1 ? 's' : ''} attention`
    : `${n} account${n === 1 ? '' : 's'} synced${last ? ` · ${ago(Date.now() - last)}` : ''}`;
  return (
    <button
      type="button"
      className="hw-btn-quiet"
      onClick={() => { setAdminTab('accounts'); setShowAdmin(true); }}
      aria-label={`${text}. Open account settings`}
      title={text}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--hw-muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: failing ? 'var(--hw-red)' : 'var(--hw-muted)', flexShrink: 0 }} />
      {!compact && <span>{text}</span>}
    </button>
  );
}

const isPhoneWidth = () => typeof window !== 'undefined' && window.innerWidth < 768;

/** The colour scheme the Appearance radio shows: the explicit choice, else what the saved theme is. */
export function schemeChoice() {
  const choice = useV2.getState().scheme;
  if (choice === 'light' || choice === 'dark' || choice === 'auto') return choice;
  return useStore.getState().theme === 'hedwig-night' ? 'dark' : 'light';
}

/**
 * The View menu (the rail's "…", the top bar's View button, the phone sheet). On a phone there are
 * no panes, so the Layout section is left out and the rest is the same.
 */
export function layoutMenuItems({ phone = isPhoneWidth() } = {}) {
  const s = useShell.getState();
  const hedwig = useHedwig.getState();
  const items = [];
  if (!phone) {
    items.push({ type: 'header', label: tr('view.layout', 'Layout') });
    for (const t of HEDWIG_TEMPLATES) {
      items.push({
        id: `t:${t.id}`,
        label: tr(`view.template.${t.id}`, t.label),
        description: tr(`view.template.${t.id}Desc`, t.description),
        radio: true,
        checked: s.templateId === t.id && s.name === t.label,
        onSelect: () => s.applyTemplate(t.id),
      });
    }
    const custom = customLayoutsFor(s.rows, s.device);
    if (custom.length) {
      items.push({ type: 'header', label: tr('view.saved', 'Saved') });
      for (const r of custom) items.push({ id: `s:${r.id}`, label: r.name, radio: true, checked: s.name === r.name, onSelect: () => s.applySaved(r) });
    }
    items.push({ id: 'customize', label: tr('view.customize', 'Customize layout…'), icon: 'arrange', onSelect: () => hedwig.openView('hedwig.layouts') });
    items.push({ type: 'separator' });
  }
  const scheme = schemeChoice();
  items.push({ type: 'header', label: tr('view.appearance', 'Appearance') });
  items.push({
    type: 'radio',
    id: 'scheme',
    ariaLabel: tr('view.appearance', 'Appearance'),
    options: [
      { id: 'light', label: tv('hedwig.v2.scheme.light', 'Light'), checked: scheme === 'light', onSelect: () => useV2.getState().setScheme('light') },
      { id: 'dark', label: tv('hedwig.v2.scheme.dark', 'Dark'), checked: scheme === 'dark', onSelect: () => useV2.getState().setScheme('dark') },
      { id: 'auto', label: tv('hedwig.v2.scheme.auto', 'Auto'), checked: scheme === 'auto', onSelect: () => useV2.getState().setScheme('auto') },
    ],
  });
  items.push({ type: 'separator' });
  items.push({ id: 'hedwig-settings', label: tr('view.settings', 'Settings'), icon: 'settings', onSelect: () => hedwig.openView('hedwig.settings.personal') });
  items.push({ id: 'mail-settings', label: tv('hedwig.v2.rail.mailSettings', 'Mail settings'), icon: 'mail', onSelect: () => useStore.getState().setShowAdmin?.(true) });
  items.push({ type: 'separator' });
  items.push({
    id: 'classic',
    label: tr('view.classic', 'Classic MailFlow shell'),
    description: tr('view.classicDesc', 'The original MailFlow layout. Switch back from the top of its sidebar.'),
    icon: 'classic',
    onSelect: () => hedwig.setShellMode('classic'),
  });
  return items;
}

const RAIL_BUTTON = { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 0, background: 'transparent', color: 'var(--hw-muted)', cursor: 'pointer', padding: 0 };
const PHONE_BUTTON = { width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 0, background: 'transparent', color: 'var(--hw-ink)', cursor: 'pointer', padding: 0 };

/**
 * The View menu's trigger. `variant`: 'rail' (the "…" beside the wordmark), 'bar' (the top bar's
 * layout button), 'phone' (a 44px button in a phone header; the menu opens as a sheet).
 */
export function ViewMenuButton({ variant = 'rail' }) {
  const layoutName = useShell((s) => s.name);
  const label = variant === 'phone'
    ? tr('view.menuPhone', 'View and settings')
    : tr('view.menu', 'View: {{name}}', { name: layoutName });
  const style = variant === 'bar' ? ui.iconButton : variant === 'phone' ? PHONE_BUTTON : RAIL_BUTTON;
  return (
    <MenuButton
      label={label}
      heading={tr('view.heading', 'View')}
      items={() => layoutMenuItems({ phone: variant === 'phone' || isPhoneWidth() })}
      width={280}
      align={variant === 'bar' ? 'right' : 'left'}
      sheet="auto"
      buttonClassName={variant === 'bar' ? 'hw-btn' : 'hw-icon-btn'}
      buttonStyle={style}
    >
      <Icon name={variant === 'bar' ? 'layout' : 'ellipsis'} size={variant === 'phone' ? 20 : 16} />
    </MenuButton>
  );
}

export default function TopBar({ onOpenPalette }) {
  // The rail carries the Tier 2 note itself; the top bar says it only for layouts without one.
  const hasRail = useShell((s) => listPanes(s.tree).some((p) => p.visible && p.node.id === 'hedwig.rail'));
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header style={{
      height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px',
      background: 'transparent', color: 'var(--hw-ink)', position: 'relative', zIndex: 2,
      fontFamily: 'var(--hw-font-body)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: narrow ? 'auto' : 216, flexShrink: 0 }}>
        <OwlMark size={18} />
        <span style={{ ...ui.display, fontSize: 13, lineHeight: 1 }}>{tr('brand', 'Hedwig')}</span>
      </div>
      <button
        type="button"
        aria-label={tr('palette.open', 'Open command palette')}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        onClick={onOpenPalette}
        className="hw-btn"
        style={{
          flex: '1 1 auto', maxWidth: 520, minWidth: 0, height: 30, display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 10px', border: 0, borderRadius: 8, background: 'var(--hw-field)',
          color: 'var(--hw-muted)', fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <Icon name="search" size={14} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tr('palette.placeholder', 'Search mail, people, topics, or run a command')}
        </span>
        <kbd style={{ fontFamily: 'inherit', fontSize: 11, padding: 0, border: 0, color: 'var(--hw-muted)', background: 'transparent' }}>
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <div style={{ flex: 1 }} />
      {!narrow && !hasRail && <TierNote style={{ maxWidth: 280 }} />}
      <SyncStatus compact={narrow} />
      <ViewMenuButton variant="bar" />
    </header>
  );
}
