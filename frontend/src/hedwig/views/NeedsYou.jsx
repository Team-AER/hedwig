// hedwig.needs — the ranked triage list ("Needs you", "Waiting on", …) with reason chips.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { TRIAGE_CATEGORIES, categoryLabel, senderName, triageReason } from './helpers.js';
import { isTypingTarget, openMessage, selectSenderEntity, useAction, useResource } from './hooks.js';
import Explainer, { MoveMenu, overrideTriage } from './Explainer.jsx';
import {
  AccountDot, ActionError, Button, Empty, IconButton, KeyHints, Loading, Pill, ReasonChip, RelativeTime, Select, NUM, StateView, T,
} from './ui.jsx';
import { tr } from './i18n.js';

const PAGE = 50;

export default function NeedsYou({ props = {} }) {
  const filter = useHedwig((s) => s.triageFilter) || 'needs_you';
  const setFilter = useHedwig((s) => s.setTriageFilter);
  const openView = useHedwig((s) => s.openView);
  const accounts = useStore((s) => s.accounts);
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const [accountId, setAccountId] = useState(props.accountId || '');
  const [extra, setExtra] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(null); // { id, kind: 'why'|'move' }
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const listRef = useRef(null);

  useEffect(() => { if (props.view) setFilter(props.view); }, [props.view, setFilter]);

  const qs = new URLSearchParams({ view: filter, limit: String(PAGE) });
  if (accountId) qs.set('accountId', accountId);
  const path = `/triage/list?${qs}`;
  const res = useResource(path, { pollMs: 30_000, refreshOn: ['mailflow:refresh', 'hedwig:triage-changed'] });

  useEffect(() => { setExtra([]); setHidden(new Set()); setNoMore(false); setActive(0); setExpanded(null); }, [path]);

  const items = useMemo(() => {
    const seen = new Set();
    return [...(res.data?.items || []), ...extra].filter((it) => {
      const id = it?.message?.id;
      if (!id || seen.has(id) || hidden.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [res.data, extra, hidden]);
  const counts = res.data?.counts || {};

  // Keep the highlight on the open message when it is in this list.
  useEffect(() => {
    const i = items.findIndex((it) => it.message.id === selectedMessageId);
    if (i >= 0) setActive(i);
  }, [selectedMessageId, items]);

  const accountCount = useMemo(() => new Set(items.map((it) => it.message.account_id)).size, [items]);

  const open = useCallback((i) => {
    const it = items[i];
    if (!it) return;
    setActive(i);
    openMessage(it.message.id, { lite: it.message });
    selectSenderEntity(it.message.from_email);
  }, [items]);

  const removeLocally = (id) => {
    setHidden((h) => new Set(h).add(id));
    setExpanded(null);
  };

  const resolveAct = useAction(async (it) => {
    await hedwigApi.post(`/triage/messages/${encodeURIComponent(it.message.id)}/resolve`);
    removeLocally(it.message.id);
  });
  const moveAct = useAction(async (it, category) => {
    await overrideTriage(it.message.id, category, category === 'everything' ? 'not for me' : undefined);
    if (category !== filter) removeLocally(it.message.id);
    else setExpanded(null);
  });

  const loadMore = async () => {
    const last = items[items.length - 1]?.message;
    if (!last) return;
    setLoadingMore(true);
    try {
      const q = new URLSearchParams(qs);
      q.set('before', last.date);
      const more = await hedwigApi.get(`/triage/list?${q}`);
      const got = more?.items || [];
      setExtra((e) => [...e, ...got]);
      if (got.length < PAGE) setNoMore(true);
    } catch {
      setNoMore(true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Debounced open while moving with j/k so the reader follows the highlight without thrashing.
  const moveTimer = useRef(null);
  useEffect(() => () => clearTimeout(moveTimer.current), []);
  const moveTo = (i) => {
    const n = Math.max(0, Math.min(items.length - 1, i));
    setActive(n);
    document.getElementById(`hw-needs-row-${items[n]?.message.id}`)?.scrollIntoView({ block: 'nearest' });
    clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => open(n), 180);
  };

  const onKeyDown = (e) => {
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const it = items[active];
    switch (e.key) {
      case 'j': case 'ArrowDown': e.preventDefault(); moveTo(active + 1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); moveTo(active - 1); break;
      case 'Enter': if (it) { e.preventDefault(); open(active); } break;
      case 'e': if (it) { e.preventDefault(); resolveAct.run(it); } break;
      case 'x': if (it) { e.preventDefault(); moveAct.run(it, 'everything'); } break;
      case 'm': if (it) { e.preventDefault(); setExpanded((x) => (x?.id === it.message.id && x.kind === 'move' ? null : { id: it.message.id, kind: 'move' })); } break;
      case '?': if (it) { e.preventDefault(); setExpanded((x) => (x?.id === it.message.id && x.kind === 'why' ? null : { id: it.message.id, kind: 'why' })); } break;
      case 'Escape': if (expanded) { e.preventDefault(); setExpanded(null); } break;
      default:
    }
  };

  const allZero = res.data && TRIAGE_CATEGORIES.every((c) => !counts[c.id]);

  return (
    <section aria-label={categoryLabel(filter)} style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: T.surface, color: T.ink,
      fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '16px 16px 10px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontFamily: T.display, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{categoryLabel(filter)}</h1>
        <span style={{ fontSize: 12, color: T.muted }}>
          {res.data ? `${counts[filter] ?? items.length} across ${accountCount || 0} account${accountCount === 1 ? '' : 's'}${filter === 'needs_you' ? ' · ranked' : ''}` : ''}
        </span>
        <span style={{ flexGrow: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.muted }}>
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{tr('needsYou.account', 'Account')}</span>
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ height: 28, fontSize: 12 }} aria-label={tr('needsYou.filterByAccount', 'Filter by account')}>
            <option value="">{tr('needsYou.allAccounts', 'All accounts')}</option>
            {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name || a.email || a.email_address}</option>)}
          </Select>
        </label>
      </div>
      <div role="group" aria-label={tr('needsYou.category', 'Category')} className="hw-scroll" style={{ display: 'flex', gap: 6, padding: '0 16px 10px', overflowX: 'auto', flexShrink: 0 }}>
        {TRIAGE_CATEGORIES.map((c) => (
          <Pill key={c.id} active={filter === c.id} count={res.data ? counts[c.id] ?? 0 : undefined} onClick={() => setFilter(c.id)}>
            {c.label}
          </Pill>
        ))}
      </div>

      <ActionError error={resolveAct.error || moveAct.error} onDismiss={() => { resolveAct.clearError(); moveAct.clearError(); }} />

      <div ref={listRef} role="listbox" tabIndex={0} aria-label={`${categoryLabel(filter)} messages`}
        aria-activedescendant={items[active] ? `hw-needs-row-${items[active].message.id}` : undefined}
        onKeyDown={onKeyDown}
        style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', outlineOffset: -2 }}>
        {res.loading && !res.data && <Loading label="Loading your triage…" />}
        {res.error && !res.data && <StateView error={res.error} onRetry={res.reload} what="Triage" />}
        {res.data && !items.length && (allZero ? (
          <Empty title={tr('needsYou.hedwigIsStillReadingYour', 'Hedwig is still reading your mail')}>
            Triage fills in as the index catches up. New mail is sorted within a few seconds of arriving; older mail is backfilled in the background.
          </Empty>
        ) : (
          <Empty title={filter === 'needs_you' ? 'Nothing needs you' : `Nothing in ${categoryLabel(filter)}`}>
            {filter === 'needs_you'
              ? `You are clear. ${counts.waiting_on ? `${counts.waiting_on} thread${counts.waiting_on === 1 ? ' is' : 's are'} waiting on someone else.` : ''}`
              : 'Messages show up here as triage files them.'}
          </Empty>
        ))}
        {items.map((it, i) => (
          <Row key={it.message.id} item={it} active={i === active} open={selectedMessageId === it.message.id}
            expanded={expanded?.id === it.message.id ? expanded.kind : null}
            onOpen={() => { listRef.current?.focus({ preventScroll: true }); open(i); }}
            onResolve={() => resolveAct.run(it)}
            onToggle={(kind) => setExpanded((x) => (x?.id === it.message.id && x.kind === kind ? null : { id: it.message.id, kind }))}
            onMove={(cat) => moveAct.run(it, cat)}
            onCorrected={(cat) => { if (cat && cat !== filter) removeLocally(it.message.id); }}
            moving={moveAct.busy}
            onSenderRule={() => openView('hedwig.settings.triage', { senderRule: { sender: it.message.from_email, messageId: it.message.id } })}
          />
        ))}
        {items.length >= PAGE && !noMore && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button size="sm" busy={loadingMore} onClick={loadMore}>{tr('needsYou.loadMore', 'Load more')}</Button>
          </div>
        )}
      </div>
      <KeyHints hints={[['j/k', 'move'], ['↵', 'open'], ['e', 'done'], ['x', 'not for me'], ['m', 'move to'], ['?', 'why']]} />
    </section>
  );
}

function Row({ item, active, open, expanded, onOpen, onResolve, onToggle, onMove, onCorrected, moving, onSenderRule }) {
  const { message, triage, thread } = item;
  const { chip, why } = triageReason(triage);
  const [hover, setHover] = useState(false);
  const showActions = hover || active;
  return (
    <div id={`hw-needs-row-${message.id}`} role="option" aria-selected={active}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ borderTop: `1px solid ${T.raised}`, background: active ? T.raised : open ? T.ground : 'transparent' }}>
      <div style={{ display: 'flex', gap: 10, padding: '12px 16px', position: 'relative' }}>
        <span style={{ marginTop: 5 }}><AccountDot account={message.account} /></span>
        <div onClick={onOpen} style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: message.is_read ? 500 : 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {senderName(message)}
            </span>
            {thread?.count > 1 && <span style={{ ...NUM, fontSize: 11, color: T.muted }}>{thread.count}</span>}
            <span style={{ flexGrow: 1 }} />
            <RelativeTime value={message.date} style={{ fontSize: 12, color: T.muted }} />
          </div>
          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{message.subject || '(no subject)'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, minWidth: 0 }}>
            <ReasonChip triage={triage}>{chip}</ReasonChip>
            {triage?.overridden && <span style={{ fontSize: 11, color: T.muted }}>corrected</span>}
            {why && <span style={{ fontSize: 11, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{why}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-start', opacity: showActions || expanded ? 1 : 0, transition: 'opacity 0.1s' }}>
          <IconButton label="Done (e)" icon="check" onClick={onResolve} tabIndex={-1} />
          <IconButton label="Why is this here? (?)" icon="help" onClick={() => onToggle('why')} active={expanded === 'why'} tabIndex={-1} />
          <IconButton label="Move to… (m)" icon="more" onClick={() => onToggle('move')} active={expanded === 'move'} tabIndex={-1} />
        </div>
      </div>
      {expanded === 'why' && (
        <div style={{ padding: '0 16px 12px 36px' }}>
          <Explainer messageId={message.id} message={message} onSenderRule={onSenderRule}
            onChanged={(info) => onCorrected(info?.category)} />
        </div>
      )}
      {expanded === 'move' && (
        <div style={{ padding: '0 16px 12px 36px' }}>
          <MoveMenu current={triage?.category} onPick={onMove} busy={moving} />
        </div>
      )}
    </div>
  );
}
