// The Daily Brief (GET /insights/brief/today): date line, the headline, Ask, Needs you today,
// Waiting on others with Nudge, "Today, from your Records" as a strip of figures, Reading picks,
// the day's question (Yes always / No), and the "Hedwig today" line with Review or undo.
import { useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { useV2Resource, useWork } from './hooks.js';
import { listOf } from './client.js';
import { openThread, showView, VIEW } from './nav.js';
import { nudgeThread } from './mail.js';
import { Question } from './Question.jsx';
import { ErrorLine, Figure, LinkBtn, Mono, Quiet, V, ViewBody, Why, usePhone, ViewHead } from './primitives.jsx';
import { ageLabel, briefDateLine, listTime, senderName } from './format.js';
import { tv } from './i18n.js';

function Item({ time, children, action }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', columnGap: 12, alignItems: 'baseline', padding: '12px 0', borderTop: `1px solid ${V.line}` }}>
      <Mono size={12}>{time}</Mono>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>{children}</div>
      {action || <span />}
    </div>
  );
}

function RowLink({ onClick, children, size = 16, weight = 500 }) {
  return (
    <button type="button" onClick={onClick} className="hw-link" style={{ padding: 0, border: 0, background: 'none', color: V.ink, font: 'inherit', fontSize: size, fontWeight: weight, textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent', minWidth: 0 }}>
      {children}
    </button>
  );
}

export function todayLine(t) {
  if (!t) return null;
  const base = tv('hedwig.v2.today.lineBlocked', 'Hedwig screened {{screened}}, bundled {{bundled}}, rescued {{rescued}} from spam, blocked {{blocked}}.', { screened: t.screened || 0, bundled: t.bundled || 0, rescued: t.rescued || 0, blocked: t.blocked || 0 });
  return t.trackers ? `${base.replace(/\.$/, ',')} ${tv('hedwig.v2.today.trackers', 'blocked {{n}} trackers.', { n: t.trackers })}` : base;
}

const FILE = /^[^\s/\\]+\.([a-z0-9]{1,5})$/i;
/**
 * A Records card for the ledger strip. A file name is too long for the figure slot: the figure
 * becomes its type ("PDF") and the name leads the caption.
 */
export function cardParts(c) {
  const raw = c.figure || ((c.dueAt || c.due_at) ? listTime(c.dueAt || c.due_at) : '');
  const file = FILE.exec(String(raw));
  const caption = c.title || c.caption || '';
  if (file || (c.kind === 'attachment' && String(raw).length > 8)) {
    const ext = file ? file[1].toUpperCase() : tv('hedwig.v2.brief.file', 'File');
    return { figure: ext, caption: caption ? `${raw} · ${caption}` : String(raw) };
  }
  return { figure: raw, caption };
}

export default function Brief() {
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource('/insights/brief/today');
  const [ask, setAsk] = useState('');
  const [answered, setAnswered] = useState([]);
  const [nudging, setNudging] = useState(null);
  const work = useWork();
  const b = res.data || {};
  const needs = listOf(b.needsYou, 'items');
  const waiting = listOf(b.waitingOn, 'items');
  const cards = listOf(b.cards, 'items');
  const reading = listOf(b.reading, 'items');
  const questions = listOf(b.questions, 'questions').filter((q) => !answered.includes(q.id));
  // D's /insights/brief/today: generatedAt + headlineSource; older drafts of the shape used
  // date / compiledAt / modelCall. Both read the same.
  const dayOf = b.date || b.generatedAt;
  const compiledAt = b.compiledAt || b.generatedAt;
  const noModel = b.modelCall === false || b.headlineSource === 'template';
  const who = (x) => (typeof x.who === 'string' ? x.who : senderName(x.who || x.from));
  const totalQuestions = listOf(b.questions, 'questions').length;

  // Nudge drafts the follow-up in your voice (the work module) and opens the composer with it.
  const nudgeFrom = async (w) => {
    const key = w.threadId || w.messageId;
    setNudging(key);
    try {
      await nudgeThread({ ...w, who: who(w) });
    } catch (e) {
      useStore.getState().addNotification?.({ type: 'error', title: tv('hedwig.v2.waiting.nudgeFailed', 'Could not start the nudge'), body: e?.message });
    } finally {
      setNudging(null);
    }
  };

  const submitAsk = (e) => {
    e.preventDefault();
    const q = ask.trim();
    if (!q) return;
    if (getView('hedwig.ask')) {
      useHedwig.getState().setAskPrompt(q);
      useHedwig.getState().openView('hedwig.ask', { question: q });
    } else {
      // No Ask view (the plugin is off): the words still find the mail, through search.
      useStore.getState().setSearchQuery?.(q);
      useHedwig.getState().openView('core.list');
    }
    setAsk('');
  };

  const title = tv('hedwig.v2.rail.brief', 'Daily Brief');
  const askField = (
    <form onSubmit={submitAsk} style={{ margin: 0 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, width: phone ? '100%' : 400, maxWidth: '100%', height: 44, padding: '0 4px', borderBottom: `1px solid ${V.line2}`, color: V.muted, fontSize: 15, boxSizing: 'border-box' }}>
        <span style={{ fontFamily: V.why, fontStyle: 'italic', fontSize: 18, color: V.ink }}>{tv('hedwig.v2.brief.ask', 'Ask')}</span>
        <input
          type="text"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={tv('hedwig.v2.brief.askPlaceholder', 'what did the landlord say about the deposit?')}
          aria-label={tv('hedwig.v2.brief.askLabel', 'Ask your mail')}
          style={{ flexGrow: 1, minWidth: 0, border: 0, background: 'transparent', font: 'inherit', color: V.ink, outline: 'none' }}
        />
        <Mono>↵</Mono>
      </label>
    </form>
  );

  const left = (
    <section style={{ display: 'flex', flexDirection: 'column' }}>
      <Why tone="accent" style={{ paddingBottom: 6 }}>{tv('hedwig.v2.brief.needsToday', 'Needs you today')}</Why>
      {!needs.length && <Item time=""><span style={{ color: V.muted }}>{tv('hedwig.v2.brief.nothingNeeds', 'Nothing needs you today.')}</span></Item>}
      {needs.map((n) => (
        <Item key={n.messageId} time={ageLabel(n.date || n.at)}>
          <RowLink onClick={() => openThread({ ...n, needsYou: true })}>{[who(n), n.subject].filter(Boolean).join(' · ')}</RowLink>
          {n.reason && <Why tone="accent">{n.reason}</Why>}
        </Item>
      ))}
      {waiting.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '26px 0 6px' }}>
            <Why style={{ flexGrow: 1 }}>{tv('hedwig.v2.brief.waiting', 'Waiting on others')}</Why>
            {work && <LinkBtn hit={phone} onClick={() => showView(VIEW.waiting)}>{tv('hedwig.v2.brief.seeAll', 'See all')}</LinkBtn>}
          </div>
          {waiting.map((w) => (
            <Item
              key={w.messageId || w.what || w.subject}
              time={ageLabel(w.since || w.askedAt || w.at || w.date)}
              action={w.messageId || w.threadId
                ? <LinkBtn hit={phone} disabled={nudging === (w.threadId || w.messageId)} onClick={() => nudgeFrom(w)}>{nudging === (w.threadId || w.messageId) ? tv('hedwig.v2.thread.drafting', 'Drafting…') : tv('hedwig.v2.brief.nudge', 'Nudge')}</LinkBtn>
                : null}
            >
              <span style={{ fontSize: 16 }}>{[who(w), w.what || w.subject].filter(Boolean).join(' · ')}</span>
              {(w.note || w.reason) && <span style={{ fontSize: 13, color: V.muted }}>{w.note || w.reason}</span>}
            </Item>
          ))}
        </>
      )}
    </section>
  );

  const right = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
      {cards.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Why>{tv('hedwig.v2.brief.records', 'Today, from your Records')}</Why>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${phone ? 2 : Math.min(4, cards.length)}, minmax(0, 1fr))`, rowGap: 18, padding: '6px 0' }}>
            {cards.slice(0, phone ? 4 : 8).map((c, i) => {
              const col = i % (phone ? 2 : Math.min(4, cards.length));
              const part = cardParts(c);
              return (
                <button
                  key={`${c.messageId || i}`}
                  type="button"
                  onClick={c.messageId ? () => openThread({ messageId: c.messageId, threadId: c.threadId, subject: c.title }) : undefined}
                  style={{ padding: col === 0 ? '0 20px 0 0' : '0 20px', borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: col === 0 ? 0 : `1px solid ${V.line2}`, background: 'none', color: 'inherit', textAlign: 'left', font: 'inherit', cursor: c.messageId ? 'pointer' : 'default', minWidth: 0 }}
                >
                  <Figure value={part.figure} caption={part.caption} sub={c.detail} accent={Boolean(c.accent)} size={phone ? 30 : 36} />
                </button>
              );
            })}
          </div>
        </section>
      )}
      {reading.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <Why style={{ paddingBottom: 6 }}>{tv('hedwig.v2.brief.reading', 'Reading, worth a look')}</Why>
          {reading.map((r) => {
            // The sender or source name leads when the Brief has one (as in the mockup); else the title.
            const source = r.source || senderName(r.from);
            const lead = source || r.title || r.subject;
            const tail = source ? (r.title || r.subject) : r.line;
            return (
              <div key={r.messageId} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 0', borderTop: `1px solid ${V.line}`, minWidth: 0 }}>
                <span style={{ flexShrink: 0, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><RowLink size={15} onClick={() => openThread({ ...r, subject: r.subject || r.title })}>{lead}</RowLink></span>
                <span style={{ fontSize: 14, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{tail}</span>
              </div>
            );
          })}
        </section>
      )}
      {questions[0] && (
        <Question question={questions[0]} index={totalQuestions - questions.length} total={totalQuestions} phone={phone} onDone={(id) => setAnswered((a) => [...a, id])} />
      )}
    </div>
  );

  const footer = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, paddingTop: 14, borderTop: `1px solid ${V.line2}`, fontSize: 13, color: V.muted, flexWrap: 'wrap' }}>
      {b.today && <span>{todayLine(b.today)}</span>}
      <LinkBtn onClick={() => showView(VIEW.today)}>{tv('hedwig.v2.today.review', 'Review or undo')}</LinkBtn>
      <span style={{ flexGrow: 1 }} />
      {noModel && <Why size={15}>{tv('hedwig.v2.brief.noModel', 'Compiled from your mail, no model call.')}</Why>}
    </div>
  );

  const dateLine = <Mono size={12}>{briefDateLine(dayOf, compiledAt)}</Mono>;
  const headline = (
    <h1 style={{ margin: 0, fontFamily: V.serif, fontWeight: 400, fontSize: phone ? 40 : 52, lineHeight: 0.98, letterSpacing: '-0.02em', maxWidth: '14ch', textWrap: 'balance' }}>
      {b.headline || title}
    </h1>
  );

  const state = (
    <>
      {res.error && <ErrorLine error={res.error.status === 404 ? new Error(tv('hedwig.v2.brief.missing', 'The Brief is not available yet.')) : res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
    </>
  );

  if (phone) {
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={briefDateLine(dayOf, compiledAt)} />
        <div style={{ padding: '4px 20px 0', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {state}
          {res.data && <>{headline}{askField}{left}{right}{footer}</>}
        </div>
      </ViewBody>
    );
  }

  return (
    <ViewBody label={title} padded={false} style={{ padding: '34px 44px 26px', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 320px', minWidth: 0 }}>
          {dateLine}
          {headline}
        </div>
        {askField}
      </div>
      {state}
      {res.data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 44, flexGrow: 1, alignItems: 'start' }}>
          {left}
          {right}
        </div>
      )}
      {res.data && footer}
    </ViewBody>
  );
}
