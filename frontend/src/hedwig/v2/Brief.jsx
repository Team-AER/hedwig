// The Daily Brief (GET /insights/brief/today), an opaque reading page in the reader column
// (DESIGN-AUDIT-2026-09-24 keep list): date line, the headline (22/600) in the summary box with
// where its prose came from, the Ask field in the search field's look, Needs you today, Waiting on
// others with Nudge, "Today, from your Records" as boxed cards with 20/600 tabular figures, Reading
// picks, the day's question, and the "Hedwig today" line with Review or undo. Section headers are
// the 11px/600 SectionLabel. No serif, no italic.
import { useState } from 'react';
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { useV2Resource, useWork } from './hooks.js';
import { listOf, v2Api, announceSortChange } from './client.js';
import { openThread, showView, VIEW } from './nav.js';
import { nudgeThread } from './mail.js';
import { Question } from './Question.jsx';
import { ErrorLine, Figure, LinkBtn, Mono, Quiet, Reason, SectionLabel, Slip, V, ViewBody, usePhone, ViewHead } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { ageLabel, briefDateLine, listTime, senderName } from './format.js';
import { tv } from './i18n.js';
import { TierNote } from './TierNote.jsx';
import { CoverageNote } from './CoverageNote.jsx';
import { isLighter } from './tiers.js';

function Item({ time, children, action }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', columnGap: 12, alignItems: 'baseline', padding: '10px 0', borderTop: `1px solid ${V.line}` }}>
      <Mono size={11}>{time}</Mono>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>{children}</div>
      {action || <span />}
    </div>
  );
}

function RowLink({ onClick, children, weight = 500 }) {
  return (
    <button type="button" onClick={onClick} className="hw-link" style={{ padding: 0, border: 0, background: 'none', color: V.ink, font: 'inherit', fontSize: 13, fontWeight: weight, textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent', minWidth: 0 }}>
      {children}
    </button>
  );
}

/** A Brief section header: the 11px/600 section label, flush with the page's left edge. */
function Head({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, paddingBottom: 6 }}>
      <SectionLabel as="h2" style={{ padding: 0, flexGrow: 1 }}>{children}</SectionLabel>
      {action}
    </div>
  );
}

/**
 * The Ask field in the look of the search field (spec §b), 36px here: radius 8, the --hw-field
 * fill, a 14px glyph, 13px text, and a ring on the whole field while the input has focus.
 * Ask.jsx uses the same style and CSS.
 */
export const ASK_FIELD_CSS = '.hw-ask-field:focus-within{box-shadow:0 0 0 2px var(--hw-accent)}.hw-ask-field input:focus-visible{outline:none}';
export const askFieldStyle = {
  display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 6px 0 12px', borderRadius: 8, background: V.field,
  color: V.muted, fontSize: 13, boxSizing: 'border-box', minWidth: 0,
};
export const askInputStyle = { flexGrow: 1, minWidth: 0, height: '100%', border: 0, padding: 0, background: 'transparent', font: 'inherit', fontSize: 13, color: V.ink };

const PROSE_REASONS = {
  tier2_degraded: () => tv('hedwig.v2.brief.reasonTier2', 'Tier 2 was not answering'),
  model_error: () => tv('hedwig.v2.brief.reasonError', 'the model call failed'),
  budget: () => tv('hedwig.v2.brief.reasonBudget', 'today’s budget was spent'),
  budget_exceeded: () => tv('hedwig.v2.brief.reasonBudget', 'today’s budget was spent'),
  models_off: () => tv('hedwig.v2.brief.reasonOff', 'model features are off'),
  llm_disabled: () => tv('hedwig.v2.brief.reasonOff', 'model features are off'),
  empty_reply: () => tv('hedwig.v2.brief.reasonEmpty', 'the model returned nothing'),
};

/**
 * Where today's briefing prose came from (`prose: { source, fallback, reason, model, at }`): the
 * template standing in, with the reason in words, or the lighter model. null when the model wrote
 * it as planned, or there is no briefing today.
 */
export function proseNote(prose, status) {
  if (!prose || typeof prose !== 'object') return null;
  if (prose.fallback || prose.source === 'template') {
    const why = PROSE_REASONS[prose.reason]?.();
    return why
      ? tv('hedwig.v2.brief.fromTemplateWhy', 'Written from a template: {{reason}}.', { reason: why })
      : tv('hedwig.v2.brief.fromTemplate', 'Written from a template today.');
  }
  if (prose.model && isLighter({ model: prose.model, tier: 'reasoning' }, status)) return tv('hedwig.v2.tier.lighterStory', 'Written by the lighter model');
  return null;
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
  const status = useHedwig((st) => st.status);
  const [undone, setUndone] = useState([]);
  const [undoing, setUndoing] = useState(null);
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
    <form onSubmit={submitAsk} style={{ margin: 0, width: '100%', maxWidth: phone ? 'none' : 560 }}>
      <style>{ASK_FIELD_CSS}</style>
      <label className="hw-ask-field" style={{ ...askFieldStyle, height: phone ? 44 : 36 }}>
        <Icon name="search" size={14} strokeWidth={1.75} />
        <input
          type="text"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={tv('hedwig.v2.brief.askPlaceholder', 'what did the landlord say about the deposit?')}
          aria-label={tv('hedwig.v2.brief.askLabel', 'Ask your mail')}
          style={{ ...askInputStyle, fontSize: phone ? 16 : 13 }}
        />
        <span aria-hidden="true" style={{ fontSize: 11, color: V.muted, padding: '0 6px' }}>↵</span>
      </label>
    </form>
  );

  const left = (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Head>{tv('hedwig.v2.brief.needsToday', 'Needs you today')}</Head>
      {!needs.length && <Item time=""><span style={{ color: V.muted }}>{tv('hedwig.v2.brief.nothingNeeds', 'Nothing needs you today.')}</span></Item>}
      {needs.map((n) => (
        <Item key={n.messageId} time={ageLabel(n.date || n.at)}>
          <RowLink weight={600} onClick={() => openThread({ ...n, needsYou: true })}>{[who(n), n.subject].filter(Boolean).join(' · ')}</RowLink>
          {n.reason && <Reason glyph="alert" tone="attention">{n.reason}</Reason>}
        </Item>
      ))}
      {waiting.length > 0 && (
        <>
          <div style={{ paddingTop: 20 }}>
            <Head action={work && <LinkBtn hit={phone} onClick={() => showView(VIEW.waiting)} style={{ fontSize: 12, color: V.accentInk }}>{tv('hedwig.v2.brief.seeAll', 'See all')}</LinkBtn>}>
              {tv('hedwig.v2.brief.waiting', 'Waiting on others')}
            </Head>
          </div>
          {waiting.map((w) => (
            <Item
              key={w.messageId || w.what || w.subject}
              time={ageLabel(w.since || w.askedAt || w.at || w.date)}
              action={w.messageId || w.threadId
                ? <LinkBtn hit={phone} disabled={nudging === (w.threadId || w.messageId)} onClick={() => nudgeFrom(w)}>{nudging === (w.threadId || w.messageId) ? tv('hedwig.v2.thread.drafting', 'Drafting…') : tv('hedwig.v2.brief.nudge', 'Nudge')}</LinkBtn>
                : null}
            >
              <span style={{ fontSize: 13 }}>{[who(w), w.what || w.subject].filter(Boolean).join(' · ')}</span>
              {(w.note || w.reason) && <span style={{ fontSize: 12, color: V.muted }}>{w.note || w.reason}</span>}
            </Item>
          ))}
        </>
      )}
    </section>
  );

  const right = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
      {cards.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <Head>{tv('hedwig.v2.brief.records', 'Today, from your Records')}</Head>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${phone ? 2 : Math.min(2, cards.length)}, minmax(0, 1fr))`, gap: 8 }}>
            {cards.slice(0, phone ? 4 : 8).map((c, i) => {
              const part = cardParts(c);
              const open = c.messageId ? () => openThread({ messageId: c.messageId, threadId: c.threadId, subject: c.title }) : undefined;
              return (
                <Slip
                  key={`${c.messageId || i}`}
                  as={open ? 'button' : 'div'}
                  type={open ? 'button' : undefined}
                  onClick={open}
                  data-brief-card=""
                  style={{ font: 'inherit', textAlign: 'left', cursor: open ? 'pointer' : 'default', minWidth: 0 }}
                >
                  <Figure value={part.figure} caption={part.caption} sub={c.detail} accent={Boolean(c.accent)} size={20} />
                </Slip>
              );
            })}
          </div>
        </section>
      )}
      {reading.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <Head>{tv('hedwig.v2.brief.reading', 'Reading, worth a look')}</Head>
          {reading.map((r) => {
            // The sender or source name leads when the Brief has one (as in the mockup); else the title.
            const source = r.source || senderName(r.from);
            const lead = source || r.title || r.subject;
            const tail = source ? (r.title || r.subject) : r.line;
            return (
              <div key={r.messageId} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 0', borderTop: `1px solid ${V.line}`, minWidth: 0 }}>
                <span style={{ flexShrink: 0, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><RowLink weight={600} onClick={() => openThread({ ...r, subject: r.subject || r.title })}>{lead}</RowLink></span>
                <span style={{ fontSize: 13, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{tail}</span>
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

  const entries = listOf(b.today?.entries, 'entries').filter((e) => e && e.id != null && !undone.includes(e.id));
  const undo = async (e) => {
    setUndoing(e.id);
    try {
      await v2Api.post('/sort/undo', { logId: e.id });
      setUndone((u) => [...u, e.id]);
      announceSortChange({ undo: e.id });
    } catch (err) {
      useStore.getState().addNotification?.({ type: 'error', title: tv('hedwig.v2.today.undoFailed', 'Could not undo that'), body: err?.message });
    } finally {
      setUndoing(null);
    }
  };
  const footer = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: `1px solid ${V.line}` }}>
      {entries.length > 0 && (
        <section aria-label={tv('hedwig.v2.brief.undoAny', 'Undo any of it')} style={{ display: 'flex', flexDirection: 'column' }}>
          {entries.map((e) => (
            <div key={e.id} data-undo-entry="" style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '6px 0', borderBottom: `1px solid ${V.line}`, fontSize: 13 }}>
              <Mono size={11}>{listTime(e.createdAt)}</Mono>
              <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text || e.subject || ''}</span>
              <LinkBtn hit={phone} disabled={undoing === e.id} onClick={() => undo(e)}>{tv('hedwig.v2.today.undo', 'Undo')}</LinkBtn>
            </div>
          ))}
        </section>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 12, color: V.muted, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
        {b.today && <span>{todayLine(b.today)}</span>}
        <LinkBtn onClick={() => showView(VIEW.today)} style={{ fontSize: 12, color: V.accentInk }}>{tv('hedwig.v2.today.review', 'Review or undo')}</LinkBtn>
      </div>
      <CoverageNote what="brief" coverage={b.coverage ?? null} style={{ fontSize: 12 }} />
    </div>
  );

  // The day in short: the summary box (spec §c) holding the headline. Sparkles when a model wrote
  // it, info when the template did; the note on the right says where the prose came from.
  const proseLine = proseNote(b.prose, status);
  const templated = Boolean(b.prose && typeof b.prose === 'object' && (b.prose.fallback || b.prose.source === 'template'));
  const lighter = Boolean(proseLine) && !templated;
  const note = proseLine || (noModel ? tv('hedwig.v2.brief.noModel', 'Compiled from your mail, no model call.') : null);
  const written = !noModel && !templated;
  const headline = (
    <Slip data-brief-summary="" style={{ gap: 6, width: '100%', maxWidth: phone ? 'none' : 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', color: written ? V.accent : V.muted }}><Icon name={written ? 'sparkles' : 'info'} size={14} strokeWidth={1.75} /></span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{tv('hedwig.v2.brief.summary', 'Today in short')}</span>
        <span style={{ flexGrow: 1 }} />
        {note && (
          <span data-lighter={lighter ? '' : undefined} title={note} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, lineHeight: '14px', color: V.muted, minWidth: 0 }}>
            <Icon name="info" size={12} strokeWidth={1.75} />
            <span>{note}</span>
          </span>
        )}
      </div>
      <h1 style={{ margin: 0, fontFamily: V.sans, fontWeight: 600, fontSize: 22, lineHeight: '28px', letterSpacing: '-0.01em', textWrap: 'balance' }}>
        {b.headline || title}
      </h1>
    </Slip>
  );
  const dateLine = <Mono size={12}>{briefDateLine(dayOf, compiledAt)}</Mono>;

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
        <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {state}
          {res.data && <>{headline}<TierNote />{askField}{left}{right}{footer}</>}
        </div>
      </ViewBody>
    );
  }

  return (
    <ViewBody label={title} padded={false} style={{ padding: '20px 24px 24px', gap: 20, background: V.content }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {dateLine}
        {res.data && headline}
        <TierNote />
        {askField}
      </header>
      {state}
      {res.data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 32, flexGrow: 1, alignItems: 'start' }}>
          {left}
          {right}
        </div>
      )}
      {res.data && footer}
    </ViewBody>
  );
}
