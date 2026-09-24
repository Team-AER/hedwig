// The thread (docs/hedwig/design Main + PhoneThread): title and meta, Done / Reply Later / Snooze
// / Set Aside, the story so far with superscript citations, the deadline slip, the earlier
// messages folded away, the latest message with Hedwig's reason and Change, the tracker note,
// quick replies and the reply bar (Draft in my voice, Send).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { MenuButton } from '../shell/Menu.jsx';
import { openMessage } from '../views/hooks.js';
import { useV2 } from './state.js';
import { v2Api, SORT_EVENTS } from './client.js';
import { isMissing, useWork } from './hooks.js';
import { loadThread, loadBody } from './threadData.js';
import { archiveThread, addToList, snooze, snoozeTimes, prepareReply, guardReply, sendPrepared, watchForReply, settingValue } from './mail.js';
import { MessageCards } from './Cards.jsx';
import { Question } from './Question.jsx';
import { useWhyDoor } from './WhyDoor.jsx';
import { Btn, Glyph, IconBtn, LinkBtn, Mono, Quiet, Sheet, Slip, V, Why, ErrorLine, usePhone } from './primitives.jsx';
import { firstName, fullTime, listTime, senderName, slipDate, storyParts } from './format.js';
import { tv, tvn } from './i18n.js';
import { LighterLabel } from './TierNote.jsx';
import { isLighter } from './tiers.js';

function useThread(item) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(item) });
  const key = item ? (item.threadId || item.messageId) : null;
  const seq = useRef(0);
  const load = useCallback(async (quiet = false, refresh = false) => {
    if (!item) { setState({ data: null, error: null, loading: false }); return; }
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ data: s.data && s.key === key ? s.data : null, error: null, loading: true, key }));
    try {
      const data = await loadThread(item, { refresh });
      if (my === seq.current) setState({ data, error: null, loading: false, key });
    } catch (error) {
      if (my === seq.current) setState({ data: null, error, loading: false, key });
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function useWhy(messageId, fallback) {
  const [why, setWhy] = useState(null);
  useEffect(() => {
    let alive = true;
    setWhy(null);
    if (!messageId) return undefined;
    const get = () => v2Api.get(`/sort/message/${encodeURIComponent(messageId)}/why`).then((d) => { if (alive) setWhy(d); }).catch(() => { if (alive) setWhy(null); });
    get();
    const names = SORT_EVENTS;
    for (const n of names) window.addEventListener(n, get);
    return () => { alive = false; for (const n of names) window.removeEventListener(n, get); };
  }, [messageId]);
  return why?.reason || fallback || null;
}

/** The open question about this message, asked inline (GET /labels/questions/for/:messageId). */
function useInlineQuestion(messageId) {
  const [question, setQuestion] = useState(null);
  useEffect(() => {
    let alive = true;
    setQuestion(null);
    if (!messageId) return undefined;
    v2Api.get(`/labels/questions/for/${encodeURIComponent(messageId)}`)
      .then((d) => { if (alive && d?.question?.id && d.question.question) setQuestion(d.question); })
      .catch(() => {});
    return () => { alive = false; };
  }, [messageId]);
  return [question, setQuestion];
}

function Story({ text, onCite, phone }) {
  const parts = storyParts(text);
  return (
    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, textWrap: 'pretty' }}>
      {parts.map((p, i) => (p.cite != null
        ? (
          <button
            key={i}
            type="button"
            onClick={() => onCite(p.cite)}
            aria-label={tv('hedwig.v2.thread.citation', 'Message {{n}}', { n: p.cite })}
            className={phone ? 'hw-hit' : undefined}
            style={{ fontFamily: V.mono, fontSize: 11, verticalAlign: 'super', marginLeft: 2, color: V.accentInk, padding: 0, border: 0, background: 'none', cursor: 'pointer', lineHeight: 1 }}
          >
            {p.cite}
          </button>
        )
        : <span key={i}>{p.text}</span>))}
    </p>
  );
}

function DeadlineSlip({ deadline, from, phone, onRemind, onWrong }) {
  const who = firstName(from);
  const note = deadline.note && deadline.note !== 'you' && deadline.note !== 'they'
    ? deadline.note
    : deadline.note === 'they'
      ? tv('hedwig.v2.thread.deadlineTheirs', 'Deadline, promised by {{who}}', { who })
      : tv('hedwig.v2.thread.deadlineAsked', 'Deadline, asked by {{who}}', { who });
  const dayBefore = new Date(new Date(deadline.due_at).getTime() - 86400000);
  const remindLabel = tv('hedwig.v2.thread.remindOn', 'Remind me {{day}}', { day: dayBefore.toLocaleDateString(undefined, { weekday: 'short' }).replace(/\.$/, '') });
  if (phone) {
    return (
      <Slip style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }} aria-label={tv('hedwig.v2.thread.deadline', 'Deadline')}>
        <span style={{ fontFamily: V.serif, fontSize: 36, lineHeight: 1, flexShrink: 0 }}>{slipDate(deadline.due_at)}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flexGrow: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{deadline.what}</span>
          <span style={{ fontSize: 12, color: V.inkSoft }}>{note}</span>
        </div>
        <LinkBtn onClick={onRemind} style={{ minHeight: 44 }}>{tv('hedwig.v2.thread.remind', 'Remind me')}</LinkBtn>
      </Slip>
    );
  }
  return (
    <Slip aria-label={tv('hedwig.v2.thread.deadline', 'Deadline')}>
      <span style={{ fontFamily: V.serif, fontSize: 34, lineHeight: 1 }}>{slipDate(deadline.due_at)}</span>
      <span style={{ fontSize: 13, marginTop: 6 }}>{deadline.what}</span>
      <span style={{ fontSize: 12, color: V.inkSoft }}>{note}</span>
      <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
        <LinkBtn onClick={onRemind}>{remindLabel}</LinkBtn>
        {onWrong && <LinkBtn muted onClick={onWrong}>{tv('hedwig.v2.thread.wrong', 'Wrong?')}</LinkBtn>}
      </div>
    </Slip>
  );
}

function MessageBlock({ m, n, you, phone, tldr = null, children }) {
  const to = m.to && m.to !== 'you' ? tv('hedwig.v2.thread.toName', 'to {{name}}', { name: m.to }) : tv('hedwig.v2.thread.toYou', 'to you');
  const article = (
    <article id={`hw-msg-${n}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 0 0', borderTop: `1px solid ${V.line2}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontWeight: 600, fontSize: phone ? 16 : 15 }}>{you ? tv('hedwig.v2.thread.you', 'You') : senderName(m.from)}</span>
        <span style={{ fontSize: 12, color: V.muted }} title={fullTime(m.date)}>{phone ? listTime(m.date) : `${to} · ${listTime(m.date)}`}</span>
        <span style={{ flexGrow: 1 }} />
        <Mono>{n}</Mono>
      </div>
      {tldr && (
        <p data-tldr="" aria-label={tv('hedwig.v2.thread.tldrLabel', 'In short: {{text}}', { text: tldr })} style={{ margin: 0, fontSize: 14, lineHeight: 1.45, color: V.muted, maxWidth: '62ch', textWrap: 'pretty' }}>
          {tldr}
        </p>
      )}
      <p style={{ margin: 0, fontSize: 16, lineHeight: phone ? 1.55 : 1.6, maxWidth: '62ch', textWrap: 'pretty', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {m.text ?? m.snippet ?? ''}
      </p>
      {children}
    </article>
  );
  // The cards Hedwig read from a message sit above it.
  if (!m.id) return article;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <MessageCards messageId={m.id} phone={phone} />
      {article}
    </div>
  );
}

function EarlierMessages({ messages, open, onToggle, myEmails, phone, tldrs = {} }) {
  const [bodies, setBodies] = useState({});
  useEffect(() => {
    if (!open) return;
    for (const m of messages) {
      if (m.text != null || bodies[m.id]) continue;
      setBodies((b) => ({ ...b, [m.id]: { loading: true } }));
      loadBody(m.id).then((b) => setBodies((x) => ({ ...x, [m.id]: b }))).catch(() => setBodies((x) => ({ ...x, [m.id]: { text: m.snippet } })));
    }
  }, [open, messages]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!messages.length) return null;
  const range = messages.length === 1 ? '1' : `1–${messages.length}`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{ font: 'inherit', display: 'flex', alignItems: 'baseline', gap: 10, padding: phone ? '2px 0 12px' : '6px 0 14px', fontSize: 13, color: V.muted, textAlign: 'left', width: '100%', border: 0, background: 'none', cursor: 'pointer', minHeight: phone ? 44 : undefined }}
      >
        <Mono>{range}</Mono>
        <span>{tvn(messages.length, ['hedwig.v2.thread.earlierOne', 'One earlier message'], ['hedwig.v2.thread.earlierMany', '{{n}} earlier messages'])}</span>
        <span style={{ flexGrow: 1 }} />
        <span className="hw-link" style={{ fontSize: 13, fontWeight: 500, color: V.ink }}>{open ? tv('hedwig.v2.records.hide', 'Hide') : tv('hedwig.v2.records.show', 'Show')}</span>
      </button>
      {open && messages.map((m, i) => {
        const b = bodies[m.id];
        const shown = { ...m, text: m.text ?? (b?.loading ? tv('hedwig.v2.loading', 'Loading…') : b?.text ?? m.snippet) };
        return (
          <div key={m.id} style={{ paddingBottom: 14 }}>
            <MessageBlock m={shown} n={i + 1} you={myEmails.has(String(m.from?.email || '').toLowerCase())} phone={phone} tldr={tldrs[m.id] || null} />
          </div>
        );
      })}
    </div>
  );
}

const WAIT_DAYS = [1, 2, 3, 5, 7, 10, 14];
function defaultWaitDays() {
  const n = Math.round(Number(settingValue('work.waitingDefaultDays', 3)));
  return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : 3;
}

/** The reply bar's "remind me if no reply" checkbox with its number of days. */
function RemindIfNoReply({ on, days, onToggle, onDays, phone }) {
  const options = WAIT_DAYS.includes(days) ? WAIT_DAYS : [...WAIT_DAYS, days].sort((a, b) => a - b);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: V.muted }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: phone ? 44 : 28, cursor: 'pointer' }}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} style={{ accentColor: 'var(--hw-accent)', width: phone ? 20 : 16, height: phone ? 20 : 16, margin: 0 }} />
        {tv('hedwig.v2.waiting.remindIfNoReply', 'Remind me if no reply')}
      </label>
      <select
        value={days}
        onChange={(e) => { onDays(Number(e.target.value)); onToggle(true); }}
        aria-label={tv('hedwig.v2.waiting.remindAfter', 'Remind me after')}
        style={{ height: phone ? 44 : 28, border: 0, borderBottom: `1px solid ${V.line2}`, background: 'transparent', color: on ? V.ink : V.muted, font: 'inherit', fontSize: 13, borderRadius: 0, cursor: 'pointer' }}
      >
        {options.map((n) => <option key={n} value={n}>{tvn(n, ['hedwig.v2.waiting.inOneDay', 'in 1 day'], ['hedwig.v2.waiting.inDays', 'in {{n}} days'])}</option>)}
      </select>
    </div>
  );
}

export default function Thread({ props }) {
  const phoneCtx = usePhone();
  const phone = Boolean(phoneCtx?.phone);
  const selected = useV2((s) => s.selected);
  const helpMeWrite = useV2((s) => s.prefs.helpMeWrite);
  const accounts = useStore((s) => s.accounts);
  const work = useWork();
  const status = useHedwig((s) => s.status);
  const item = props?.item || selected;
  const t = useThread(item);
  const door = useWhyDoor();
  const [showEarlier, setShowEarlier] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [warnings, setWarnings] = useState(null); // { body, list } from the send guard
  const [watchOn, setWatchOn] = useState(false);      // "remind me if no reply in N days"
  const [remindDays, setRemindDays] = useState(() => defaultWaitDays());
  const inputRef = useRef(null);

  useEffect(() => { setShowEarlier(false); setDraft(''); setActionError(null); setWarnings(null); setWatchOn(false); setRemindDays(defaultWaitDays()); }, [item?.messageId]);

  const data = t.data;
  const messages = data?.messages || [];
  const latest = messages[messages.length - 1];
  const earlier = messages.slice(0, -1);
  const reason = useWhy(latest?.id && item ? item.messageId : null, item?.reason);
  const [question, setQuestion] = useInlineQuestion(latest?.id || null);
  const myEmails = new Set((accounts || []).flatMap((a) => [a.email_address, ...(a.aliases || []).map((x) => x.email)]).filter(Boolean).map((e) => e.toLowerCase()));

  const run = async (key, fn) => {
    setBusy(key);
    setActionError(null);
    try { return await fn(); } catch (e) {
      setActionError(isMissing(e) ? new Error(tv('hedwig.v2.notYet', 'Not available yet.')) : e);
      return undefined;
    } finally { setBusy(null); }
  };

  if (!item) {
    return (
      <div className="hw-v2" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
        <Why size={20}>{tv('hedwig.v2.thread.empty', 'Pick a conversation to read it here.')}</Why>
      </div>
    );
  }

  const title = data?.subject || item.subject || '';
  const people = data?.participants || (data?.people?.length
    ? tv('hedwig.v2.thread.andYou', '{{names}} and you', { names: data.people.filter((p) => !myEmails.has(String(p).toLowerCase())).slice(0, 3).join(', ') || senderName(item.from) })
    : senderName(item.from));
  const meta = [people, messages.length ? tvn(messages.length, ['hedwig.v2.thread.messagesOne', '1 message'], ['hedwig.v2.thread.messagesMany', '{{n}} messages']) : null, !phone ? data?.label : null].filter(Boolean).join(' · ');
  const replyTo = firstName(latest?.from || item.from);
  const whyItem = { ...item, messageId: item.messageId, reason };

  const done = () => run('done', async () => {
    await archiveThread(messages.map((m) => ({ id: m.id, folder: m.folder })));
    useV2.getState().select(null);
    if (phone) phoneCtx?.back?.();
  });
  const threadId = item.threadId || item.messageId;
  const later = () => run('later', () => addToList('replyLater', threadId));
  const aside = () => run('aside', () => addToList('setAside', threadId));
  const snoozeItems = () => snoozeTimes().map((s) => ({ id: s.id, label: s.label, onSelect: () => run('snooze', () => snooze(item.messageId, s.until, threadId)) }));
  const showOriginal = async () => {
    const row = await openMessage(latest?.id || item.messageId);
    if (row && !phone) useHedwig.getState().openView('core.thread');
  };

  // A citation names a message: by id (the work route's citations) or by its number (older shape).
  const onCite = (n) => {
    const id = data?.story?.cites?.[n];
    const idx = id ? messages.findIndex((m) => m.id === id) : n - 1;
    if (idx < 0) return;
    if (idx < messages.length - 1) setShowEarlier(true);
    requestAnimationFrame(() => document.getElementById(`hw-msg-${idx + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const remind = () => {
    const due = new Date(data.deadline.due_at);
    const until = new Date(due.getTime() - 86400000);
    until.setHours(9, 0, 0, 0);
    return run('remind', () => snooze(item.messageId, until > new Date() ? until : new Date(Date.now() + 3600000), threadId));
  };
  const wrongDeadline = data?.deadline?.source === 'commitment' && data.deadline.id
    ? () => run('wrong', async () => {
      await hedwigApi.patch(`/context/commitments/${encodeURIComponent(data.deadline.id)}`, { status: 'dismissed' });
      t.reload(true);
    })
    : null;

  // POST /work/draft: what is typed so far is the intent ("say yes but not before Friday").
  const draftInVoice = () => run('draft', async () => {
    const intent = draft.trim();
    const res = await v2Api.post('/work/draft', { threadId, ...(intent ? { intent } : {}) });
    const text = res?.draft || res?.after;
    if (text) { setDraft(text); setWarnings(null); requestAnimationFrame(() => inputRef.current?.focus()); }
  });
  // The send guard runs first; its warnings show above the bar and the button becomes "Send
  // anyway". It never blocks: a second press with the same text sends.
  const send = () => run('send', async () => {
    const body = draft.trim();
    if (!body) return;
    const payload = await prepareReply(latest?.id || item.messageId, body);
    if (!payload) return;
    if (warnings?.body !== body) {
      const list = await guardReply(payload, threadId);
      if (list.length) { setWarnings({ body, list }); return; }
    }
    await sendPrepared(payload);
    setDraft('');
    setWarnings(null);
    if (watchOn) { setWatchOn(false); await watchForReply(threadId, remindDays); }
  });
  const warned = warnings && warnings.body === draft.trim() ? warnings.list : null;

  const trackerNote = latest?.trackersBlocked
    ? tvn(latest.trackersBlocked, ['hedwig.v2.thread.trackerOne', '1 tracker blocked'], ['hedwig.v2.thread.trackerMany', 'Trackers blocked: {{n}}'])
    : latest?.hasBlockedRemoteImages ? tv('hedwig.v2.thread.imagesBlocked', 'Remote images blocked') : null;

  const actions = (
    <div style={{ display: 'flex', gap: 8, flexShrink: 0, paddingTop: 4 }}>
      <Btn solid disabled={Boolean(busy)} onClick={done}>{tv('hedwig.v2.thread.done', 'Done')}</Btn>
      {work && <Btn disabled={Boolean(busy)} onClick={later}>{tv('hedwig.v2.rail.replyLater', 'Reply Later')}</Btn>}
      <MenuButton label={tv('hedwig.v2.thread.snooze', 'Snooze')} items={snoozeItems} align="right" width={220} buttonClassName="hw-btn"
        buttonStyle={{ display: 'inline-flex', alignItems: 'center', height: 36, padding: '0 14px', borderRadius: 9, border: `1px solid ${V.line2}`, background: 'transparent', color: V.ink, font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
      >
        {tv('hedwig.v2.thread.snooze', 'Snooze')}
      </MenuButton>
      {work && <Btn disabled={Boolean(busy)} onClick={aside}>{tv('hedwig.v2.thread.setAside', 'Set Aside')}</Btn>}
    </div>
  );

  const quick = helpMeWrite && data?.quickReplies?.length ? data.quickReplies : [];
  const replyBar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {quick.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: phone ? 'nowrap' : 'wrap', overflowX: phone ? 'auto' : undefined, scrollbarWidth: phone ? 'none' : undefined }}>
          {quick.map((q) => <Btn key={q} size={phone ? 'phone' : 'md'} disabled={Boolean(busy)} onClick={() => { setDraft(q); inputRef.current?.focus(); }}>{q}</Btn>)}
        </div>
      )}
      {warned && (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {warned.map((w, i) => <Why key={i} tone="accent" size={15}>{w.text || w.message}</Why>)}
        </div>
      )}
      {work && (
        <RemindIfNoReply phone={phone} on={watchOn} days={remindDays} onToggle={setWatchOn} onDays={setRemindDays} />
      )}
      <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', alignItems: 'center', gap: phone ? 10 : 12 }}>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tv('hedwig.v2.thread.replyTo', 'Reply to {{name}}…', { name: replyTo })}
          aria-label={tv('hedwig.v2.thread.replyToLabel', 'Reply to {{name}}', { name: replyTo })}
          style={{ flexGrow: 1, minWidth: 0, height: phone ? 40 : 38, border: 0, borderBottom: `1px solid ${V.line2}`, background: 'transparent', font: 'inherit', fontSize: 15, color: V.ink, outline: 'none', borderRadius: 0 }}
        />
        {helpMeWrite && work && (
          <LinkBtn hit={phone} disabled={Boolean(busy)} onClick={draftInVoice} style={{ flexShrink: 0 }}>
            {busy === 'draft' ? tv('hedwig.v2.thread.drafting', 'Drafting…') : phone ? tv('hedwig.v2.thread.myVoice', 'My voice') : tv('hedwig.v2.thread.draftVoice', 'Draft in my voice')}
          </LinkBtn>
        )}
        {phone
          ? <IconBtn accent type="submit" label={warned ? tv('hedwig.v2.thread.sendAnyway', 'Send anyway') : tv('hedwig.v2.thread.send', 'Send')} disabled={Boolean(busy) || !draft.trim()}><Glyph name="send" /></IconBtn>
          : <Btn solid type="submit" disabled={Boolean(busy) || !draft.trim()}>{busy === 'send' ? tv('hedwig.v2.thread.sending', 'Sending…') : warned ? tv('hedwig.v2.thread.sendAnyway', 'Send anyway') : tv('hedwig.v2.thread.send', 'Send')}</Btn>}
      </form>
    </div>
  );

  const whyLine = latest && (reason || trackerNote) && (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      {reason && <Why>{reason}</Why>}
      {reason && <LinkBtn hit={phone} onClick={(e) => door.open(whyItem, e.currentTarget)} aria-haspopup="dialog">{tv('hedwig.v2.thread.change', 'Change')}</LinkBtn>}
      {trackerNote && <span style={{ fontSize: 12, color: V.muted }}>{trackerNote}</span>}
      <LinkBtn hit={phone} muted onClick={showOriginal}>{tv('hedwig.v2.thread.original', 'Show original')}</LinkBtn>
    </div>
  );

  const body = (
    <>
      {t.error && <ErrorLine error={t.error} onRetry={() => t.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {t.loading && !data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {data && (
        <>
          {(data.story || data.deadline) && (
            <div style={{ display: 'grid', gridTemplateColumns: !phone && data.story && data.deadline ? 'minmax(0, 1fr) 236px' : 'minmax(0, 1fr)', gap: phone ? 16 : 24, alignItems: 'start' }}>
              {data.story && (
                <section aria-label={tv('hedwig.v2.thread.story', 'The story so far')} style={{ display: 'flex', flexDirection: 'column', gap: phone ? 6 : 8, padding: phone ? '0 0 14px' : '14px 0', borderTop: phone ? 0 : `1px solid ${V.line2}`, borderBottom: `1px solid ${V.line}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <Why>{tv('hedwig.v2.thread.story', 'The story so far')}</Why>
                    {isLighter(data.storyProvenance, status) && <LighterLabel what="story" size={13} />}
                  </div>
                  <Story text={data.story.text} onCite={onCite} phone={phone} />
                </section>
              )}
              {data.deadline && <DeadlineSlip deadline={data.deadline} from={latest?.from || item.from} phone={phone} onRemind={remind} onWrong={wrongDeadline} />}
            </div>
          )}
          {!data.story && data.tldr && messages.length > 1 && (
            <section aria-label={tv('hedwig.v2.thread.inShort', 'In short')} style={{ padding: phone ? '0 0 10px' : '10px 0', borderTop: phone ? 0 : `1px solid ${V.line2}`, borderBottom: `1px solid ${V.line}` }}>
              <p data-thread-tldr="" style={{ margin: 0, fontSize: 15, lineHeight: 1.5, textWrap: 'pretty' }}>{data.tldr}</p>
            </section>
          )}
          {!data.story && data.storyProblem && messages.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', paddingBottom: 4 }}>
              <Why size={15}>{data.storyProblem === 'budget'
                ? tv('hedwig.v2.thread.storyBudget', 'Today’s budget for summaries is spent; the story so far is back tomorrow.')
                : tv('hedwig.v2.thread.storyFailed', 'Hedwig could not write the story so far just now.')}
              </Why>
              {data.storyProblem !== 'budget' && (
                <LinkBtn hit={phone} disabled={t.loading || Boolean(busy)} onClick={() => t.reload(true, true)}>{tv('hedwig.v2.action.retry', 'Try again')}</LinkBtn>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
            <EarlierMessages messages={earlier} open={showEarlier} onToggle={() => setShowEarlier((v) => !v)} myEmails={myEmails} phone={phone} tldrs={data.messageTldrs || {}} />
            {latest && (
              <MessageBlock m={latest} n={messages.length} you={myEmails.has(String(latest.from?.email || '').toLowerCase())} phone={phone} tldr={data.messageTldrs?.[latest.id] || null}>
                {whyLine}
                {question && <Question question={question} compact phone={phone} onDone={() => setQuestion(null)} />}
              </MessageBlock>
            )}
          </div>
        </>
      )}
      <ErrorLine error={actionError} />
    </>
  );

  if (phone) {
    const moreItems = () => [
      ...(work ? [{ id: 'later', label: tv('hedwig.v2.rail.replyLater', 'Reply Later'), onSelect: later }] : []),
      ...snoozeItems().map((s) => ({ ...s, label: `${tv('hedwig.v2.thread.snooze', 'Snooze')}: ${s.label}` })),
      ...(work ? [{ id: 'aside', label: tv('hedwig.v2.thread.setAside', 'Set Aside'), onSelect: aside }] : []),
      { id: 'original', label: tv('hedwig.v2.thread.original', 'Show original'), onSelect: showOriginal },
    ];
    return (
      <section className="hw-v2" aria-label={title} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', color: V.ink, fontFamily: V.sans }}>
        <Sheet as="header" phone radius={0} style={{ position: 'relative', zIndex: 3, borderTop: 0, borderRadius: '0 0 28px 28px', padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 10px) 12px 10px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <IconBtn label={tv('hedwig.v2.thread.back', 'Back')} onClick={() => phoneCtx?.back?.()}><Glyph name="back" /></IconBtn>
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontFamily: V.serif, fontSize: 20, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
            <span style={{ fontSize: 12, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</span>
          </div>
          <IconBtn solid label={tv('hedwig.v2.thread.done', 'Done')} disabled={Boolean(busy)} onClick={done}><Glyph name="check" /></IconBtn>
          <MenuButton label={tv('hedwig.v2.thread.more', 'More')} items={moreItems} align="right" width={240} buttonClassName="hw-btn-quiet"
            buttonStyle={{ width: 44, height: 44, minWidth: 44, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, border: 0, background: 'transparent', color: V.ink, cursor: 'pointer', padding: 0 }}
          >
            <Glyph name="more" />
          </MenuButton>
        </Sheet>
        <div className="hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {body}
        </div>
        <Sheet as="footer" phone radius={0} style={{ position: 'relative', zIndex: 3, borderBottom: 0, borderRadius: '28px 28px 0 0', padding: '14px 16px calc(14px + env(safe-area-inset-bottom, 0px))', flexShrink: 0 }}>
          {replyBar}
        </Sheet>
        {door.element}
      </section>
    );
  }

  return (
    <section className="hw-v2 hw-scroll" aria-label={title} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 18, padding: '30px 36px 24px', overflowY: 'auto', color: V.ink, fontFamily: V.sans, fontSize: 14, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        {/* A title narrower than this wraps to four lines beside the actions; the actions go under it instead. */}
        <div style={{ flex: '1 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 style={{ margin: 0, fontFamily: V.serif, fontWeight: 400, fontSize: 34, lineHeight: 1.05, letterSpacing: '-0.015em', textWrap: 'pretty' }}>{title}</h2>
          <span style={{ fontSize: 13, color: V.muted }}>{meta}</span>
        </div>
        {actions}
      </div>
      {body}
      <div style={{ flexGrow: 1 }} />
      <div style={{ paddingTop: 14, borderTop: `1px solid ${V.line2}` }}>{replyBar}</div>
      {door.element}
    </section>
  );
}
