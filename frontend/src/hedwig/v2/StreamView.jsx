// People, Reading and Records (GET /sort/stream/:stream). Needs you on top with Hedwig's reasons
// in italic accent (its own needsYou=1 list, so it is complete however long the stream is), then
// the rest by day, a page at a time with "Show more"; Records collapses each bundle to one line
// with a summary. People has the Reply Later footer on desktop; on a phone it carries the day's
// first question (on desktop the question lives in the Daily Brief).
import { useMemo, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2, streamPath, countText } from './state.js';
import { useV2Resource, useV2Pages, useWork } from './hooks.js';
import { listOf, SORT_EVENTS, COUNTS_EVENT, announceSortChange } from './client.js';
import { openThread, showView, VIEW } from './nav.js';
import { markRead, LIST_KIND } from './mail.js';
import { useWhyDoor } from './WhyDoor.jsx';
import { Question } from './Question.jsx';
import { StreamRow, GroupLabel, onListKeyDown } from './rows.jsx';
import { Figure, Glyph, Hair, IconBtn, LinkBtn, Mono, Quiet, ErrorLine, TextTabs, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { groupBundles, groupLabel, listTime, splitStream } from './format.js';
import { tv, tvn } from './i18n.js';
import { bundleCardSummary, cardFigure, cardsByMessage, cardsForItems } from './cards.js';
import { LEDGER_KINDS, SIMPLE_LEDGERS, ledgerTitle } from './Ledger.jsx';
import { useShell } from '../shell/state.js';

export function streamTitle(stream) {
  if (stream === 'reading') return tv('hedwig.v2.stream.reading', 'Reading');
  if (stream === 'records') return tv('hedwig.v2.stream.records', 'Records');
  return tv('hedwig.v2.stream.people', 'People');
}

function useQuestions(enabled) {
  const res = useV2Resource(enabled ? '/labels/questions' : null);
  const [done, setDone] = useState([]);
  const list = listOf(res.data, 'questions').filter((q) => !done.includes(q.id));
  return { list, total: listOf(res.data, 'questions').length, onDone: (id) => setDone((d) => [...d, id]), error: res.error };
}

function Rows({ items, stream, phone, onWhy }) {
  return items.map((it, i) => (
    <div key={it.messageId || i}>
      {i > 0 && <Hair inset={phone ? 0 : 12} />}
      <StreamRow item={it} stream={stream} phone={phone} onOpen={openThread} onWhy={onWhy} />
    </div>
  ));
}

function BundleGroup({ group, phone, onWhy, open, onToggle, cards = [] }) {
  const label = open ? tv('hedwig.v2.records.hide', 'Hide') : tv('hedwig.v2.records.show', 'Show');
  // The bundle's cards say more than its senders: "2 deliveries, 1 arriving today", and the first
  // few as figures while the bundle is closed.
  const cardLine = bundleCardSummary(cards);
  const figures = open ? [] : cards.slice(0, phone ? 2 : 3).map((c) => ({ id: c.id, ...cardFigure(c) })).filter((f) => f.figure);
  return (
    <div>
      <button
        type="button"
        className="hw-row"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: 'grid', gridTemplateColumns: `${phone ? 12 : 14}px minmax(0, 1fr) auto`, columnGap: 10, alignItems: 'baseline', width: '100%',
          padding: '14px 12px', borderRadius: 12, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', minHeight: 44,
        }}
      >
        <span aria-hidden="true" style={{ alignSelf: 'center', width: 7, height: 7, borderRadius: '50%', background: group.unread ? V.accent : 'transparent' }} />
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <span style={{ fontFamily: V.serif, fontSize: 20, lineHeight: 1.1, whiteSpace: 'nowrap' }}>{group.name}</span>
          <Mono size={12}>{group.items.length}</Mono>
        </span>
        <span style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <Mono>{listTime(group.latest)}</Mono>
          <span className="hw-link" style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        </span>
        <span />
        <span style={{ gridColumn: '2 / 4', paddingTop: 3, fontSize: 14, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {cardLine ? `${cardLine} · ${group.summary}` : `${group.summary}${group.items[0]?.subject ? ` · ${group.items[0].subject}` : ''}`}
        </span>
        {figures.length > 0 && (
          <span style={{ gridColumn: '2 / 4', display: 'grid', gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))`, paddingTop: 12 }}>
            {figures.map((f, i) => (
              <span key={f.id} style={{ padding: i === 0 ? '0 14px 0 0' : '0 14px', borderLeft: i === 0 ? 0 : `1px solid ${V.line2}`, minWidth: 0 }}>
                <Figure value={f.figure} caption={f.caption} size={phone ? 22 : 24} />
              </span>
            ))}
          </span>
        )}
      </button>
      {open && <div style={{ paddingLeft: phone ? 8 : 16 }}><Rows items={group.items} stream="records" phone={phone} onWhy={onWhy} /></div>}
    </div>
  );
}

const LIST_EVENTS = [...SORT_EVENTS, COUNTS_EVENT];

function MoreButton({ pages, phone }) {
  if (!pages.next) return null;
  return (
    <div style={{ padding: '10px 12px 4px' }}>
      <LinkBtn hit={phone} disabled={pages.loadingMore} onClick={() => pages.loadMore()}>
        {pages.loadingMore ? tv('hedwig.v2.loading', 'Loading…') : tv('hedwig.v2.stream.more', 'Show more')}
      </LinkBtn>
    </div>
  );
}

export default function StreamView({ props }) {
  const stream = props?.stream || 'people';
  const phoneCtx = usePhone();
  const phone = Boolean(phoneCtx?.phone);
  const work = useWork();
  // Both lists reload on a sort change and when the background counts poll sees new mail.
  const needsRes = useV2Pages(streamPath(stream, { needsYou: true }), { refreshOn: LIST_EVENTS });
  const res = useV2Pages(streamPath(stream), { refreshOn: LIST_EVENTS });
  const bundles = useV2Resource(stream === 'records' ? '/sort/bundles' : null);
  const cardsRes = useV2Resource(stream === 'records' ? '/cards?limit=200' : null);
  const byMessage = useMemo(() => cardsByMessage(listOf(cardsRes.data, 'cards')), [cardsRes.data]);
  const power = useV2((s) => s.prefs.powerMode);
  const replyLaterCount = useV2((s) => s.counts.replyLater);
  const needsCount = useV2((s) => countText(s.counts, s.countsMore, 'people'));
  const questions = useQuestions(stream === 'people' && phone);
  const door = useWhyDoor();
  const [tab, setTab] = useState('needs');
  const [openBundles, setOpenBundles] = useState({});
  const [sweeping, setSweeping] = useState(false);
  const openPalette = useShell((s) => s.openPalette);

  const needs = useMemo(() => needsRes.items.filter((i) => i.needsYou), [needsRes.items]);
  const rest = useMemo(() => res.items.filter((i) => !i.needsYou), [res.items]);
  const items = useMemo(() => [...needs, ...rest], [needs, rest]);
  const { groups } = useMemo(() => splitStream(rest), [rest]);
  const bundleGroups = useMemo(() => (stream === 'records' ? groupBundles(rest, listOf(bundles.data, 'bundles')) : []), [stream, rest, bundles.data]);
  const todayCount = groups.find((g) => g.key === 'today')?.items.length || 0;
  const unread = items.filter((i) => i.unread).length;
  const title = streamTitle(stream);

  let sub;
  if (stream === 'people') {
    // The server-side count when there is one (the rail's), else what the Needs you list holds.
    const n = needsCount ? Number.parseInt(needsCount, 10) : needs.length;
    const shown = needsCount && needsCount.endsWith('+') ? needsCount : n;
    sub = [
      n ? tvn(n, ['hedwig.v2.people.needYouOne', '{{n}} needs you'], ['hedwig.v2.people.needYouMany', '{{n}} need you'], { n: shown }) : null,
      todayCount ? tv('hedwig.v2.people.today', '{{n}} today', { n: todayCount + (res.next ? '+' : '') }) : null,
    ].filter(Boolean).join(' · ');
  } else {
    sub = unread ? tv('hedwig.v2.stream.unread', '{{n}} unread', { n: `${unread}${res.next ? '+' : ''}` }) : null;
  }

  const sweep = async () => {
    const ids = rest.filter((i) => i.unread && i.messageId).map((i) => i.messageId);
    if (!ids.length) return;
    setSweeping(true);
    try {
      await markRead(ids);
      res.setItems((list) => list.map((i) => (ids.includes(i.messageId) ? { ...i, unread: false } : i)));
      announceSortChange({ read: ids.length });
    } catch (e) {
      useStore.getState().addNotification?.({ type: 'error', title: tv('hedwig.v2.stream.sweepFailed', 'Could not mark them read'), body: e.message });
    } finally {
      setSweeping(false);
    }
  };

  const searchBtn = phone
    ? <IconBtn label={tv('hedwig.v2.searchOrAsk', 'Search or ask')} onClick={() => openPalette?.()}><Glyph name="search" /></IconBtn>
    : null;
  const actions = phone
    ? searchBtn
    : <LinkBtn onClick={sweep} disabled={sweeping || !rest.some((i) => i.unread)} title={tv('hedwig.v2.stream.sweepHint', 'Mark everything that does not need you as read')}>{tv('hedwig.v2.stream.sweep', 'Sweep')}</LinkBtn>;

  const phoneTabs = phone && stream === 'people'
    ? (
      <TextTabs
        label={tv('hedwig.v2.people.filter', 'Show')}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'needs', label: tv('hedwig.v2.people.needsYou', 'Needs you') },
          { id: 'all', label: tv('hedwig.v2.people.all', 'All') },
          ...(work ? [{ id: 'later', label: tv('hedwig.v2.rail.replyLater', 'Reply Later') }] : []),
        ]}
      />
    )
    : null;

  const showNeedsOnly = phone && stream === 'people' && tab === 'needs';
  const error = res.error || needsRes.error;
  const loading = (res.loading && !res.loaded) || (needsRes.loading && !needsRes.loaded);
  const question = questions.list[0];
  const retry = () => { res.reload(); needsRes.reload(); };

  const content = (
    <div onKeyDown={onListKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {error && <ErrorLine error={error} onRetry={retry} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {loading && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {!loading && !error && !items.length && (
        <Quiet><Why>{stream === 'people' ? tv('hedwig.v2.people.empty', 'Nobody is waiting on you.') : tv('hedwig.v2.stream.empty', 'Nothing here right now.')}</Why></Quiet>
      )}
      {needs.length > 0 && (
        <section aria-label={tv('hedwig.v2.people.needsYou', 'Needs you')}>
          <GroupLabel tone="accent" first phone={phone}>{tv('hedwig.v2.people.needsYou', 'Needs you')}</GroupLabel>
          <Rows items={needs} stream={stream} phone={phone} onWhy={door.open} />
          <MoreButton pages={needsRes} phone={phone} />
        </section>
      )}
      {question && phone && stream === 'people' && !showNeedsOnly && (
        <div style={{ padding: '16px 0 4px' }}>
          <Question question={question} index={questions.total - questions.list.length} total={questions.total} onDone={questions.onDone} compact phone />
        </div>
      )}
      {!showNeedsOnly && stream !== 'records' && groups.map((g) => (
        <section key={g.key} aria-label={groupLabel(g.key)}>
          <GroupLabel first={!needs.length && g === groups[0]} phone={phone}>{groupLabel(g.key)}</GroupLabel>
          <Rows items={g.items} stream={stream} phone={phone} onWhy={door.open} />
        </section>
      ))}
      {stream === 'records' && bundleGroups.map((g, i) => (
        <section key={g.key || 'none'} aria-label={g.name}>
          {(i > 0 || needs.length > 0) && <Hair inset={phone ? 0 : 12} />}
          <BundleGroup group={g} phone={phone} onWhy={door.open} cards={cardsForItems(g.items, byMessage)} open={Boolean(openBundles[g.key])} onToggle={() => setOpenBundles((o) => ({ ...o, [g.key]: !o[g.key] }))} />
        </section>
      ))}
      {!showNeedsOnly && <MoreButton pages={res} phone={phone} />}
      {showNeedsOnly && !needs.length && !loading && items.length > 0 && <Quiet><Why>{tv('hedwig.v2.people.empty', 'Nobody is waiting on you.')}</Why></Quiet>}
    </div>
  );

  if (phone && stream === 'people' && tab === 'later' && work) {
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub} actions={searchBtn}>{phoneTabs}</ViewHead>
        <div style={{ padding: '0 16px' }}><ListItems list="replyLater" phone /></div>
      </ViewBody>
    );
  }

  if (phone) {
    // On a phone the rail is not there: Records carries its ledgers in the header.
    const ledgerLinks = stream === 'records'
      ? (
        <nav aria-label={tv('hedwig.v2.ledger.label', 'Ledgers')} style={{ display: 'flex', gap: 18, flexWrap: 'wrap', paddingBottom: 6 }}>
          {(power ? LEDGER_KINDS : SIMPLE_LEDGERS).map((kind) => (
            <LinkBtn key={kind} style={{ minHeight: 44 }} onClick={() => showView(VIEW.ledger, { kind })}>{ledgerTitle(kind)}</LinkBtn>
          ))}
        </nav>
      )
      : null;
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub} actions={actions}>{phoneTabs || ledgerLinks}</ViewHead>
        <div style={{ padding: '0 16px', flex: '1 0 auto' }}>{content}</div>
        {door.element}
      </ViewBody>
    );
  }

  // Desktop: the header and the Reply Later footer stay put; only the list scrolls.
  return (
    <ViewBody label={title} padded={false} style={{ overflowY: 'hidden', padding: '26px 14px 0' }}>
      <ViewHead title={title} sub={sub} actions={actions} />
      <div className="hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -14px', padding: '0 14px 16px' }}>{content}</div>
      {stream === 'people' && work && (
        <div style={{ flexShrink: 0, paddingBottom: 16 }}>
          <Hair inset={12} style={{ marginBottom: 10 }} />
          <button
            type="button"
            onClick={() => showView(VIEW.list, { list: 'replyLater' })}
            style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 12px 6px', textAlign: 'left', width: '100%', boxSizing: 'border-box', border: 0, background: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
          >
            <span style={{ fontFamily: V.serif, fontSize: 20 }}>{tv('hedwig.v2.rail.replyLater', 'Reply Later')}</span>
            <Mono size={12}>{replyLaterCount ?? ''}</Mono>
            <span style={{ flexGrow: 1 }} />
            <span className="hw-link" style={{ fontSize: 13, fontWeight: 500 }}>{tv('hedwig.v2.people.focusReply', 'Focus and Reply')}</span>
          </button>
        </div>
      )}
      {door.element}
    </ViewBody>
  );
}

/** GET /work/lists/:kind for one of the user's lists. */
export const listPath = (list) => `/work/lists/${LIST_KIND[list] || list}`;

/** Items in one of the user's lists (Reply Later, Set Aside, Snoozed). */
export function ListItems({ list, phone }) {
  const res = useV2Resource(listPath(list));
  const door = useWhyDoor();
  const items = listOf(res.data, 'items');
  if (res.error?.status === 404) return <Quiet><Why>{tv('hedwig.v2.list.unavailable', 'This list is not available yet.')}</Why></Quiet>;
  return (
    <div onKeyDown={onListKeyDown}>
      {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {!res.loading && !res.error && !items.length && <Quiet><Why>{tv('hedwig.v2.list.empty', 'Nothing in this list.')}</Why></Quiet>}
      <Rows items={items} phone={phone} onWhy={door.open} />
      {door.element}
    </div>
  );
}
