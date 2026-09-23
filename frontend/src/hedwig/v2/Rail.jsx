// The desktop rail (docs/hedwig/design Main): wordmark, search-or-ask with ⌘K, the streams with
// their counts, Reply Later / Set Aside / Snoozed / Daily Brief, the "Hedwig today" line with
// Review or undo, the account dots, and the Power toggle. It is a pane view like any other, so
// the pane tree can move or drop it.
import { useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { useShell } from '../shell/state.js';
import { layoutMenuItems } from '../shell/TopBar.jsx';
import { MenuButton } from '../shell/Menu.jsx';
import { useV2, countText } from './state.js';
import { useWork } from './hooks.js';
import { todayLine } from './Brief.jsx';
import { currentMainView, showView, VIEW } from './nav.js';
import { Glyph, Hair, LinkBtn, Mono, V, Why } from './primitives.jsx';
import { tv } from './i18n.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function NavItem({ label, count, accentCount, on, onClick }) {
  return (
    <button
      type="button"
      className="hw-nav"
      aria-current={on ? 'page' : undefined}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 12px', borderRadius: 8, width: '100%', boxSizing: 'border-box',
        border: 0, background: on ? V.tint : 'transparent', color: V.ink, font: 'inherit', fontSize: 15, textAlign: 'left', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <span style={{ flexGrow: 1, fontWeight: on ? 600 : 400, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count != null && count !== 0 && count !== '' && <Mono size={12} color={accentCount ? V.accentInk : V.muted}>{count}</Mono>}
    </button>
  );
}

export function schemeLabel(scheme) {
  if (scheme === 'light') return tv('hedwig.v2.scheme.light', 'Light');
  if (scheme === 'dark') return tv('hedwig.v2.scheme.dark', 'Dark');
  return tv('hedwig.v2.scheme.auto', 'Auto');
}

export const nextScheme = (s) => (s === 'auto' ? 'light' : s === 'light' ? 'dark' : 'auto');

export default function Rail() {
  const counts = useV2((s) => s.counts);
  const more = useV2((s) => s.countsMore);
  const work = useWork();
  const today = useV2((s) => s.today);
  const power = useV2((s) => s.prefs.powerMode);
  // No explicit choice yet: show (and cycle from) what the saved theme is.
  const schemeChoice = useV2((s) => s.scheme);
  const theme = useStore((s) => s.theme);
  const scheme = schemeChoice || (theme === 'hedwig-night' ? 'dark' : 'light');
  const tree = useShell((s) => s.tree);
  const openPalette = useShell((s) => s.openPalette);
  const accounts = useStore((s) => s.accounts);
  const [query, setQuery] = useState('');
  const current = currentMainView(tree);
  const on = (id, list) => current?.id === id && (!list || current.props?.list === list);

  const submit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) { openPalette?.(); return; }
    const question = /\?$/.test(q) || /^(what|when|who|where|why|how|did|does|do|is|are|was|were|can|should|which)\b/i.test(q);
    if (question && getView('hedwig.ask')) {
      useHedwig.getState().setAskPrompt(q);
      useHedwig.getState().openView('hedwig.ask', { question: q });
    } else {
      useStore.getState().setSearchQuery?.(q);
      useHedwig.getState().openView('core.list');
    }
    setQuery('');
  };

  const openAccounts = () => { const st = useStore.getState(); st.setAdminTab?.('accounts'); st.setShowAdmin?.(true); };
  const n = accounts?.length || 0;
  const failing = (accounts || []).filter((a) => a.sync_error).length;
  const moreItems = () => [
    ...layoutMenuItems(),
    { type: 'separator' },
    { id: 'scheme', label: tv('hedwig.v2.scheme.menu', 'Light or dark: {{scheme}}', { scheme: schemeLabel(scheme) }), hint: schemeLabel(nextScheme(scheme)), onSelect: () => useV2.getState().setScheme(nextScheme(scheme)) },
    { id: 'hedwig-settings', label: tv('hedwig.v2.rail.hedwigSettings', 'Hedwig settings'), icon: 'settings', onSelect: () => useHedwig.getState().openView('hedwig.settings.personal') },
    { id: 'mail-settings', label: tv('hedwig.v2.rail.mailSettings', 'Mail settings'), icon: 'settings', onSelect: () => useStore.getState().setShowAdmin?.(true) },
  ];

  return (
    <nav aria-label={tv('hedwig.v2.rail.label', 'Streams')} className="hw-v2 hw-scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: '26px 14px 20px', overflowY: 'auto', color: V.ink, fontFamily: V.sans }}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 12px 22px' }}>
        <span style={{ fontFamily: V.serif, fontSize: 30, lineHeight: 1, letterSpacing: '-0.01em', flexGrow: 1 }}>{tv('hedwig.v2.brand', 'Hedwig')}</span>
        <MenuButton label={tv('hedwig.v2.rail.more', 'Layout and settings')} items={moreItems} width={260} buttonClassName="hw-btn-quiet"
          buttonStyle={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 0, background: 'transparent', color: V.muted, cursor: 'pointer', padding: 0 }}
        >
          <Glyph name="more" size={18} />
        </MenuButton>
      </div>
      <form onSubmit={submit} style={{ margin: '0 0 14px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 12px', borderBottom: `1px solid ${V.line2}`, color: V.muted, fontSize: 14 }}>
          <Glyph name="search" size={18} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tv('hedwig.v2.searchOrAsk', 'Search or ask')}
            aria-label={tv('hedwig.v2.searchOrAsk', 'Search or ask')}
            style={{ flexGrow: 1, minWidth: 0, border: 0, background: 'transparent', font: 'inherit', color: V.ink, outline: 'none' }}
          />
          <button type="button" onClick={() => openPalette?.()} aria-label={tv('hedwig.v2.rail.palette', 'Open the command palette')} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
            style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: V.muted, fontFamily: V.mono, fontSize: 11 }}
          >
            {isMac ? '⌘K' : 'Ctrl K'}
          </button>
        </label>
      </form>
      <NavItem label={tv('hedwig.v2.rail.screener', 'Screener')} count={countText(counts, more, 'screener')} accentCount on={on(VIEW.screener)} onClick={() => showView(VIEW.screener)} />
      <NavItem label={tv('hedwig.v2.stream.people', 'People')} count={countText(counts, more, 'people')} on={on(VIEW.people)} onClick={() => showView(VIEW.people)} />
      <NavItem label={tv('hedwig.v2.stream.reading', 'Reading')} count={countText(counts, more, 'reading')} on={on(VIEW.reading)} onClick={() => showView(VIEW.reading)} />
      <NavItem label={tv('hedwig.v2.stream.records', 'Records')} count={countText(counts, more, 'records')} on={on(VIEW.records)} onClick={() => showView(VIEW.records)} />
      <Hair style={{ margin: '12px 12px' }} />
      {work && (
        <>
          <NavItem label={tv('hedwig.v2.rail.replyLater', 'Reply Later')} count={countText(counts, more, 'replyLater')} on={on(VIEW.list, 'replyLater')} onClick={() => showView(VIEW.list, { list: 'replyLater' })} />
          <NavItem label={tv('hedwig.v2.rail.setAside', 'Set Aside')} count={countText(counts, more, 'setAside')} on={on(VIEW.list, 'setAside')} onClick={() => showView(VIEW.list, { list: 'setAside' })} />
          <NavItem label={tv('hedwig.v2.rail.snoozed', 'Snoozed')} count={countText(counts, more, 'snoozed')} on={on(VIEW.list, 'snoozed')} onClick={() => showView(VIEW.list, { list: 'snoozed' })} />
        </>
      )}
      <NavItem label={tv('hedwig.v2.rail.brief', 'Daily Brief')} on={on(VIEW.brief)} onClick={() => showView(VIEW.brief)} />
      <div style={{ flexGrow: 1, minHeight: 16 }} />
      {today && (
        <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Why>{todayLine(today)}</Why>
          <LinkBtn style={{ alignSelf: 'flex-start' }} onClick={() => showView(VIEW.today)}>{tv('hedwig.v2.today.review', 'Review or undo')}</LinkBtn>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 12px 0', flexWrap: 'wrap' }}>
        {(accounts || []).slice(0, 5).map((a, i) => (
          <span key={a.id} aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: a.sync_error ? V.red : (i === 0 ? V.ink : (a.color || V.accent)) }} />
        ))}
        <button type="button" className="hw-link" onClick={openAccounts} style={{ font: 'inherit', fontSize: 12, color: failing ? V.red : V.muted, flexGrow: 1, textAlign: 'left', border: 0, background: 'none', padding: 0, cursor: 'pointer', textDecorationColor: 'transparent' }}>
          {failing
            ? tv('hedwig.v2.rail.accountsFailing', '{{n}} of {{total}} need attention', { n: failing, total: n })
            : tv('hedwig.v2.rail.accounts', '{{n}} accounts', { n })}
        </button>
        <LinkBtn
          muted={!power}
          aria-pressed={power}
          onClick={() => useV2.getState().togglePower()}
          title={tv('hedwig.v2.power.hint', 'Power shows rules, routing, prompts and index status')}
          style={{ fontSize: 12, fontWeight: power ? 600 : 500 }}
        >
          {tv('hedwig.v2.power.label', 'Power')}
        </LinkBtn>
      </div>
    </nav>
  );
}
