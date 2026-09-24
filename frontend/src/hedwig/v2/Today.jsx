// "Hedwig today" (GET /sort/today): it opens with the four-figure strip (screened, bundled, rescued,
// blocked) that used to be the rail's paragraph, then everything Hedwig decided on its own today,
// newest first, each with Undo (POST /sort/undo). The rail's Today and the Brief link here.
import { useRef, useState } from 'react';
import { useV2Resource } from './hooks.js';
import { v2Api, listOf, announceSortChange } from './client.js';
import { streamTitle } from './StreamView.jsx';
import { todayLine } from './Brief.jsx';
import { rowDate } from './rows.jsx';
import { Avatar, ErrorLine, IconButton, LinkBtn, Num, Quiet, SectionLabel, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { openThread } from './nav.js';
import { tv } from './i18n.js';

function place(to) {
  if (!to || typeof to !== 'object') return '';
  if (to.stream === 'block') return tv('hedwig.v2.screener.block', 'Block');
  if (to.bundle) return to.bundle.charAt(0).toUpperCase() + to.bundle.slice(1);
  if (to.stream && ['people', 'reading', 'records'].includes(to.stream)) return streamTitle(to.stream);
  if (to.spam === 'rescued') return tv('hedwig.v2.today.rescuedTo', 'out of spam');
  return to.stream || '';
}

// C's /sort/today entries: { id, action, messageId, subject, from: { name, email }, before, after,
// by, undone, undoable, text, createdAt }. `text` is the server's own sentence and wins.
export function entryOf(e) {
  return {
    id: e.id,
    messageId: e.messageId ?? e.message_id,
    threadId: e.threadId ?? e.thread_id,
    subject: e.subject,
    sender: e.sender || e.from?.name || e.from?.email || null,
    to: e.after ?? e.to,
    action: e.action,
    text: e.text || null,
    reason: e.reason || null,
    undone: Boolean(e.undone ?? e.undone_at),
    undoable: e.undoable !== false,
    at: e.createdAt ?? e.created_at,
  };
}

export function actionLabel(e) {
  if (e.text) return e.text;
  const where = place(e.to);
  switch (e.action) {
    case 'screen': return tv('hedwig.v2.today.screened', 'Screened into {{where}}', { where });
    case 'bundle': return tv('hedwig.v2.today.bundled', 'Bundled into {{where}}', { where });
    case 'rescue': return tv('hedwig.v2.today.rescued', 'Rescued from spam');
    case 'block': return tv('hedwig.v2.today.blocked', 'Blocked');
    case 'spam': return tv('hedwig.v2.today.movedSpam', 'Moved to spam');
    case 'correct': return tv('hedwig.v2.today.corrected', 'You moved it to {{where}}', { where });
    default: return where ? `${e.action} → ${where}` : String(e.action || '');
  }
}

/** The four figures at the top of Today, with the Brief's sentence as their accessible name. */
export function TodayStrip({ today, phone = false, onReview }) {
  const figures = [
    { n: today?.screened, label: tv('hedwig.v2.today.figScreenedShort', 'screened') },
    { n: today?.bundled, label: tv('hedwig.v2.today.figBundled', 'bundled') },
    { n: today?.rescued, label: tv('hedwig.v2.today.figRescuedShort', 'rescued') },
    { n: today?.blocked, label: tv('hedwig.v2.today.figBlocked', 'blocked') },
  ];
  const cols = phone ? 2 : 4;
  return (
    <section aria-label={todayLine(today || {})} data-today-strip="" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, rowGap: 12 }}>
        {figures.map((f, i) => (
          <div key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingLeft: i % cols ? 14 : 0, borderLeft: i % cols ? `1px solid ${V.line}` : 0 }}>
            <span style={{ fontSize: 20, lineHeight: '24px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: V.ink }}>{String(f.n ?? 0)}</span>
            <span style={{ fontSize: 11, lineHeight: '14px', color: V.muted }}>{f.label}</span>
          </div>
        ))}
      </div>
      {onReview && <LinkBtn hit={phone} onClick={onReview} style={{ alignSelf: 'flex-start', fontSize: phone ? 15 : 12, color: V.accentInk, textDecorationColor: 'transparent' }}>{tv('hedwig.v2.today.review', 'Review or undo')}</LinkBtn>}
    </section>
  );
}

export default function Today() {
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource('/sort/today');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const listRef = useRef(null);
  const d = res.data || {};
  const entries = listOf(d.entries, 'entries').map(entryOf);

  const undo = async (e) => {
    setBusy(e.id);
    setError(null);
    try {
      await v2Api.post('/sort/undo', { logId: e.id });
      res.setData((cur) => ({ ...(cur || {}), entries: listOf(cur?.entries, 'entries').map((x) => (x.id === e.id ? { ...x, undone: true, undoable: false, undone_at: new Date().toISOString() } : x)) }));
      announceSortChange({ undo: e.id });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const title = tv('hedwig.v2.today.title', 'Hedwig today');
  const review = () => {
    const first = listRef.current?.querySelector('button[data-undo]') || listRef.current?.querySelector('button');
    first?.focus();
    first?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <ViewBody phone={phone} label={title} padded={false} style={phone ? undefined : { padding: '14px 0 16px' }}>
      <ViewHead phone={phone} title={title}>
        <Why>{tv('hedwig.v2.today.intro', 'Everything Hedwig decided on its own today. Undo puts it back and teaches it.')}</Why>
      </ViewHead>
      <div style={{ padding: phone ? '0 16px' : '0 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
        <ErrorLine error={error} />
        {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
        {res.data && <TodayStrip today={d} phone={phone} onReview={entries.some((e) => e.undoable && !e.undone) ? review : null} />}
        {res.data && !entries.length && <Quiet><Why>{tv('hedwig.v2.today.empty', 'Hedwig has not decided anything on its own today.')}</Why></Quiet>}
      </div>
      {entries.length > 0 && (
        <div style={{ padding: phone ? '0 8px' : '0 6px' }}>
          <SectionLabel as="h2" style={{ padding: phone ? '16px 8px 4px' : '16px 6px 4px' }}>{tv('hedwig.v2.today.decisions', 'What Hedwig did')}</SectionLabel>
          <div role="list" ref={listRef} style={{ display: 'flex', flexDirection: 'column' }}>
            {entries.map((e, i) => {
              const undone = e.undone;
              // Sender-level entries (a decision, a bundle delivery) have no message: the action is the line.
              const head = [e.sender, e.subject].filter(Boolean).join(' · ');
              const av = phone ? 40 : 36;
              const strong = { fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '16px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
              return (
                <div role="listitem" key={e.id} style={{ opacity: undone ? 0.55 : 1 }}>
                  {i > 0 && <div role="presentation" style={{ height: 1, background: V.line, marginLeft: av + 18 }} />}
                  <div style={{ display: 'grid', gridTemplateColumns: `${av}px minmax(0, 1fr) auto`, columnGap: 10, alignItems: 'start', padding: phone ? '12px 8px' : '10px 8px' }}>
                    {e.sender
                      ? <Avatar name={e.sender} size={av} />
                      : <span aria-hidden="true" style={{ width: av, height: av, borderRadius: 8, background: V.field, color: V.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="history" size={18} /></span>}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        {head && e.messageId ? (
                          <button
                            type="button"
                            className="hw-link"
                            onClick={() => openThread({ messageId: e.messageId, threadId: e.threadId, subject: e.subject })}
                            style={{ ...strong, fontFamily: 'inherit', padding: 0, border: 0, background: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent' }}
                          >
                            {head}
                          </button>
                        ) : head ? <span style={strong}>{head}</span> : <span style={strong}>{actionLabel(e)}</span>}
                        <span style={{ flexGrow: 1 }} />
                        <Num size={phone ? 13 : 11}>{rowDate(e.at)}</Num>
                      </span>
                      {head && <span style={{ fontSize: phone ? 14 : 12, lineHeight: phone ? '19px' : '16px', color: V.muted }}>{actionLabel(e)}</span>}
                      {e.reason && <Why>{e.reason}</Why>}
                    </div>
                    <span style={{ alignSelf: 'center', paddingLeft: 6 }}>
                      {undone
                        ? <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.today.undone', 'Undone')}</span>
                        : e.undoable
                          ? <IconButton icon="undo" data-undo="" label={tv('hedwig.v2.today.undo', 'Undo')} size={phone ? 44 : 28} disabled={busy === e.id} onClick={() => undo(e)} style={{ color: V.accentInk }} />
                          : null}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </ViewBody>
  );
}
