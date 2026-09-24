// The message list's pieces (DESIGN-AUDIT-2026-09-24 §b): the list header's search field, the
// sticky date group header, and the stream row. A row is a grid of 8px unread dot | 36px avatar |
// text: sender and date on line 1 (flag, paperclip and thread count left of the date), the subject,
// then the preview in two muted lines, or Hedwig's TL;DR behind a sparkle when there is one. What
// needs you (or was rescued from spam, or waits in the Screener) ends in the reason line, which
// opens the why door; other rows keep the door behind a quiet info glyph that shows on hover and
// keyboard focus (on a phone, the thread's Change does it). Hover swaps the date for Done, Snooze,
// Reply Later and Delete, which go through the optimistic layer (actions.js) with Undo. The row's main area is one real button (Enter opens the thread); the reason, the
// quiet door and the hover buttons are siblings, never nested in it. A reminder row (synthetic, no
// message) has nothing to open or explain.
import { memo, useCallback, useEffect, useId, useMemo, useState } from 'react';
import i18n from 'i18next';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { useShell } from '../shell/state.js';
import { MenuButton } from '../shell/Menu.jsx';
import { Icon } from '../icons.jsx';
import { useV2, liveRows } from './state.js';
import { snoozeTimes } from './mail.js';
import { performAction } from './actions.js';
import { Avatar, Hair, IconButton, Num, Reason, SectionLabel, V } from './primitives.jsx';
import { senderName, tldrOf, tldrLighter } from './format.js';
import { tv } from './i18n.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// Dates in the list read day-first ("12 Sep"), so plain English formats as en-GB.
function dateLocale() {
  const l = i18n.language || 'en';
  if (l === 'en') return 'en-GB';
  return l === 'zhCN' ? 'zh-CN' : l === 'ptBR' ? 'pt-BR' : l;
}

function midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** The row's date (spec §b): "09:14" today, "Yesterday", "Mon" this week, "12 Sep", "12 Sep 2025". */
export function rowDate(value, now = new Date()) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const loc = dateLocale();
  const diff = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (diff <= 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff === 1) return tv('hedwig.v2.time.yesterday', 'Yesterday');
  if (diff < 7) return d.toLocaleDateString(loc, { weekday: 'short' }).replace(/\.$/, '');
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  // Newer ICU spells September "Sept" in en-GB; the list keeps three letters.
  const text = d.toLocaleDateString(loc, opts).replace(/\./g, '');
  return loc.startsWith('en') ? text.replace(/\bSept\b/, 'Sep') : text;
}

/** Rows that say why they are here in the list itself. */
export function showsReason(item) {
  return Boolean(item?.reason) && Boolean(item.needsYou || item.spam === 'rescued' || item.held || item.rescued);
}

/** What a row can show beside its date, from whatever the item carries. */
export function rowMeta(item) {
  const n = Number(item?.messageCount ?? item?.threadCount ?? item?.count);
  return {
    flagged: Boolean(item?.flagged || item?.starred || item?.is_starred),
    attachments: Boolean(item?.hasAttachments || item?.has_attachments),
    count: Number.isFinite(n) && n > 1 ? n : 0,
  };
}

/** The row's second body line: the TL;DR when Hedwig wrote one, else the message's snippet. */
export function rowPreview(item) {
  const tldr = tldrOf(item);
  if (tldr) return { tldr, text: tldr };
  const snip = typeof item?.snippet === 'string' ? item.snippet.replace(/\s+/g, ' ').trim() : '';
  return snip ? { tldr: null, text: snip } : null;
}

// The four hover buttons that take the date's place on line 1: Done, Snooze, Reply Later (with
// the work routes, and not in Reply Later itself) and Delete, 24px each.
function RowActions({ item, visible, work, list, stream }) {
  const act = (kind, extra = {}) => () => performAction({ kind, items: [item], stream: item.stream || stream, ...extra });
  const snoozeItems = () => snoozeTimes().map((s) => ({ id: s.id, label: s.label, icon: 'alarm-clock', onSelect: act('snooze', { until: s.until }) }));
  return (
    <div
      data-row-actions=""
      style={{ position: 'absolute', top: 6, right: 10, display: 'flex', gap: 2, visibility: visible ? 'visible' : 'hidden', zIndex: 1 }}
    >
      <IconButton icon="circle-check" size={24} label={tv('hedwig.v2.thread.done', 'Done')} kbd="E" onClick={act('done')} />
      <MenuButton
        label={tv('hedwig.v2.thread.snooze', 'Snooze')}
        title={`${tv('hedwig.v2.thread.snooze', 'Snooze')} (H)`}
        items={snoozeItems}
        align="right"
        width={220}
        buttonClassName="hw-icon-btn"
        buttonStyle={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.ink, cursor: 'pointer' }}
      >
        <Icon name="alarm-clock" size={14} />
      </MenuButton>
      {work && list !== 'replyLater' && (
        <IconButton icon="reply" size={24} label={tv('hedwig.v2.rail.replyLater', 'Reply Later')} kbd="L" onClick={act('replyLater')} />
      )}
      <IconButton icon="trash" size={24} label={tv('hedwig.v2.thread.delete', 'Delete')} kbd="⌫" onClick={act('delete')} />
    </div>
  );
}

function focusVisible(el) {
  try { return el.matches(':focus-visible'); } catch { return true; }
}

export const StreamRow = memo(function StreamRow({ item, onOpen, onWhy, phone = false, stream, list, index, onHover }) {
  const selected = useV2((s) => Boolean(item.messageId) && s.selected?.messageId === item.messageId);
  const work = useV2((s) => s.caps.work === true);
  const [hot, setHot] = useState(false);
  const [within, setWithin] = useState(false);
  const [ring, setRing] = useState(false);
  const synthetic = Boolean(item.synthetic || !item.messageId);
  const name = senderName(item.from) || tv('hedwig.v2.row.unknownSender', 'Unknown sender');
  const subject = item.subject || tv('hedwig.v2.row.noSubject', '(no subject)');
  const openWhy = onWhy && !synthetic ? (el) => onWhy({ ...item, stream: item.stream || stream }, el) : undefined;
  const reasonLine = showsReason(item) || (synthetic && item.reason);
  const quietWhy = Boolean(openWhy) && !reasonLine && !phone;
  const preview = rowPreview(item);
  const meta = rowMeta(item);
  const tldrId = useId();
  const actions = !phone && !synthetic;
  const active = actions && (hot || within);
  const av = phone ? 40 : 36;
  const line1 = phone ? 20 : 16;
  const whyLabel = item.reason
    ? tv('hedwig.v2.row.whyLabel', 'Why: {{reason}}. Open to see or change', { reason: item.reason })
    : tv('hedwig.v2.row.whyQuiet', 'Why is this here? Open to see or change');

  return (
    <article
      className="hw-row"
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      onMouseEnter={() => { setHot(true); onHover?.(index); }}
      onMouseLeave={() => { setHot(false); onHover?.(null); }}
      onFocus={() => setWithin(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setWithin(false); }}
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        minHeight: phone ? 88 : 76, padding: phone ? '12px 8px' : '10px 14px 10px 8px', borderRadius: 8,
        background: selected ? V.accentTint : undefined,
        boxShadow: ring ? `inset 0 0 0 2px ${V.accent}` : undefined,
      }}
    >
      <button
        type="button"
        data-row-button=""
        onClick={synthetic ? undefined : () => onOpen(item)}
        onFocus={(e) => setRing(focusVisible(e.currentTarget))}
        onBlur={() => setRing(false)}
        aria-disabled={synthetic ? 'true' : undefined}
        aria-label={`${name}: ${subject}${item.unread ? `, ${tv('hedwig.v2.row.unread', 'unread')}` : ''}`}
        aria-describedby={preview?.tldr ? tldrId : undefined}
        style={{
          display: 'grid', gridTemplateColumns: `8px ${av}px minmax(0, 1fr)`, columnGap: 10, alignItems: 'start',
          width: '100%', padding: 0, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left',
          cursor: synthetic ? 'default' : 'pointer', outline: 'none',
        }}
      >
        <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: (line1 - 8) / 2, borderRadius: '50%', background: item.unread || item.needsYou ? V.attention : 'transparent' }} />
        <Avatar name={name} email={item.from?.email} size={av} dashed={Boolean(item.held)} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, minHeight: line1 }}>
            <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: phone ? 15 : 13, lineHeight: `${line1}px`, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, color: V.muted, visibility: active ? 'hidden' : 'visible' }}>
              {meta.flagged && <Icon name="flag" size={12} style={{ color: V.attention }} title={tv('hedwig.v2.row.flagged', 'Flagged')} />}
              {meta.attachments && <Icon name="paperclip" size={12} title={tv('hedwig.v2.row.attachments', 'Has attachments')} />}
              {meta.count > 0 && <Num size={phone ? 13 : 11} title={tv('hedwig.v2.row.messages', '{{n}} messages', { n: meta.count })}>{meta.count}</Num>}
              <Num size={phone ? 13 : 11}>{rowDate(item.date)}</Num>
            </span>
          </span>
          <span style={{ fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '18px', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: quietWhy ? 20 : 0 }}>
            {subject}
          </span>
          {preview && (
            <span
              style={{
                fontSize: phone ? 14 : 12, lineHeight: phone ? '19px' : '16px', color: V.muted, overflow: 'hidden', overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: reasonLine ? 1 : 2, WebkitBoxOrient: 'vertical', paddingRight: quietWhy ? 20 : 0,
              }}
            >
              {preview.tldr
                ? (
                  <>
                    <Icon name="sparkles" size={11} strokeWidth={1.75} style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 4 }} />
                    <span data-tldr="" id={tldrId} title={tldrLighter(item) ? tv('hedwig.v2.tier.lighterStory', 'Written by the lighter model') : undefined}>{preview.tldr}</span>
                  </>
                )
                : preview.text}
            </span>
          )}
        </span>
      </button>
      {reasonLine && (
        <div style={{ paddingLeft: av + 28, paddingTop: 2, minWidth: 0 }}>
          <Reason
            glyph={item.needsYou ? 'alert' : 'info'}
            tone={item.needsYou ? 'attention' : 'muted'}
            size={phone ? 13 : 12}
            hit={phone}
            onOpen={openWhy}
            label={openWhy ? whyLabel : undefined}
          >
            {item.reason}
          </Reason>
        </div>
      )}
      {quietWhy && (
        <button
          type="button"
          className="hw-row-why hw-why-door"
          aria-haspopup="dialog"
          aria-label={whyLabel}
          title={tv('hedwig.v2.row.whyTitle', 'Why is this here?')}
          onClick={(e) => openWhy(e.currentTarget)}
          style={{ position: 'absolute', right: 10, bottom: 8, width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'none', cursor: 'pointer', color: V.muted }}
        >
          <Icon name="info" size={12} strokeWidth={1.75} />
        </button>
      )}
      {actions && <RowActions item={item} visible={active} work={work} list={list} stream={stream} />}
    </article>
  );
});

/**
 * Rows with the hairline between them: inset past the avatar (62px), and hidden next to a hovered
 * or selected row, so the fill reads as one shape.
 */
export function RowList({ items: given, stream, list, phone, onWhy, onOpen }) {
  const [hot, setHot] = useState(null);
  const selectedId = useV2((s) => s.selected?.messageId || null);
  // Rows an action took away stay away, and a flag or read change shows before the reload.
  const hidden = useV2((s) => s.hidden);
  const patches = useV2((s) => s.patches);
  const items = useMemo(() => liveRows(given, hidden, patches), [given, hidden, patches]);
  const onHover = useCallback((i) => setHot(i), []);
  const lit = (i) => i === hot || (selectedId && items[i]?.messageId === selectedId);
  return items.map((it, i) => (
    <div key={it.messageId || it.threadId || i}>
      {i > 0 && <Hair style={{ margin: `0 0 0 ${phone ? 66 : 62}px`, opacity: lit(i) || lit(i - 1) ? 0 : 1 }} />}
      <StreamRow item={it} stream={stream} list={list} phone={phone} onOpen={onOpen} onWhy={onWhy} index={i} onHover={phone ? undefined : onHover} />
    </div>
  ));
}

/**
 * The list header's search field (spec §b): 30px, --field, a magnifier, "Search or ask" and the
 * ⌘K hint. A question goes to Ask, anything else to search; empty, it opens the palette.
 */
export function ListSearch({ phone = false, style }) {
  const openPalette = useShell((s) => s.openPalette);
  const [query, setQuery] = useState('');
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
  const label = tv('hedwig.v2.searchOrAsk', 'Search or ask');
  return (
    <form role="search" onSubmit={submit} style={{ margin: 0, ...style }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, height: phone ? 36 : 30, padding: '0 8px', borderRadius: 8, background: V.field, color: V.muted, boxSizing: 'border-box', cursor: 'text' }}>
        <Icon name="search" size={14} />
        <input
          type="text"
          data-list-search=""
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={label}
          aria-label={label}
          enterKeyHint="search"
          style={{ flex: 1, minWidth: 0, height: '100%', border: 0, padding: 0, background: 'transparent', color: V.ink, fontFamily: V.sans, fontSize: phone ? 16 : 13, outline: 'none' }}
        />
        {!phone && (
          <button
            type="button"
            onClick={() => openPalette?.()}
            aria-label={tv('hedwig.v2.rail.palette', 'Open the command palette')}
            aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
            style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: V.muted, fontFamily: V.sans, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
          >
            {isMac ? '⌘K' : 'Ctrl K'}
          </button>
        )}
      </label>
    </form>
  );
}

/** Arrow keys (and j / k) move between the row buttons of a list. */
export function onListKeyDown(e) {
  const t = e.target;
  if (!t?.hasAttribute?.('data-row-button')) return;
  const down = e.key === 'ArrowDown' || e.key === 'j';
  const up = e.key === 'ArrowUp' || e.key === 'k';
  if (!down && !up) return;
  const all = [...e.currentTarget.querySelectorAll('[data-row-button]')];
  const i = all.indexOf(t);
  const next = all[i + (down ? 1 : -1)];
  if (next) { e.preventDefault(); next.focus(); }
}

/**
 * j / k (or the arrows) with no row focused yet — right after "g p", or with the pane itself
 * focused — step into the list: the first row takes focus, and onListKeyDown carries on from there.
 */
export function firstRowFor(active, root) {
  if (!root) return null;
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''))) return null;
  if (active?.hasAttribute?.('data-row-button') || active?.closest?.('[role="dialog"], [role="menu"]')) return null;
  const pane = root.closest?.('[data-pane-key]') || root;
  const here = !active || active === document.body || active === pane || pane.contains(active);
  return here ? root.querySelector('[data-row-button]') : null;
}

export function useFirstRowKeys(rootRef) {
  useEffect(() => {
    // Not skipped when defaultPrevented: upstream's global shortcuts claim j / k for its message
    // list (preventDefault even with no list on screen), and this only acts with a stream showing.
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const first = firstRowFor(document.activeElement, rootRef.current);
      if (first) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rootRef]);
}

/**
 * A date group header ("Today", "Yesterday", "This week"): 28px, 11px/600 muted, sticky over the
 * list with the content fill behind it at 92%. `tone="attention"` is Needs you; `count` sits after it.
 */
export function GroupLabel({ children, tone = 'muted', count, first = false, phone = false }) {
  const attention = tone === 'attention' || tone === 'accent';
  return (
    <SectionLabel
      as="h2"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 28, boxSizing: 'border-box', padding: phone ? '0 8px' : '0 10px',
        marginTop: first ? 0 : 6, color: attention ? V.attentionInk : V.muted,
        ...(phone ? {} : { position: 'sticky', top: 0, zIndex: 2, background: 'color-mix(in srgb, var(--hw-content, #FFFFFF) 92%, transparent)' }),
      }}
    >
      {children}
      {count ? <Num size={11} color="inherit" style={{ fontWeight: 500 }}>{count}</Num> : null}
    </SectionLabel>
  );
}
