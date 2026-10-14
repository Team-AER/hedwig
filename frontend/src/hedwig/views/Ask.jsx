// hedwig.ask — ask a question across all mail on the v2 backend (stream G): a streamed answer with
// numbered citations, the sources it read, follow-ups that carry the earlier answer (followUpOf),
// what the citation check found (unsupported, nothing found, citations that named no source), a
// "Wrong answer" mark (POST /context/ask/:id/feedback), and the saved answers
// (GET /context/ask/history), which open as they were (GET /context/ask/:id) instead of asking again.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { v2Api, v2Stream, listOf } from '../v2/client.js';
import { useV2Resource } from '../v2/hooks.js';
import { openThread } from '../v2/nav.js';
import { ASK2_INITIAL, askStarted, fromSaved, historyMark, reduceAsk2, coverageGap, readingOrder, distinctQuestions } from '../v2/ask.js';
import { Btn, ErrorLine, Hair, IconButton, LinkBtn, Mono, Quiet, Reason, SectionLabel, V, ViewBody, ViewHead, usePhone } from '../v2/primitives.jsx';
import { Icon } from '../icons.jsx';
import { ASK_FIELD_CSS, askFieldStyle, askInputStyle } from '../v2/Brief.jsx';
import { fullTime, listTime } from '../v2/format.js';
import { tv, tvn } from '../v2/i18n.js';
import { Markdown } from './ui.jsx';
import { TierNote, LighterLabel } from '../v2/TierNote.jsx';
import { CoverageNote } from '../v2/CoverageNote.jsx';
import AskProgress from '../v2/AskProgress.jsx';
import { isLighter } from '../v2/tiers.js';
import { useShell } from '../shell/state.js';
import * as M from '../shell/model.js';

// Answers in 14px body text; the [n] markers are 10px accent superscripts (views/ui.jsx CITE_CSS).
const ASK_CSS = `.hw-ask2 .hw-md{font-size:14px;line-height:1.55}
.hw-ask2 .hw-md p{margin:0 0 10px}${ASK_FIELD_CSS}`;

// "renew [1]." reads as "renew¹." : the space before a citation marker goes.
const tidyCites = (text) => String(text || '').replace(/[ \t]+(\[(?:\d{1,3}(?:\s*,\s*\d{1,3})*|msg:[A-Za-z0-9_-]+)\])/g, '$1');

function sourceItem(m) {
  return { messageId: m.id, threadId: m.thread_key || undefined, subject: m.subject, from: { name: m.from_name, email: m.from_email }, date: m.date };
}

function markLabel(mark) {
  if (mark === 'wrong') return tv('hedwig.v2.ask.markWrong', 'marked wrong');
  if (mark === 'notFound') return tv('hedwig.v2.ask.markNotFound', 'nothing found');
  if (mark === 'unsupported') return tv('hedwig.v2.ask.unsupported', 'Unsupported');
  if (mark === 'unfinished') return tv('hedwig.v2.ask.markUnfinished', 'not finished');
  return null;
}

export default function Ask({ paneId = null, props = {} }) {
  const inputId = useId();
  const phone = Boolean(usePhone()?.phone);
  // Docked in the layout, a pane has no header outside Arrange, so Ask brings its own close.
  // The overlay drawer and phone screens already have one.
  const docked = useShell((s) => Boolean(paneId) && M.listPanes(s.tree).some((p) => p.node.key === paneId));
  const askPrompt = useHedwig((s) => s.askPrompt);
  const setAskPrompt = useHedwig((s) => s.setAskPrompt);
  const openView = useHedwig((s) => s.openView);
  const [question, setQuestion] = useState(props.question || '');
  const [scope, setScope] = useState({ entityId: props.entityId || null, topicId: props.topicId || null });
  const [state, setState] = useState(ASK2_INITIAL);
  const [chain, setChain] = useState([]); // earlier answers of this follow-up conversation
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const ctlRef = useRef(null);
  const scrollRef = useRef(null);
  const pinned = useRef(true);
  const inputRef = useRef(null);
  const autoRan = useRef('');
  const history = useV2Resource('/context/ask/history', { refreshOn: [] });

  useEffect(() => { setScope({ entityId: props.entityId || null, topicId: props.topicId || null }); }, [props.entityId, props.topicId]);
  // Leaving aborts the answer in flight; a remount (StrictMode in development) may ask it again.
  useEffect(() => () => { ctlRef.current?.abort(); autoRan.current = ''; }, []);

  const reloadHistory = history.reload;
  const followingUp = state.status === 'done' && state.id && !state.unfinished ? state : null;

  const run = useCallback(async (raw, { followUp = null, fresh = false } = {}) => {
    const q = String(raw || '').trim();
    if (!q) return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setError(null);
    setQuestion('');
    setChain((c) => (followUp && !fresh ? [...c, followUp] : []));
    setState(askStarted(q, { followUpOf: followUp?.id || null }));
    const body = { question: q };
    if (scope.entityId) body.entityId = scope.entityId;
    if (scope.topicId) body.topicId = scope.topicId;
    if (followUp?.id) body.followUpOf = followUp.id;
    try {
      await v2Stream('/context/ask', body, { signal: ctl.signal, onEvent: (ev) => setState((s) => reduceAsk2(s, ev)) });
      setState((s) => (s.status === 'streaming' ? { ...s, status: 'done' } : s));
      reloadHistory({ quiet: true });
    } catch (err) {
      if (ctl.signal.aborted) { setState((s) => ({ ...s, status: s.answer ? 'done' : 'idle' })); return; }
      setError(err);
      setState((s) => ({ ...s, status: 'error' }));
    }
  }, [scope, reloadHistory]);

  // Autorun once for a question handed over by another view or the palette.
  // Deferred a tick, so a mount that is undone at once (StrictMode in development) asks nothing.
  useEffect(() => {
    if (!props.question || autoRan.current === props.question) return undefined;
    const q = props.question;
    autoRan.current = q;
    const t = setTimeout(() => run(q), 0);
    return () => { clearTimeout(t); if (autoRan.current === q) autoRan.current = ''; };
  }, [props.question, run]);
  useEffect(() => {
    if (!askPrompt) return;
    setAskPrompt('');
    // The rail and the Brief hand the question over both ways; ask it once.
    if (askPrompt === autoRan.current) return;
    run(askPrompt);
  }, [askPrompt, setAskPrompt, run]);
  useEffect(() => { if (!props.question) inputRef.current?.focus({ preventScroll: true }); }, [props.question]);

  // A saved answer opens as its conversation: the answers it followed up on come first.
  const openSaved = async (entry) => {
    ctlRef.current?.abort();
    setError(null);
    setShowHistory(false);
    pinned.current = true;
    setChain([]);
    setState({ ...fromSaved(entry), status: 'loading' });
    try {
      const full = await v2Api.get(`/context/ask/${encodeURIComponent(entry.id)}`);
      setState(fromSaved(full));
      const earlier = [];
      for (let up = full?.followUpOf, n = 0; up && n < 10; n++) {
        const prev = await v2Api.get(`/context/ask/${encodeURIComponent(up)}`).catch(() => null);
        if (!prev) break;
        earlier.unshift(fromSaved(prev));
        up = prev.followUpOf;
      }
      if (earlier.length) setChain(earlier);
    } catch (err) {
      setState(fromSaved(entry));
      if (err?.status !== 404) setError(err);
    }
  };

  const startOver = () => { ctlRef.current?.abort(); setState(ASK2_INITIAL); setChain([]); setError(null); setShowHistory(false); inputRef.current?.focus(); };
  const submit = (e) => { e.preventDefault(); pinned.current = true; setShowHistory(false); run(question, { followUp: followingUp }); };
  const streaming = state.status === 'streaming';
  const entries = distinctQuestions(listOf(history.data, 'items').filter((h) => h && h.id), state.id);
  // A follow-up keeps its wording while it is being answered, not only once it is done.
  const followUpMode = Boolean(followingUp || state.followUpOf);
  const title = tv('hedwig.v2.ask.title', 'Ask');
  const turns = [...chain, ...(state.status !== 'idle' ? [state] : [])];
  const label = followUpMode ? tv('hedwig.v2.ask.followUpLabel', 'Ask a follow-up') : tv('hedwig.v2.brief.askLabel', 'Ask your mail');

  // The conversation stays scrolled to its newest line while the answer streams in, unless the
  // reader has scrolled up to read; asking again brings it back down (scrollRef, pinned).
  const onScroll = (e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current && !showHistory) el.scrollTop = el.scrollHeight;
  }, [chain, state.answer, state.steps, state.status, state.sources, showHistory]);
  // The field grows with the question, up to six lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [question]);

  const historyList = (
    <aside aria-label={tv('hedwig.v2.ask.history', 'Earlier questions')} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <SectionLabel as="h2" style={{ padding: '0 0 6px' }}>{tv('hedwig.v2.ask.history', 'Earlier questions')}</SectionLabel>
      {history.error && <ErrorLine error={history.error} onRetry={() => history.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {history.data && !entries.length && <span style={{ fontSize: 13, color: V.muted, padding: '8px 0' }}>{tv('hedwig.v2.ask.noHistory', 'Nothing asked yet.')}</span>}
      {entries.slice(0, 30).map((h) => {
        const mark = markLabel(historyMark(h));
        const on = state.id === h.id;
        return (
          <button
            key={h.id}
            type="button"
            aria-current={on ? 'true' : undefined}
            onClick={() => openSaved(h)}
            className="hw-row"
            style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px', minHeight: 44, border: 0, borderTop: `1px solid ${V.line}`, borderRadius: 0, background: on ? V.accentTint : 'none', color: V.ink, font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <span style={{ fontSize: 13, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{h.question}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <Mono>{listTime(h.created_at)}</Mono>
              {h.followUpOf && <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.ask.followUp', 'follow-up')}</span>}
              {mark && <Reason glyph={null} tone={historyMark(h) === 'wrong' ? 'attention' : 'muted'}>{mark}</Reason>}
            </span>
          </button>
        );
      })}
    </aside>
  );

  const empty = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: phone ? '8px 0' : '12px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '28px 12px 8px', textAlign: 'center', color: V.muted }}>
        <span style={{ width: 44, height: 44, borderRadius: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: V.accentTint, color: V.accentInk }}>
          <Icon name="sparkles" size={22} strokeWidth={1.6} />
        </span>
        <span style={{ fontSize: 13, maxWidth: 360 }}>{tv('hedwig.v2.ask.intro', 'Answers cite the messages they come from. Tap a number to open it.')}</span>
        <CoverageNote what="ask" />
      </div>
      {historyList}
    </div>
  );

  const conversation = (
    <div role="log" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 22, paddingBottom: 8 }}>
      {turns.map((t, i) => (
        <article key={t.id || `${i}:${t.question}`} className="hw-turn" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="hw-ask-bubble" style={{ maxWidth: '82%', padding: '8px 14px', borderRadius: '18px 18px 4px 18px', background: V.accent, color: V.onAccent, fontSize: phone ? 16 : 14, lineHeight: 1.4, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {t.question}
            </div>
          </div>
          <AnswerBlock
            state={t}
            phone={phone}
            onFeedback={(feedback) => {
              if (i === turns.length - 1 && t === state) setState((s) => ({ ...s, feedback }));
              else setChain((c) => c.map((x) => (x.id === t.id ? { ...x, feedback } : x)));
              reloadHistory({ quiet: true });
            }}
            onAgain={() => run(t.question, { fresh: true })}
            onAgent={getView('hedwig.agent') ? () => openView('hedwig.agent', { prompt: t.question }) : null}
          />
        </article>
      ))}
      <ErrorLine error={error} />
    </div>
  );

  const composer = (
    <form onSubmit={submit} style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: phone ? '8px 12px calc(8px + var(--hw-tabbar-space, 0px))' : '10px 16px 14px', borderTop: `1px solid ${V.line}` }}>
      <TierNote />
      {(scope.entityId || scope.topicId) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: V.muted }}>
          {scope.topicId && <LinkBtn muted hit={phone} onClick={() => setScope((s) => ({ ...s, topicId: null }))}>{tv('hedwig.v2.ask.dropTopic', 'Ask about everything, not just this topic')}</LinkBtn>}
          {scope.entityId && <LinkBtn muted hit={phone} onClick={() => setScope((s) => ({ ...s, entityId: null }))}>{tv('hedwig.v2.ask.dropPerson', 'Ask about everyone, not just this person')}</LinkBtn>}
        </div>
      )}
      <label htmlFor={inputId} className="hw-ask-field" style={{ ...askFieldStyle, height: 'auto', minHeight: phone ? 44 : 40, alignItems: 'flex-end', padding: '5px 5px 5px 14px', borderRadius: 20 }}>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          // Enter asks; Shift+Enter starts a new line.
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          placeholder={followUpMode ? tv('hedwig.v2.ask.followUpPlaceholder', 'and what about…') : tv('hedwig.v2.brief.askLabel', 'Ask your mail')}
          aria-label={label}
          style={{ ...askInputStyle, height: 'auto', resize: 'none', alignSelf: 'center', padding: '5px 0', lineHeight: '20px', maxHeight: 140, fontSize: phone ? 16 : 14, outline: 'none' }}
        />
        {streaming
          ? (
            <button type="button" onClick={() => ctlRef.current?.abort()} aria-label={tv('hedwig.v2.ask.stop', 'Stop')} title={tv('hedwig.v2.ask.stop', 'Stop')}
              style={{ width: 30, height: 30, borderRadius: 15, border: 0, padding: 0, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: V.ink, color: V.paper, cursor: 'pointer' }}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
            </button>
          )
          : <IconButton icon="arrow-up" primary type="submit" label={tv('hedwig.v2.brief.ask', 'Ask')} disabled={!question.trim()} size={30} style={{ borderRadius: 15, opacity: question.trim() ? 1 : 0.4 }} />}
      </label>
    </form>
  );

  const head = (
    <ViewHead
      phone={phone}
      title={title}
      sub={phone ? undefined : tv('hedwig.v2.ask.sub', 'across all your mail')}
      actions={(
        <span style={{ display: 'inline-flex', gap: 2, alignSelf: 'center' }}>
          <IconButton icon="history" label={tv('hedwig.v2.ask.history', 'Earlier questions')} active={showHistory} size={phone ? 44 : 28} onClick={() => setShowHistory((v) => !v)} style={{ color: showHistory ? V.accentInk : V.muted }} />
          {turns.length > 0 && <IconButton icon="compose" label={tv('hedwig.v2.ask.newQuestion', 'New question')} size={phone ? 44 : 28} onClick={startOver} style={{ color: V.muted }} />}
          {docked && !phone && <IconButton icon="close" label={tv('hedwig.v2.ask.close', 'Close Ask')} size={28} onClick={() => useShell.getState().closePane(paneId)} style={{ color: V.muted }} />}
        </span>
      )}
    />
  );

  return (
    <ViewBody phone={phone} label={title} padded={false} style={{ overflowY: 'hidden', padding: phone ? 0 : '20px 0 0' }}>
      <style>{ASK_CSS}</style>
      {head}
      <div ref={scrollRef} onScroll={onScroll} className="hw-ask2 hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: phone ? '12px 16px' : '4px 24px 12px' }}>
        {showHistory ? historyList : turns.length ? conversation : empty}
      </div>
      {composer}
    </ViewBody>
  );
}

function AnswerBlock({ state, phone, onFeedback, onAgain, onAgent }) {
  const [wrongOpen, setWrongOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [fbError, setFbError] = useState(null);
  const streaming = state.status === 'streaming' || state.status === 'loading';
  const done = state.status === 'done';
  const sources = state.sources || [];
  const bySource = new Map(sources.map((s) => [s.n, s.message]));
  const openSource = (n) => { const m = bySource.get(n); if (m?.id) openThread(sourceItem(m)); };
  // Citations renumbered 1, 2, 3 in reading order, the uncited sources after them.
  const ro = readingOrder(state.answer, sources);
  const anyCited = ro.sources.some((s) => s.cited);
  // Sources once answered: the cited ones (or the first eight when none is cited), the rest a tap away.
  const [allSources, setAllSources] = useState(false);
  const listed = allSources ? ro.sources : anyCited ? ro.sources.filter((s) => s.cited) : ro.sources.slice(0, 8);
  const moreSources = ro.sources.length - listed.length;
  // Nothing close enough to the question was found: no model was asked, and the canned sentence
  // the server sends says less than this line does.
  const nothing = done && state.notFound && !sources.length;
  const wrong = state.feedback?.wrong === true;
  const status = useHedwig((st) => st.status);
  const lighter = done && !nothing && Boolean(state.answer) && isLighter(state.provenance, status, { expected: 'reasoning' });

  const feedback = async (isWrong) => {
    if (!state.id) return;
    setSending(true);
    setFbError(null);
    try {
      const res = await v2Api.post(`/context/ask/${encodeURIComponent(state.id)}/feedback`, { wrong: isWrong, ...(isWrong && note.trim() ? { note: note.trim() } : {}) });
      onFeedback(res?.feedback || { wrong: isWrong, note: note.trim() || null });
      setWrongOpen(false);
      setNote('');
    } catch (e) {
      setFbError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-live="polite" aria-busy={streaming} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {state.saved && state.createdAt && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12, color: V.muted, fontVariantNumeric: 'tabular-nums' }}>
          <span>{tv('hedwig.v2.ask.savedAt', 'Saved answer from {{when}}', { when: fullTime(state.createdAt) })}</span>
          <LinkBtn hit={phone} onClick={onAgain}>{tv('hedwig.v2.ask.again', 'Ask again')}</LinkBtn>
        </div>
      )}
      <AskProgress state={state} />
      {nothing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{tv('hedwig.v2.ask.notFound', 'Nothing in your mail answers this.')}</p>
          <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.ask.noModel', 'No message came close enough, so no model was asked.')}</span>
        </div>
      )}
      {!nothing && (state.answer
        ? <Markdown text={tidyCites(ro.text)} onCite={(d) => openSource(ro.toSource(d))} />
        // The progress above says what is happening; this line is for a server that sends no steps.
        : streaming && !(state.steps || []).length && <Quiet style={{ padding: 0 }}>{sources.length ? tvn(sources.length, ['hedwig.v2.ask.readingOne', 'Reading 1 message…'], ['hedwig.v2.ask.readingMany', 'Reading {{n}} messages…']) : tv('hedwig.v2.ask.searching', 'Searching your mail…')}</Quiet>)}
      {(lighter || (done && coverageGap(state.coverage) && !nothing)) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {lighter && (
            <span title={state.provenance?.model || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: V.muted }}>
              <Icon name="info" size={12} strokeWidth={1.75} />
              <LighterLabel />
            </span>
          )}
          {done && !nothing && coverageGap(state.coverage) && (
            <span data-coverage="" style={{ fontSize: 11, lineHeight: '14px', color: V.muted }}>
              {tv('hedwig.v2.ask.coverage', 'Hedwig has read {{share}} of your mail so far; this answer comes from that part.', { share: coverageGap(state.coverage) })}
            </span>
          )}
        </div>
      )}
      {done && !nothing && state.notFound && <Reason tone="ink">{tv('hedwig.v2.ask.notFound', 'Nothing in your mail answers this.')}</Reason>}
      {done && state.unsupported && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Reason glyph="alert" tone="attention">{tv('hedwig.v2.ask.unsupported', 'Unsupported')}</Reason>
          <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.ask.unsupportedWhy', 'The answer cites none of your messages. Check it before you rely on it.')}</span>
        </div>
      )}
      {done && state.invalidCitations?.length > 0 && (
        <span style={{ fontSize: 12, color: V.muted }}>
          {tvn(state.invalidCitations.length, ['hedwig.v2.ask.invalidOne', 'Citation {{list}} named no source and was removed.'], ['hedwig.v2.ask.invalidMany', 'Citations {{list}} named no source and were removed.'], { list: state.invalidCitations.map((n) => `[${n}]`).join(' ') })}
        </span>
      )}
      {state.status === 'error' && !state.answer && <ErrorLine error={new Error(state.error || tv('hedwig.v2.ask.failed', 'The answer failed.'))} onRetry={onAgain} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}

      {done && !nothing && state.id && (
        <div style={{ display: 'flex', gap: phone ? 8 : 12, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4 }}>
          {!wrong && !wrongOpen && <LinkBtn hit={phone} onClick={() => setWrongOpen(true)}>{tv('hedwig.v2.ask.wrong', 'Wrong answer')}</LinkBtn>}
          {wrong && (
            <>
              <Reason glyph="check" tone="accent">{tv('hedwig.v2.ask.markedWrong', 'Marked wrong. Hedwig learns from this.')}</Reason>
              <IconButton icon="undo" data-undo="" label={tv('hedwig.v2.today.undo', 'Undo')} size={phone ? 44 : 28} disabled={sending} onClick={() => feedback(false)} style={{ color: V.muted }} />
            </>
          )}
          {state.answer && <IconButton icon="copy" data-copy="" label={tv('hedwig.v2.ask.copy', 'Copy')} size={phone ? 44 : 28} onClick={() => navigator.clipboard?.writeText(ro.text)} style={{ color: V.muted }} />}
          {onAgent && <LinkBtn muted hit={phone} onClick={onAgent}>{tv('hedwig.v2.ask.agent', 'Ask the agent instead')}</LinkBtn>}
        </div>
      )}
      {wrongOpen && (
        <form onSubmit={(e) => { e.preventDefault(); feedback(true); }} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tv('hedwig.v2.ask.wrongNote', 'What was wrong? (optional)')}
            aria-label={tv('hedwig.v2.ask.wrongNoteLabel', 'What was wrong with the answer')}
            maxLength={1000}
            style={{ flex: '1 1 220px', minWidth: 0, height: phone ? 44 : 30, boxSizing: 'border-box', padding: '0 10px', border: `1px solid ${V.line}`, background: V.field, font: 'inherit', fontSize: phone ? 16 : 13, color: V.ink, borderRadius: 8 }}
          />
          <Btn accent type="submit" size={phone ? 'lg' : 'md'} disabled={sending}>{tv('hedwig.v2.ask.markWrongBtn', 'Mark it wrong')}</Btn>
          <LinkBtn muted hit={phone} onClick={() => setWrongOpen(false)}>{tv('hedwig.v2.action.cancel', 'Cancel')}</LinkBtn>
        </form>
      )}
      {fbError && <ErrorLine error={fbError} />}

      {sources.length > 0 && !streaming && (
        <section aria-label={tv('hedwig.v2.ask.sources', 'Sources')} style={{ display: 'flex', flexDirection: 'column', paddingTop: 6 }}>
          <SectionLabel as="h3" style={{ padding: '0 0 4px' }}>{tv('hedwig.v2.ask.sources', 'Sources')}</SectionLabel>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {listed.map((s, i) => {
              const m = s.message || {};
              const isCited = !anyCited || s.cited;
              return (
                <li key={s.source}>
                  {i > 0 && <Hair />}
                  <button
                    type="button"
                    onClick={() => openSource(s.source)}
                    style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'baseline', width: '100%', padding: '10px 0', minHeight: 44, border: 0, background: 'none', color: isCited ? V.ink : V.muted, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}
                  >
                    <Mono size={11} color={isCited ? V.accentInk : V.muted} style={{ fontWeight: 600 }}>{s.n}</Mono>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 500 }}>{m.from_name || m.from_email || ''}</span>
                      {m.subject ? ` · ${m.subject}` : ''}
                    </span>
                    <Mono>{listTime(m.date)}</Mono>
                  </button>
                </li>
              );
            })}
          </ol>
          {moreSources > 0 && (
            <LinkBtn muted hit={phone} onClick={() => setAllSources(true)} style={{ alignSelf: 'flex-start', marginTop: 4, fontSize: 12 }}>
              {tvn(moreSources, ['hedwig.v2.ask.moreSourcesOne', 'Show 1 more message it read'], ['hedwig.v2.ask.moreSourcesMany', 'Show {{n}} more messages it read'])}
            </LinkBtn>
          )}
        </section>
      )}
    </section>
  );
}
