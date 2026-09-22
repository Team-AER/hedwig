// The Hedwig top bar: brand, the command palette trigger, sync status, the layout switcher,
// settings, and the way back to the classic MailFlow shell.
import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { Icon, OwlMark } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { TEMPLATES } from './templates.js';
import { exportCurrentLayout } from './layoutFile.js';
import { MenuButton } from './Menu.jsx';
import { tr } from './tr.js';

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
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--hw-muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: failing ? 'var(--hw-amber)' : 'var(--hw-teal)', flexShrink: 0 }} />
      {!compact && <span>{text}</span>}
    </button>
  );
}

export function layoutMenuItems() {
  const s = useShell.getState();
  const saved = s.savedLayouts();
  const items = [{ type: 'header', label: `Templates · ${s.device}` }];
  for (const t of TEMPLATES) {
    items.push({ id: `t:${t.id}`, label: t.label, hint: t.upstreamLayout ? 'upstream' : undefined, checked: s.templateId === t.id && s.name === t.label, onSelect: () => s.applyTemplate(t.id) });
  }
  const custom = saved.filter((r) => !TEMPLATES.some((t) => t.label === r.name));
  if (custom.length) {
    items.push({ type: 'header', label: 'Saved' });
    for (const r of custom) items.push({ id: `s:${r.id}`, label: r.name, checked: s.name === r.name, onSelect: () => s.applySaved(r) });
  }
  items.push({ type: 'separator' });
  items.push({ id: 'arrange', label: 'Arrange panes', checked: s.arrange, onSelect: () => s.toggleArrange() });
  items.push({ id: 'edit', label: 'Edit layouts…', icon: 'layout', onSelect: () => useHedwig.getState().openView('hedwig.layouts') });
  items.push({ id: 'export', label: 'Export layout as JSON', icon: 'export', onSelect: exportCurrentLayout });
  items.push({ id: 'classic', label: 'Classic MailFlow layout', icon: 'classic', onSelect: () => useHedwig.getState().setShellMode('classic') });
  return items;
}

export default function TopBar({ onOpenPalette }) {
  const layoutName = useShell((s) => s.name);
  const setShowAdmin = useStore((s) => s.setShowAdmin);
  const setShellMode = useHedwig((s) => s.setShellMode);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header style={{
      height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px',
      borderBottom: '1px solid var(--hw-border)', background: 'var(--hw-raised)', color: 'var(--hw-ink)',
      fontFamily: 'var(--hw-font-body)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: narrow ? 'auto' : 204, flexShrink: 0 }}>
        <OwlMark size={22} />
        <span style={{ ...ui.display, fontSize: 19 }}>{tr('brand', 'Hedwig')}</span>
      </div>
      <button
        type="button"
        aria-label={tr('palette.open', 'Open command palette')}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        onClick={onOpenPalette}
        className="hw-btn"
        style={{
          flex: '1 1 auto', maxWidth: 560, minWidth: 0, height: 32, display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 12px', border: '1px solid var(--hw-border)', borderRadius: 8, background: 'var(--hw-surface)',
          color: 'var(--hw-muted)', fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <Icon name="search" size={15} strokeWidth={2} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tr('palette.placeholder', 'Search mail, people, topics, or run a command')}
        </span>
        <kbd style={{ fontFamily: 'var(--hw-font-mono)', fontSize: 11, padding: '2px 6px', border: '1px solid var(--hw-border)', borderRadius: 4, color: 'var(--hw-muted)', background: 'transparent' }}>
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <div style={{ flex: 1 }} />
      <SyncStatus compact={narrow} />
      <MenuButton label={tr('layout.menu', 'Layout: {{name}}', { name: layoutName })} items={layoutMenuItems} align="right" buttonStyle={ui.iconButton}>
        <Icon name="layout" size={16} />
      </MenuButton>
      <button type="button" className="hw-btn" aria-label={tr('settings', 'Settings')} title={tr('settings', 'Settings')} onClick={() => setShowAdmin(true)} style={ui.iconButton}>
        <Icon name="settings" size={16} />
      </button>
      <button type="button" className="hw-btn" aria-label={tr('classic.switch', 'Switch to the classic MailFlow layout')} title={tr('classic.title', 'Classic MailFlow layout')} onClick={() => setShellMode('classic')} style={ui.iconButton}>
        <Icon name="classic" size={16} />
      </button>
    </header>
  );
}
