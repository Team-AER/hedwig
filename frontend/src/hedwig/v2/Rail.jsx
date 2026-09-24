// The desktop rail (DESIGN-AUDIT-2026-09-24 §a): the owl and "Hedwig" with New message, then only
// places: the streams with glyphs and counts (the Records ledgers under Records), "Later" (Reply
// Later, Set Aside, Snoozed, Waiting on) and "Hedwig" (Daily Brief, Today, Settings). The footer
// is the account line and one quiet status line: sync, or the tier note while a model tier is
// degraded. Search lives in the list header, what Hedwig did today at the top of Today, and Power
// in Settings and the palette. It is a pane view like any other, so the pane tree can move or drop it.
import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { useShell } from '../shell/state.js';
import { layoutMenuItems } from '../shell/TopBar.jsx';
import { MenuButton } from '../shell/Menu.jsx';
import { Icon, OwlMark } from '../icons.jsx';
import { useV2, countText } from './state.js';
import { useWork } from './hooks.js';
import { currentMainView, showView, VIEW } from './nav.js';
import { LEDGER_KINDS, SIMPLE_LEDGERS, ledgerTitle } from './Ledger.jsx';
import { Avatar, IconButton, Num, SectionLabel, V } from './primitives.jsx';
import { TierNote } from './TierNote.jsx';
import { tierNotice } from './tiers.js';
import { tv, tvn } from './i18n.js';

const LEDGER_ICONS = { purchases: 'shopping-bag', subscriptions: 'repeat', travel: 'plane', deliveries: 'package' };

function NavItem({ icon, label, count, attention = false, on, onClick, sub = false }) {
  const [hot, setHot] = useState(false);
  const shown = count != null && count !== 0 && count !== '';
  return (
    <button
      type="button"
      className="hw-nav"
      aria-current={on ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: sub ? '0 8px 0 28px' : '0 8px', borderRadius: 6, width: '100%', boxSizing: 'border-box',
        border: 0, background: on ? V.select : hot ? V.hover : 'transparent', color: V.ink, fontFamily: V.sans, fontSize: 13, textAlign: 'left', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: V.accent }}>
        <Icon name={icon} size={16} />
      </span>
      <span style={{ flexGrow: 1, fontWeight: on ? 600 : 400, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {shown && <Num size={12} color={attention ? V.attentionInk : V.muted} style={{ fontWeight: 500 }}>{count}</Num>}
    </button>
  );
}

export function schemeLabel(scheme) {
  if (scheme === 'light') return tv('hedwig.v2.scheme.light', 'Light');
  if (scheme === 'dark') return tv('hedwig.v2.scheme.dark', 'Dark');
  return tv('hedwig.v2.scheme.auto', 'Auto');
}

export const nextScheme = (s) => (s === 'auto' ? 'light' : s === 'light' ? 'dark' : 'auto');

/** The newest last_sync across the accounts, as a time, or null. */
export function latestSync(accounts) {
  let best = 0;
  for (const a of accounts || []) {
    const t = a?.last_sync ? Date.parse(a.last_sync) : 0;
    if (t > best) best = t;
  }
  return best || null;
}

/** "Up to date · 2 min", "Up to date", or "Syncing…" while an account is backfilling. Pure. */
export function syncLine({ syncing = false, last = null, now = Date.now() } = {}) {
  if (syncing) return tv('hedwig.v2.rail.syncing', 'Syncing…');
  if (!last) return tv('hedwig.v2.rail.upToDate', 'Up to date');
  const min = Math.max(0, Math.round((now - last) / 60000));
  if (min < 1) return tv('hedwig.v2.rail.upToDateNow', 'Up to date · just now');
  if (min < 60) return tv('hedwig.v2.rail.upToDateMin', 'Up to date · {{n}} min', { n: min });
  const h = Math.round(min / 60);
  return h < 24 ? tv('hedwig.v2.rail.upToDateHours', 'Up to date · {{n}} h', { n: h }) : tv('hedwig.v2.rail.upToDateDays', 'Up to date · {{n}} d', { n: Math.round(h / 24) });
}

function accountAddress(a) {
  return a?.email_address || a?.email || a?.name || '';
}

function StatusLine() {
  const accounts = useStore((s) => s.accounts);
  const backfill = useStore((s) => s.backfillProgress);
  const status = useHedwig((s) => s.status);
  const [lastEvent, setLastEvent] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onSync = () => { setLastEvent(Date.now()); setNow(Date.now()); };
    window.addEventListener('mailflow:sync_done', onSync);
    const iv = setInterval(() => setNow(Date.now()), 30000);
    return () => { window.removeEventListener('mailflow:sync_done', onSync); clearInterval(iv); };
  }, []);
  const degraded = Boolean(tierNotice(status));
  const syncing = Object.values(backfill || {}).some(Boolean);
  const last = Math.max(lastEvent || 0, latestSync(accounts) || 0) || null;
  const text = syncLine({ syncing, last, now });
  return (
    <button
      type="button"
      className="hw-btn-quiet"
      onClick={() => showView(VIEW.today)}
      title={degraded ? undefined : text}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, height: 24, width: '100%', boxSizing: 'border-box', padding: '0 6px', border: 0, borderRadius: 6,
        background: 'transparent', color: V.muted, fontFamily: V.sans, fontSize: 11, lineHeight: '14px', textAlign: 'left', cursor: 'pointer', minWidth: 0,
      }}
    >
      {degraded
        ? <TierNote />
        : (
          <>
            <Icon name={syncing ? 'sync' : 'circle-check'} size={12} strokeWidth={1.75} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
          </>
        )}
    </button>
  );
}

function AccountLine() {
  const accounts = useStore((s) => s.accounts) || [];
  const n = accounts.length;
  const failing = accounts.filter((a) => a.sync_error).length;
  const first = accounts[0];
  const open = () => { const st = useStore.getState(); st.setAdminTab?.('accounts'); st.setShowAdmin?.(true); };
  let label;
  if (failing) label = tv('hedwig.v2.rail.accountsFailing', '{{n}} of {{total}} need attention', { n: failing, total: n });
  else if (n === 1) label = accountAddress(first);
  else label = tvn(n, ['hedwig.v2.rail.accountsOne', '1 account'], ['hedwig.v2.rail.accountsMany', '{{n}} accounts']);
  return (
    <button
      type="button"
      data-account-line=""
      className="hw-btn-quiet"
      onClick={open}
      title={accounts.map(accountAddress).filter(Boolean).join(', ') || undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 32, width: '100%', boxSizing: 'border-box', padding: '0 6px', border: 0, borderRadius: 6,
        background: 'transparent', color: failing ? V.red : V.ink, fontFamily: V.sans, fontSize: 12, fontWeight: 500, textAlign: 'left', cursor: 'pointer', minWidth: 0,
      }}
    >
      {n > 0
        ? <Avatar name={first?.name || accountAddress(first)} email={accountAddress(first)} size={20} />
        : <span aria-hidden="true" style={{ display: 'inline-flex', color: V.muted }}><Icon name="user" size={16} /></span>}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n ? label : tv('hedwig.v2.rail.noAccounts', 'Add an account')}</span>
    </button>
  );
}

export default function Rail() {
  const counts = useV2((s) => s.counts);
  const more = useV2((s) => s.countsMore);
  const work = useWork();
  const power = useV2((s) => s.prefs.powerMode);
  // No explicit choice yet: show (and cycle from) what the saved theme is.
  const schemeChoice = useV2((s) => s.scheme);
  const theme = useStore((s) => s.theme);
  const scheme = schemeChoice || (theme === 'hedwig-night' ? 'dark' : 'light');
  const tree = useShell((s) => s.tree);
  const current = currentMainView(tree);
  const on = (id, list) => current?.id === id && (!list || current.props?.list === list);
  const onLedger = (kind) => current?.id === VIEW.ledger && (current.props?.kind || 'purchases') === kind;
  const ledgers = power ? LEDGER_KINDS : SIMPLE_LEDGERS;
  const compose = () => { const st = useStore.getState(); st.openCompose?.({ accountId: st.selectedAccountId || undefined }); };
  const openSettings = () => useHedwig.getState().openView('hedwig.settings.personal');

  const moreItems = () => [
    ...layoutMenuItems(),
    { type: 'separator' },
    { id: 'scheme', label: tv('hedwig.v2.scheme.menu', 'Light or dark: {{scheme}}', { scheme: schemeLabel(scheme) }), hint: schemeLabel(nextScheme(scheme)), onSelect: () => useV2.getState().setScheme(nextScheme(scheme)) },
    { id: 'hedwig-settings', label: tv('hedwig.v2.rail.hedwigSettings', 'Hedwig settings'), icon: 'settings', onSelect: openSettings },
    { id: 'mail-settings', label: tv('hedwig.v2.rail.mailSettings', 'Mail settings'), icon: 'settings', onSelect: () => useStore.getState().setShowAdmin?.(true) },
  ];

  return (
    <nav aria-label={tv('hedwig.v2.rail.label', 'Streams')} className="hw-v2" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', color: V.ink, fontFamily: V.sans, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '10px 8px 0 16px', flexShrink: 0 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: V.ink }}><OwlMark size={18} /></span>
        <span style={{ fontSize: 13, fontWeight: 600, flexGrow: 1, minWidth: 0 }}>{tv('hedwig.v2.brand', 'Hedwig')}</span>
        <MenuButton
          label={tv('hedwig.v2.rail.more', 'Layout and settings')}
          items={moreItems}
          width={260}
          buttonClassName="hw-icon-btn"
          buttonStyle={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 0, background: 'transparent', color: V.muted, cursor: 'pointer', padding: 0 }}
        >
          <Icon name="ellipsis" size={16} />
        </MenuButton>
        <IconButton icon="compose" label={tv('hedwig.v2.rail.compose', 'New message')} kbd="C" onClick={compose} />
      </div>
      <div className="hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: '8px 8px 12px' }}>
        <NavItem icon="door-open" label={tv('hedwig.v2.rail.screener', 'Screener')} count={countText(counts, more, 'screener')} on={on(VIEW.screener)} onClick={() => showView(VIEW.screener)} />
        <NavItem icon="users" label={tv('hedwig.v2.stream.people', 'People')} count={countText(counts, more, 'people')} attention on={on(VIEW.people)} onClick={() => showView(VIEW.people)} />
        <NavItem icon="book-open" label={tv('hedwig.v2.stream.reading', 'Reading')} count={countText(counts, more, 'reading')} on={on(VIEW.reading)} onClick={() => showView(VIEW.reading)} />
        <NavItem icon="receipt" label={tv('hedwig.v2.stream.records', 'Records')} count={countText(counts, more, 'records')} on={on(VIEW.records)} onClick={() => showView(VIEW.records)} />
        {ledgers.map((kind) => (
          <NavItem key={kind} sub icon={LEDGER_ICONS[kind] || 'receipt'} label={ledgerTitle(kind)} on={onLedger(kind)} onClick={() => showView(VIEW.ledger, { kind })} />
        ))}
        {work && (
          <>
            <SectionLabel as="h2">{tv('hedwig.v2.rail.later', 'Later')}</SectionLabel>
            <NavItem icon="reply" label={tv('hedwig.v2.rail.replyLater', 'Reply Later')} count={countText(counts, more, 'replyLater')} on={on(VIEW.list, 'replyLater')} onClick={() => showView(VIEW.list, { list: 'replyLater' })} />
            <NavItem icon="bookmark" label={tv('hedwig.v2.rail.setAside', 'Set Aside')} count={countText(counts, more, 'setAside')} on={on(VIEW.list, 'setAside')} onClick={() => showView(VIEW.list, { list: 'setAside' })} />
            <NavItem icon="alarm-clock" label={tv('hedwig.v2.rail.snoozed', 'Snoozed')} count={countText(counts, more, 'snoozed')} on={on(VIEW.list, 'snoozed')} onClick={() => showView(VIEW.list, { list: 'snoozed' })} />
            <NavItem icon="hourglass" label={tv('hedwig.v2.waiting.title', 'Waiting on')} on={on(VIEW.waiting)} onClick={() => showView(VIEW.waiting)} />
          </>
        )}
        <SectionLabel as="h2">{tv('hedwig.v2.brand', 'Hedwig')}</SectionLabel>
        <NavItem icon="newspaper" label={tv('hedwig.v2.rail.brief', 'Daily Brief')} on={on(VIEW.brief)} onClick={() => showView(VIEW.brief)} />
        <NavItem icon="history" label={tv('hedwig.v2.rail.today', 'Today')} on={on(VIEW.today)} onClick={() => showView(VIEW.today)} />
        <NavItem icon="settings" label={tv('hedwig.v2.rail.settings', 'Settings')} on={false} onClick={openSettings} />
      </div>
      <footer style={{ flexShrink: 0, borderTop: `1px solid ${V.line}`, padding: '6px 8px 10px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <AccountLine />
        <StatusLine />
      </footer>
    </nav>
  );
}
