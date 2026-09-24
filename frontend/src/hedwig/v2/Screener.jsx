// The Screener (GET /sort/screener, DESIGN-AUDIT-2026-09-24 keep list): each new sender as a list
// row with a dashed avatar, what they wrote, and Hedwig's proposed stream with the reason as the
// reason line. Under it, four 32px buttons (People, Reading, Records, Block) with the proposal
// filled, and Accept; "Accept all" in the list header takes every proposal at once. Mail found in
// the server's spam folder that looks real is tinted and says so.
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2Resource, useWork } from './hooks.js';
import { useTldrs, withTldrs } from './tldrs.js';
import { v2Api, listOf, announceSortChange } from './client.js';
import { Avatar, Btn, ErrorLine, Hair, IconButton, Quiet, Reason, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { tv, tvn } from './i18n.js';
import { tldrOf } from './format.js';
import { useV2 } from './state.js';
import { openThread } from './nav.js';
import { onListKeyDown, useFirstRowKeys } from './rows.jsx';

const DECISION_ICONS = { people: 'users', reading: 'book-open', records: 'receipt', block: 'ban' };

export function decisionOptions() {
  return [
    { id: 'people', label: tv('hedwig.v2.stream.people', 'People') },
    { id: 'reading', label: tv('hedwig.v2.stream.reading', 'Reading') },
    { id: 'records', label: tv('hedwig.v2.stream.records', 'Records') },
    { id: 'block', label: tv('hedwig.v2.screener.block', 'Block') },
  ];
}

function decisionLabel(id) {
  return decisionOptions().find((o) => o.id === id)?.label || id;
}

/** The proposal as the row's reason line: "Proposed: Records. Booking confirmations." */
export function proposalLine(proposed, reason) {
  const r = String(reason || '').trim();
  const where = decisionLabel(proposed || 'people');
  return r
    ? tv('hedwig.v2.screener.proposedWhy', 'Proposed: {{stream}}. {{reason}}', { stream: where, reason: r })
    : tv('hedwig.v2.screener.proposed', 'Proposed: {{stream}}', { stream: where });
}

/**
 * The four decisions as 32px icon buttons with labels, the chosen one filled. A radio group: one
 * Tab stop (the chosen option), arrow keys move the choice, Home / End jump to the ends.
 */
function DecisionPicker({ value, onChange, label, phone }) {
  const options = decisionOptions();
  const current = options.some((o) => o.id === value) ? value : options[0].id;
  const onKeyDown = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const i = options.findIndex((o) => o.id === current);
    let j = null;
    if (keys[e.key]) j = (i + keys[e.key] + options.length) % options.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = options.length - 1;
    if (j === null) return;
    e.preventDefault();
    onChange(options[j].id);
    e.currentTarget.querySelectorAll('[role="radio"]')[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4 }}>
      {options.map((o) => {
        const on = o.id === current;
        return (
          <IconButton
            key={o.id}
            icon={DECISION_ICONS[o.id]}
            label={o.label}
            showLabel
            primary={on}
            size={32}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.id)}
            style={{ width: '100%', minWidth: 0, height: phone ? 44 : 32, overflow: 'hidden', padding: '0 5px', gap: 4, ...(on ? {} : { color: V.ink, boxShadow: `inset 0 0 0 1px ${V.line2}` }) }}
          />
        );
      })}
    </div>
  );
}

function SenderRow({ sender, choice, onChoose, onAccept, onOpen, busy, phone }) {
  const selected = useV2((st) => Boolean(sender.lastMessageId) && st.selected?.messageId === sender.lastMessageId);
  const block = choice === 'block';
  const rescue = Boolean(sender.inSpam);
  const name = sender.display || sender.address;
  const acceptLabel = rescue && !block
    ? tv('hedwig.v2.screener.acceptRescue', 'Accept: {{stream}}, rescue from spam', { stream: decisionLabel(choice) })
    : tv('hedwig.v2.screener.accept', 'Accept: {{stream}}', { stream: decisionLabel(choice) });
  const meta = [sender.count ? tvn(sender.count, ['hedwig.v2.screener.messagesOne', '1 message'], ['hedwig.v2.screener.messagesMany', '{{n}} messages'], { n: sender.count }) : null, rescue ? tv('hedwig.v2.screener.inSpam', 'in spam') : null].filter(Boolean).join(' · ');
  // What they wrote: Hedwig's one-line TL;DR of the latest message when there is one, else its subject.
  const latestSubject = Array.isArray(sender.subjects) ? sender.subjects.find((x) => typeof x === 'string' && x.trim()) : null;
  const tldr = tldrOf(sender);
  const summary = tldr || (latestSubject ? latestSubject.trim() : null);
  const av = phone ? 40 : 36;
  const email = /@/.test(String(sender.address || '')) ? sender.address : null;
  const item = sender.lastMessageId
    ? { messageId: sender.lastMessageId, threadId: sender.lastThreadId || sender.threadId || undefined, subject: latestSubject || undefined, from: { name, email }, stream: 'screener' }
    : null;
  const text = (size, line, extra) => ({ fontSize: size, lineHeight: line, overflow: 'hidden', ...extra });
  return (
    <article
      aria-label={name}
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box', minHeight: phone ? 88 : 76,
        padding: phone ? '12px 8px' : '10px 14px 12px 8px', borderRadius: 8,
        background: rescue || selected ? V.accentTint : undefined,
        boxShadow: rescue && selected ? `inset 0 0 0 1px ${V.accent}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <button
          type="button"
          data-row-button=""
          onClick={item ? () => onOpen(item) : undefined}
          aria-disabled={item ? undefined : 'true'}
          aria-label={summary ? `${name}: ${summary}` : name}
          style={{
            flex: '1 1 auto', minWidth: 0, display: 'grid', gridTemplateColumns: `8px ${av}px minmax(0, 1fr)`, columnGap: 10, alignItems: 'start',
            padding: 0, border: 0, background: 'none', color: 'inherit', fontFamily: 'inherit', textAlign: 'left', cursor: item ? 'pointer' : 'default',
          }}
        >
          <span aria-hidden="true" />
          <Avatar name={name} email={email} size={av} dashed />
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={text(phone ? 15 : 13, phone ? '20px' : '16px', { fontWeight: 600, textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{name}</span>
            {(sender.address && sender.address !== name) || meta ? (
              <span style={text(phone ? 14 : 12, phone ? '19px' : '16px', { color: rescue ? V.inkSoft : V.muted, textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' })}>
                {[sender.address !== name ? sender.address : null, meta].filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {summary && (
              <span style={text(phone ? 15 : 13, phone ? '20px' : '18px', { color: V.ink, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' })}>
                {tldr && <Icon name="sparkles" size={11} strokeWidth={1.75} style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 4, color: V.muted }} />}
                <span data-tldr="">{summary}</span>
              </span>
            )}
            <Reason
              glyph={rescue ? 'alert' : 'info'}
              tone={rescue ? 'attention' : 'muted'}
              size={phone ? 13 : 12}
              style={{ paddingTop: 2 }}
            >
              {rescue ? rescueLine(sender.reason) : proposalLine(sender.proposed, sender.reason)}
            </Reason>
          </span>
        </button>
        <IconButton
          icon="check"
          label={acceptLabel}
          disabled={busy}
          onClick={onAccept}
          size={28}
          style={{ width: 'auto', height: phone ? 44 : 28, padding: '0 10px 0 8px', marginTop: phone ? -12 : -6, color: V.accentInk, boxShadow: `inset 0 0 0 1px ${V.line2}` }}
        >
          <span>{tv('hedwig.v2.screener.acceptShort', 'Accept')}</span>
        </IconButton>
      </div>
      <div style={{ paddingLeft: 18 }}>
        <DecisionPicker label={tv('hedwig.v2.screener.streamFor', 'Stream for {{name}}', { name })} value={choice} onChange={onChoose} phone={phone} />
      </div>
    </article>
  );
}

/** "In your spam folder, but it looks real: <reason>", or without the colon when there is no reason. */
export function rescueLine(reason) {
  const r = String(reason || '').trim();
  return r
    ? tv('hedwig.v2.screener.rescue', 'In your spam folder, but it looks real: {{reason}}', { reason: lowerFirst(r) })
    : tv('hedwig.v2.screener.rescueBare', 'In your spam folder, but it looks real.');
}

function lowerFirst(s) {
  if (!s) return s;
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export default function Screener() {
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource('/sort/screener');
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const work = useWork();
  const listRef = useRef(null);
  useFirstRowKeys(listRef);
  const raw = useMemo(() => listOf(res.data, 'senders'), [res.data]);
  // Each sender's latest message TL;DR, in one call (GET /work/tldr).
  const tldrs = useTldrs(useMemo(() => raw.filter((x) => !x.tldr).map((x) => x.lastMessageId), [raw]), work);
  const senders = useMemo(() => withTldrs(raw, tldrs, (x) => x.lastMessageId), [raw, tldrs]);
  const choiceOf = (s) => choices[`${s.scope}:${s.key}`] || s.proposed || 'people';

  const drop = (keys) => {
    res.setData((d) => {
      const list = listOf(d, 'senders').filter((s) => !keys.includes(`${s.scope}:${s.key}`));
      return Array.isArray(d) ? list : { ...(d || {}), senders: list };
    });
  };

  const decide = async (s) => {
    const k = `${s.scope}:${s.key}`;
    setBusy(k);
    setError(null);
    try {
      await v2Api.post('/sort/screener/decide', { key: s.key, scope: s.scope, decision: choiceOf(s) });
      drop([k]);
      announceSortChange({ screener: s.key });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  // Accept all: one decision per sender with whatever is picked on screen (the proposal unless
  // changed), so a changed pick is never overridden by the server's proposal.
  const acceptAll = async () => {
    setBusy('all');
    setError(null);
    const done = [];
    try {
      for (const s of senders) {
        await v2Api.post('/sort/screener/decide', { key: s.key, scope: s.scope, decision: choiceOf(s) });
        done.push(`${s.scope}:${s.key}`);
      }
      useStore.getState().addNotification?.({ type: 'success', title: tvn(done.length, ['hedwig.v2.screener.acceptedOne', 'Accepted one sender.'], ['hedwig.v2.screener.acceptedMany', 'Accepted senders: {{n}}.']) });
    } catch (e) {
      setError(e);
    } finally {
      drop(done);
      if (done.length) announceSortChange({ screener: 'all' });
      setBusy(null);
    }
  };

  const title = tv('hedwig.v2.rail.screener', 'Screener');
  const sub = senders.length ? tv('hedwig.v2.screener.waiting', '{{n}} waiting', { n: senders.length }) : null;
  const acceptAllBtn = senders.length > 1
    ? (
      <Btn size={phone ? 'phone' : 'md'} disabled={Boolean(busy)} onClick={acceptAll} style={{ alignSelf: 'center' }}>
        <Icon name="check" size={phone ? 16 : 14} />
        {tv('hedwig.v2.screener.acceptAll', 'Accept all')}
      </Btn>
    )
    : null;
  const intro = <Why>{tv('hedwig.v2.screener.intro', 'Each new sender comes with a proposed stream and the reason. Accept it or pick another; Hedwig remembers.')}</Why>;

  return (
    <ViewBody phone={phone} label={title} padded={false} style={phone ? undefined : { padding: '14px 0 16px' }}>
      <ViewHead phone={phone} title={title} sub={sub} actions={acceptAllBtn}>{intro}</ViewHead>
      <div ref={listRef} onKeyDown={onListKeyDown} style={{ padding: phone ? '0 8px' : '0 6px', display: 'flex', flexDirection: 'column' }}>
        {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
        <ErrorLine error={error} />
        {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
        {!res.loading && !res.error && !senders.length && <Quiet><Why>{tv('hedwig.v2.screener.empty', 'No new senders. Hedwig will ask when someone new writes.')}</Why></Quiet>}
        {senders.map((s, i) => {
          const k = `${s.scope}:${s.key}`;
          const prevRescue = i > 0 && senders[i - 1].inSpam;
          return (
            <div key={k}>
              {i > 0 && <Hair style={{ margin: `0 0 0 ${phone ? 66 : 62}px`, opacity: s.inSpam || prevRescue ? 0 : 1 }} />}
              <SenderRow
                sender={s}
                phone={phone}
                choice={choiceOf(s)}
                busy={Boolean(busy)}
                onChoose={(v) => setChoices((c) => ({ ...c, [k]: v }))}
                onAccept={() => decide(s)}
                onOpen={openThread}
              />
            </div>
          );
        })}
      </div>
    </ViewBody>
  );
}
