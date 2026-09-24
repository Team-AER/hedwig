// hedwig.people — searchable directory of people and organisations, most recent first.
import { useId, useMemo, useState } from 'react';
import { useHedwig } from '../store.js';
import { formatCount } from './helpers.js';
import { isTypingTarget, useDebounced, useResource } from './hooks.js';
import { Avatar, Chip, Empty, Loading, Pill, RelativeTime, NUM, StateView, T, TextInput } from './ui.jsx';
import { tr } from './i18n.js';

const KINDS = [{ id: '', label: 'All' }, { id: 'person', label: 'People' }, { id: 'org', label: 'Organisations' }];

export default function People() {
  const inputId = useId();
  const selectedEntityId = useHedwig((s) => s.selectedEntityId);
  const setSelectedEntity = useHedwig((s) => s.setSelectedEntity);
  const openView = useHedwig((s) => s.openView);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 250);
  const qs = new URLSearchParams({ limit: '200' });
  if (dq) qs.set('q', dq);
  if (kind) qs.set('kind', kind);
  const res = useResource(`/context/entities?${qs}`);

  const rows = useMemo(() => (res.data || [])
    .filter((e) => e.kind !== 'self')
    .slice()
    .sort((a, b) => (new Date(b.last_seen || 0) - new Date(a.last_seen || 0))), [res.data]);

  const pick = (e) => {
    setSelectedEntity(e.id);
    openView('hedwig.context', { entityId: e.id });
  };

  const onKeyDown = (e) => {
    if (isTypingTarget(e) && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); pick(rows[active]); }
  };

  return (
    <section aria-label={tr('people.people', 'People')} onKeyDown={onKeyDown} style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: T.surface, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <div style={{ padding: '16px 16px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ margin: 0, fontFamily: T.display, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{tr('people.people', 'People')}</h1>
          {res.data && <span style={{ fontSize: 12, color: T.muted }}>{formatCount(rows.length)}{rows.length >= 200 ? '+' : ''} · most recent first</span>}
        </div>
        <label htmlFor={inputId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{tr('people.searchPeople', 'Search people')}</label>
        <TextInput id={inputId} type="search" value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder={tr('people.searchByNameAddressOr', 'Search by name, address or domain')} />
        <div role="group" aria-label={tr('people.kind', 'Kind')} style={{ display: 'flex', gap: 6 }}>
          {KINDS.map((k) => <Pill key={k.id} active={kind === k.id} onClick={() => { setKind(k.id); setActive(0); }}>{k.label}</Pill>)}
        </div>
      </div>
      <div role="listbox" tabIndex={0} aria-label={tr('people.people', 'People')} aria-activedescendant={rows[active] ? `hw-person-${rows[active].id}` : undefined}
        style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', outlineOffset: -2 }}>
        {res.loading && !res.data && <Loading />}
        {res.error && !res.data && <StateView error={res.error} onRetry={res.reload} what="The people directory" />}
        {res.data && !rows.length && <Empty title={dq ? 'No matches' : 'Nobody yet'}>{dq ? `Nobody matches “${dq}”.` : 'People appear as Hedwig indexes your mail.'}</Empty>}
        {rows.map((e, i) => (
          <div key={e.id} id={`hw-person-${e.id}`} role="option" aria-selected={i === active} onClick={() => { setActive(i); pick(e); }} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: `1px solid ${T.raised}`, cursor: 'pointer',
            background: i === active ? T.raised : e.id === selectedEntityId ? T.ground : 'transparent',
          }}>
            <Avatar name={e.display_name} email={e.primary_email} size={30} />
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.display_name || e.primary_email}</span>
                {e.kind === 'org' && <Chip tone="teal">org</Chip>}
                {e.is_bulk && <Chip>bulk</Chip>}
              </span>
              <span style={{ fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.kind === 'org' ? e.domain : e.primary_email}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontSize: 12, color: T.muted, flexShrink: 0 }}>
              <span><strong style={{ ...NUM, fontWeight: 600, color: T.ink }}>{formatCount(e.message_count)}</strong> mails</span>
              <RelativeTime value={e.last_seen} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
