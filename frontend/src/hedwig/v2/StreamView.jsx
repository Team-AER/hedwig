// People, Reading and Records (GET /sort/stream/:stream) as the message list (DESIGN-AUDIT-2026-09-24
// §b). The header block holds the search field, then the title with "N · M unread" and the filter
// menu (Unread, Needs you, Has attachments, sort, and "Mark the rest read"). Needs you comes first
// with Hedwig's reasons (its own needsYou=1 list, so it is complete however long the stream is),
// then the rest under sticky date headers, a page at a time with "Show more"; Records collapses each
// bundle to one row with a summary. People has the Reply Later footer on desktop; on a phone it
// carries the day's first question (on desktop the question lives in the Daily Brief).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useV2, streamPath, countText, liveRows } from './state.js';
import { useV2Resource, useV2Pages, useWork, isMissing } from './hooks.js';
import { useTldrs, withTldrs } from './tldrs.js';
import { listOf, SORT_EVENTS, COUNTS_EVENT } from './client.js';
import { openThread, showView, VIEW } from './nav.js';
import { LIST_KIND } from './mail.js';
import { performAction } from './actions.js';
import { useWhyDoor } from './WhyDoor.jsx';
import { Question } from './Question.jsx';
import { RowList, GroupLabel, ListSearch, onListKeyDown, rowDate, rowMeta, useFirstRowKeys } from './rows.jsx';
import { Figure, Hair, LinkBtn, Num, Quiet, ErrorLine, TextTabs, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { MenuButton } from '../shell/Menu.jsx';
import { groupBundles, groupLabel, splitStream } from './format.js';
import { tv } from './i18n.js';
import { bundleCardSummary, cardFigure, cardsByMessage, cardsForItems } from './cards.js';
import { LEDGER_KINDS, SIMPLE_LEDGERS, ledgerTitle } from './Ledger.jsx';

export function streamTitle(stream) {
  if (stream === 'reading') return tv('hedwig.v2.stream.reading', 'Reading');
  if (stream === 'records') return tv('hedwig.v2.stream.records', 'Records');
  return tv('hedwig.v2.stream.people', 'People');
}

/** "24 · 3 unread", "24", "100+ · 12 unread". */
export function listCountLine(n, unread, more = false) {
  if (!n) return null;
  const total = `${n}${more ? '+' : ''}`;
  return unread ? tv('hedwig.v2.list.countUnread', '{{n}} · {{m}} unread', { n: total, m: unread }) : total;
}

/** The filter menu's choices applied to a list of items. Pure. */
export function applyListFilter(items, f) {
  return (items || []).filter((i) => (!f.unread || i.unread) && (!f.needs || i.needsYou) && (!f.attachments || rowMeta(i).attachments));
}

const BUNDLE_ICONS = { deliveries: 'package', bills: 'receipt', travel: 'plane', notifications: 'bell', receipts: 'shopping-bag', purchases: 'shopping-bag', subscriptions: 'repeat' };
export const bundleIcon = (key) => BUNDLE_ICONS[key] || (key ? 'receipt' : 'mail');

function useQuestions(enabled) {
  const res = useV2Resource(enabled ? '/labels/questions' : null);
  const [done, setDone] = useState([]);
  const list = listOf(res.data, 'questions').filter((q) => !done.includes(q.id));
  return { list, total: listOf(res.data, 'questions').length, onDone: (id) => setDone((d) => [...d, id]), error: res.error };
}

function Rows({ items, stream, list, phone, onWhy }) {
  return <RowList items={items} stream={stream} list={list} phone={phone} onWhy={onWhy} onOpen={openThread} />;
}

function BundleGroup({ group, phone, onWhy, open, onToggle, cards = [] }) {
  // The bundle's cards say more than its senders: "2 deliveries, 1 arriving today", and the first
  // few as figures while the bundle is closed.
  const cardLine = bundleCardSummary(cards);
  const figures = open ? [] : cards.slice(0, phone ? 2 : 3).map((c) => ({ id: c.id, ...cardFigure(c) })).filter((f) => f.figure);
  const tile = phone ? 40 : 36;
  return (
    <div>
      <button
        type="button"
        className="hw-row"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: 'grid', gridTemplateColumns: `8px ${tile}px minmax(0, 1fr) 16px`, columnGap: 10, alignItems: 'start', width: '100%', boxSizing: 'border-box',
          padding: phone ? '12px 8px' : '10px 14px 10px 8px', borderRadius: 8, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', minHeight: phone ? 64 : 56,
        }}
      >
        <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: phone ? 6 : 4, borderRadius: '50%', background: group.unread ? V.attention : 'transparent' }} />
        <span aria-hidden="true" style={{ width: tile, height: tile, borderRadius: 8, background: V.field, color: V.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={bundleIcon(group.key)} size={phone ? 20 : 18} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '16px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.name}</span>
            <Num size={phone ? 13 : 11}>{group.items.length}</Num>
            <span style={{ flexGrow: 1 }} />
            <Num size={phone ? 13 : 11}>{rowDate(group.latest)}</Num>
          </span>
          <span style={{ fontSize: phone ? 14 : 12, lineHeight: phone ? '19px' : '16px', color: V.muted, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {cardLine ? `${cardLine} · ${group.summary}` : `${group.summary}${group.items[0]?.subject ? ` · ${group.items[0].subject}` : ''}`}
          </span>
          {figures.length > 0 && (
            <span style={{ display: 'grid', gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))`, paddingTop: 8 }}>
              {figures.map((f, i) => (
                <span key={f.id} style={{ padding: i === 0 ? '0 12px 0 0' : '0 12px', borderLeft: i === 0 ? 0 : `1px solid ${V.line}`, minWidth: 0 }}>
                  <Figure value={f.figure} caption={f.caption} size={17} />
                </span>
              ))}
            </span>
          )}
        </span>
        <span aria-hidden="true" style={{ alignSelf: 'center', color: V.muted, display: 'inline-flex' }}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
        </span>
      </button>
      {open && <div style={{ paddingLeft: phone ? 12 : 20 }}><Rows items={group.items} stream="records" phone={phone} onWhy={onWhy} /></div>}
    </div>
  );
}

const LIST_EVENTS = [...SORT_EVENTS, COUNTS_EVENT];

/**
 * Cards for the Records rows on screen: GET /cards/messages?ids=… → { cards: { [messageId]: Card[] } }
 * in one call; a server without that route answers GET /cards?limit=200 instead.
 */
function useRowCards(enabled, ids) {
  const perRow = useV2Resource(enabled && ids ? `/cards/messages?ids=${ids}` : null);
  const older = useV2Resource(enabled && isMissing(perRow.error) ? '/cards?limit=200' : null);
  return useMemo(() => {
    const map = perRow.data?.cards && typeof perRow.data.cards === 'object' && !Array.isArray(perRow.data.cards) ? perRow.data.cards : null;
    if (map) return cardsByMessage(Object.values(map).flat().filter(Boolean));
    return cardsByMessage(listOf(older.data, 'cards'));
  }, [perRow.data, older.data]);
}

function MoreButton({ pages, phone }) {
  if (!pages.next) return null;
  return (
    <div style={{ padding: phone ? '10px 8px 4px' : '10px 10px 4px' }}>
      <LinkBtn hit={phone} disabled={pages.loadingMore} onClick={() => pages.loadMore()}>
        {pages.loadingMore ? tv('hedwig.v2.loading', 'Loading…') : tv('hedwig.v2.stream.more', 'Show more')}
      </LinkBtn>
    </div>
  );
}

const NO_FILTER = { unread: false, needs: false, attachments: false, sort: 'newest' };

/** The list-filter button and its menu (spec §b). */
export function FilterMenu({ filter, onChange, attachable = false, extra = [], phone = false }) {
  const on = filter.unread || filter.needs || filter.attachments || filter.sort !== 'newest';
  const set = (patch) => () => onChange({ ...filter, ...patch });
  const items = () => [
    { type: 'header', label: tv('hedwig.v2.filter.show', 'Show') },
    { id: 'unread', label: tv('hedwig.v2.filter.unread', 'Unread'), checked: filter.unread, onSelect: set({ unread: !filter.unread }) },
    { id: 'needs', label: tv('hedwig.v2.people.needsYou', 'Needs you'), checked: filter.needs, onSelect: set({ needs: !filter.needs }) },
    ...(attachable ? [{ id: 'attachments', label: tv('hedwig.v2.filter.attachments', 'Has attachments'), checked: filter.attachments, onSelect: set({ attachments: !filter.attachments }) }] : []),
    { type: 'separator' },
    { type: 'header', label: tv('hedwig.v2.filter.sort', 'Sort') },
    { id: 'newest', label: tv('hedwig.v2.filter.newest', 'Newest first'), checked: filter.sort === 'newest', onSelect: set({ sort: 'newest' }) },
    { id: 'oldest', label: tv('hedwig.v2.filter.oldest', 'Oldest first'), checked: filter.sort === 'oldest', onSelect: set({ sort: 'oldest' }) },
    ...(extra.length ? [{ type: 'separator' }, ...extra] : []),
  ];
  const size = phone ? 44 : 28;
  return (
    <MenuButton
      label={tv('hedwig.v2.filter.label', 'Filter and sort')}
      items={items}
      align="right"
      width={220}
      buttonClassName="hw-icon-btn"
      buttonStyle={{
        width: size, height: size, flexShrink: 0, alignSelf: 'center', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, border: 0, borderRadius: 6, background: on ? V.select : 'transparent', color: on ? V.accent : V.ink, cursor: 'pointer',
      }}
    >
      <Icon name="list-filter" size={phone ? 20 : 16} />
    </MenuButton>
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
  // Reading and Records rows get their TL;DRs in one call (People rows carry their own).
  const tldrIds = useMemo(() => (stream === 'people' ? [] : [...needsRes.items, ...res.items].filter((i) => !i.tldr && i.messageId).map((i) => i.messageId)), [stream, needsRes.items, res.items]);
  const tldrs = useTldrs(tldrIds, work);
  // What an action took away (Done, Delete, Junk, Snooze, Move) is left out at once, and flag and
  // read changes show before the lists reload (actions.js).
  const hidden = useV2((s) => s.hidden);
  const patches = useV2((s) => s.patches);
  const needsItems = useMemo(() => liveRows(withTldrs(needsRes.items, tldrs), hidden, patches), [needsRes.items, tldrs, hidden, patches]);
  const restItems = useMemo(() => liveRows(withTldrs(res.items, tldrs), hidden, patches), [res.items, tldrs, hidden, patches]);
  const cardIds = useMemo(() => (stream === 'records' ? res.items.map((i) => i.messageId).filter(Boolean).slice(0, 200).sort().join(',') : ''), [stream, res.items]);
  const byMessage = useRowCards(stream === 'records', cardIds);
  const power = useV2((s) => s.prefs.powerMode);
  const replyLaterCount = useV2((s) => s.counts.replyLater);
  const needsCount = useV2((s) => countText(s.counts, s.countsMore, 'people'));
  const questions = useQuestions(stream === 'people' && phone);
  const door = useWhyDoor();
  const [tab, setTab] = useState('needs');
  const [openBundles, setOpenBundles] = useState({});
  const [filter, setFilter] = useState(NO_FILTER);

  const allNeeds = useMemo(() => needsItems.filter((i) => i.needsYou), [needsItems]);
  const allRest = useMemo(() => restItems.filter((i) => !i.needsYou), [restItems]);
  const oldest = filter.sort === 'oldest';
  const needs = useMemo(() => {
    const list = applyListFilter(allNeeds, filter);
    return oldest ? [...list].reverse() : list;
  }, [allNeeds, filter, oldest]);
  const rest = useMemo(() => (filter.needs ? [] : applyListFilter(allRest, filter)), [allRest, filter]);
  const items = useMemo(() => [...needs, ...rest], [needs, rest]);
  const groups = useMemo(() => {
    const g = splitStream(rest).groups;
    return oldest ? g.map((x) => ({ ...x, items: [...x.items].reverse() })).reverse() : g;
  }, [rest, oldest]);
  const bundleGroups = useMemo(() => (stream === 'records' ? groupBundles(rest, listOf(bundles.data, 'bundles')) : []), [stream, rest, bundles.data]);
  // The rows in the order they show, so an action on the open thread can go on to the next one.
  const orderId = useId();
  const ordered = useMemo(
    () => [...needs, ...(stream === 'records' ? bundleGroups : groups).flatMap((g) => g.items)],
    [needs, groups, bundleGroups, stream],
  );
  useEffect(() => { useV2.getState().setOrder(orderId, ordered); }, [orderId, ordered]);
  useEffect(() => () => useV2.getState().clearOrder(orderId), [orderId]);
  const everything = allNeeds.length + allRest.length;
  const unread = [...allNeeds, ...allRest].filter((i) => i.unread).length;
  const title = streamTitle(stream);
  const sub = listCountLine(everything, unread, Boolean(res.next));
  const attachable = [...allNeeds, ...allRest].some((i) => i.hasAttachments !== undefined || i.has_attachments !== undefined);
  // The server-side Needs you count when there is one (the rail's), else what the list holds.
  const needsLabel = stream === 'people' && needsCount ? needsCount : (allNeeds.length || null);

  // "Mark the rest read" is one undoable action over every unread row below Needs you.
  const sweep = () => {
    const unreadRest = allRest.filter((i) => i.unread && i.messageId);
    if (!unreadRest.length) return;
    performAction({ kind: 'read', read: true, items: unreadRest, stream, failTitle: tv('hedwig.v2.stream.sweepFailed', 'Could not mark them read') });
  };

  const filterMenu = (
    <FilterMenu
      filter={filter}
      onChange={setFilter}
      attachable={attachable}
      phone={phone}
      extra={[{ id: 'sweep', icon: 'mail-open', label: tv('hedwig.v2.stream.sweepMenu', 'Mark the rest read'), disabled: !allRest.some((i) => i.unread), onSelect: sweep }]}
    />
  );

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
  const listRef = useRef(null);
  useFirstRowKeys(listRef);
  const error = res.error || needsRes.error;
  const loading = (res.loading && !res.loaded) || (needsRes.loading && !needsRes.loaded);
  const question = questions.list[0];
  const retry = () => { res.reload(); needsRes.reload(); };
  const filtering = filter.unread || filter.needs || filter.attachments;

  const content = (
    <div ref={listRef} onKeyDown={onListKeyDown} style={{ display: 'flex', flexDirection: 'column' }}>
      {error && <ErrorLine error={error} onRetry={retry} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {loading && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {!loading && !error && !items.length && (
        <Quiet>
          <Why>
            {filtering
              ? tv('hedwig.v2.filter.empty', 'Nothing matches this filter.')
              : stream === 'people' ? tv('hedwig.v2.people.empty', 'Nobody is waiting on you.') : tv('hedwig.v2.stream.empty', 'Nothing here right now.')}
          </Why>
        </Quiet>
      )}
      {needs.length > 0 && (
        <section aria-label={tv('hedwig.v2.people.needsYou', 'Needs you')}>
          <GroupLabel tone="attention" count={needsLabel} first phone={phone}>{tv('hedwig.v2.people.needsYou', 'Needs you')}</GroupLabel>
          <Rows items={needs} stream={stream} phone={phone} onWhy={door.open} />
          <MoreButton pages={needsRes} phone={phone} />
        </section>
      )}
      {question && phone && stream === 'people' && !showNeedsOnly && (
        <div style={{ padding: '16px 8px 4px' }}>
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
          {(i > 0 || needs.length > 0) && <Hair style={{ margin: `0 0 0 ${phone ? 66 : 62}px` }} />}
          <BundleGroup group={g} phone={phone} onWhy={door.open} cards={cardsForItems(g.items, byMessage)} open={Boolean(openBundles[g.key])} onToggle={() => setOpenBundles((o) => ({ ...o, [g.key]: !o[g.key] }))} />
        </section>
      ))}
      {!showNeedsOnly && !filter.needs && <MoreButton pages={res} phone={phone} />}
      {showNeedsOnly && !needs.length && !loading && items.length > 0 && <Quiet><Why>{tv('hedwig.v2.people.empty', 'Nobody is waiting on you.')}</Why></Quiet>}
    </div>
  );

  if (phone && stream === 'people' && tab === 'later' && work) {
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub}><ListSearch phone />{phoneTabs}</ViewHead>
        <div style={{ padding: '0 8px' }}><ListItems list="replyLater" phone /></div>
      </ViewBody>
    );
  }

  if (phone) {
    // On a phone the rail is not there: Records carries its ledgers in the header.
    const ledgerLinks = stream === 'records'
      ? (
        <nav aria-label={tv('hedwig.v2.ledger.label', 'Ledgers')} style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {(power ? LEDGER_KINDS : SIMPLE_LEDGERS).map((kind) => (
            <LinkBtn key={kind} style={{ minHeight: 44, minWidth: 44, fontSize: 15 }} onClick={() => showView(VIEW.ledger, { kind })}>{ledgerTitle(kind)}</LinkBtn>
          ))}
        </nav>
      )
      : null;
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub} actions={filterMenu}>
          <ListSearch phone />
          {phoneTabs || ledgerLinks}
        </ViewHead>
        <div style={{ padding: '0 8px', flex: '1 0 auto' }}>{content}</div>
        {door.element}
      </ViewBody>
    );
  }

  // Desktop: the header block and the Reply Later footer stay put; only the list scrolls.
  return (
    <ViewBody label={title} padded={false} style={{ overflowY: 'hidden', padding: '10px 0 0' }}>
      <ViewHead title={title} sub={sub} actions={filterMenu} before={<ListSearch style={{ marginBottom: 2 }} />} />
      <div className="hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 16px' }}>{content}</div>
      {stream === 'people' && work && (
        <div style={{ flexShrink: 0, padding: '0 6px 8px' }}>
          <Hair style={{ marginBottom: 6 }} />
          <button
            type="button"
            className="hw-btn-quiet"
            onClick={() => showView(VIEW.list, { list: 'replyLater' })}
            style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 8px', borderRadius: 6, textAlign: 'left', width: '100%', boxSizing: 'border-box', border: 0, background: 'none', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer' }}
          >
            <span aria-hidden="true" style={{ display: 'inline-flex', color: V.accent }}><Icon name="reply" size={16} /></span>
            <span style={{ fontWeight: 600 }}>{tv('hedwig.v2.rail.replyLater', 'Reply Later')}</span>
            <Num size={12}>{replyLaterCount ?? ''}</Num>
            <span style={{ flexGrow: 1 }} />
            <span className="hw-link" style={{ fontSize: 12, fontWeight: 500, color: V.accentInk, textDecorationColor: 'transparent' }}>{tv('hedwig.v2.people.focusReply', 'Focus and Reply')}</span>
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
  const hidden = useV2((s) => s.hidden);
  const patches = useV2((s) => s.patches);
  const items = useMemo(() => liveRows(listOf(res.data, 'items'), hidden, patches), [res.data, hidden, patches]);
  const listRef = useRef(null);
  useFirstRowKeys(listRef);
  const orderId = useId();
  useEffect(() => { useV2.getState().setOrder(orderId, items); }, [orderId, items]);
  useEffect(() => () => useV2.getState().clearOrder(orderId), [orderId]);
  if (res.error?.status === 404) return <Quiet><Why>{tv('hedwig.v2.list.unavailable', 'This list is not available yet.')}</Why></Quiet>;
  return (
    <div ref={listRef} onKeyDown={onListKeyDown}>
      {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {!res.loading && !res.error && !items.length && <Quiet><Why>{tv('hedwig.v2.list.empty', 'Nothing in this list.')}</Why></Quiet>}
      <Rows items={items} list={list} phone={phone} onWhy={door.open} />
      {door.element}
    </div>
  );
}
