// The reader (DESIGN-AUDIT-2026-09-24 §c, §d, §g). A 48px glass toolbar (Done, Delete, Junk, Flag;
// Reply Later, Snooze, Set Aside; Reply, Reply all, Forward; Move, More), the subject with its reason and
// Change, the summary or story so far with superscript citations, the deadline and the cards in
// the same box, then the messages: the newest and every unread one open, older read ones as 44px
// rows, more than four of those folded into one. HTML bodies render in upstream's sandboxed frame
// (MessageBodyView) on a white card (in the dark theme, smart dark mode: a darkened mail on the
// content colour, with a sun / moon per message to show its original colours), quoted history
// behind a "•••" toggle, remote images behind a consent banner, attachments under each body. The reply bar sits at the bottom (sticky): a 40px
// field that grows on focus with Draft in my voice, Remind me if no reply and Send (⌘↩).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../../store/index.js';
import { buildKeyMap } from '../../utils/defaultShortcuts.js';
import { shortcutBus } from '../../utils/shortcutBus.js';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { Icon } from '../icons.jsx';
import { MenuButton } from '../shell/Menu.jsx';
import { openMessage } from '../views/hooks.js';
import MessageBodyView from '../../components/MessageBodyView.jsx';
import MessageHeaderModal from '../../components/MessageHeaderModal.jsx';
import AttachmentChips from '../../components/AttachmentChips.jsx';
import { mailDarkWanted, normaliseMailDark, senderMailDark, setSenderMailDark, subscribeSenderMailDark } from '../../utils/mailDarkMode.js';
import { useV2 } from './state.js';
import { v2Api, isMockMode, SORT_EVENTS } from './client.js';
import { isMissing, useRegenerate, useWork } from './hooks.js';
import { loadThread, loadFullBody, regenerateStory, regenerateTldr, isRewriting } from './threadData.js';
import { putTldr } from './tldrs.js';
import { isDraftMessage, openDraft, getReplyDraft, setReplyDraft, clearReplyDraft } from './drafts.js';
import {
  snooze, snoozeTimes, prepareReply, guardReply, sendPrepared, watchForReply, settingValue,
  openReplyComposer, openReplyAllComposer, openForwardComposer, folderList, unsubscribe, blockSender,
} from './mail.js';
import { performAction } from './actions.js';
import { MessageCards } from './Cards.jsx';
import { Question } from './Question.jsx';
import { useWhyDoor } from './WhyDoor.jsx';
import { Avatar, Btn, IconButton, LinkBtn, Quiet, Reason, Sheet, Slip, V, Why, ErrorLine, usePhone } from './primitives.jsx';
import { firstName, fullTime, isReplyMessage, listTime, recipientsLine, senderName, slipDate, snippetOf, splitQuotedHtml, splitQuotedText, storyParts } from './format.js';
import { tv, tvn } from './i18n.js';
import { LighterLabel } from './TierNote.jsx';
import { isLighter, tierNotice } from './tiers.js';

// MessageBodyView's two callbacks are effect dependencies: module constants, so the frame is set
// up once per body, and a function (not false) so a right-click never throws. Always the
// browser's own context menu.
const NATIVE = () => true;
const NOOP = () => {};

// Below this reader width the toolbar folds Reply Later / Snooze / Set Aside and Move into More;
// below the tight width Reply all and Forward go too. Done, Delete, Junk and Flag always show.
const NARROW_READER = 900;
const TIGHT_READER = 640;
// Actions that take the conversation out of the list: the reader moves on (a phone goes back).
const TAKES_AWAY = new Set(['done', 'delete', 'junk', 'snooze', 'move']);
// More than this many collapsed messages fold into one "N earlier messages" row.
const FOLD_OVER = 4;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
const SEND_KEYS = IS_MAC ? '⌘↩' : 'Ctrl+↩';

/**
 * Whether upstream's own global keymap acts on this key right now: the key is bound to one of
 * its actions (defaults E archive, R/A/F reply, S star, or the user's overrides), a component that
 * handles that action is mounted (the classic list or reading pane in a pane) and upstream has a
 * message selected. The reader then leaves the key alone, so one press never runs two actions
 * (E archiving upstream's message and Hedwig's thread both).
 */
export function upstreamOwnsKey(key, { shortcuts = {}, selectedMessageId = null, hasListener = () => false } = {}) {
  if (!selectedMessageId || !key) return false;
  const action = buildKeyMap(shortcuts || {})[key];
  return Boolean(action) && Boolean(hasListener(action));
}

/** True when the element, or an ancestor, is display:none (a pane hidden beside a wide view). */
export function hiddenInPage(el) {
  for (let p = el; p; p = p.parentElement) {
    if (p.hidden || p.style?.display === 'none') return true;
  }
  return false;
}

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
  // Change the loaded thread in place (a rewritten story or TL;DR), only while it is still `forKey`'s.
  const patch = useCallback((forKey, fn) => {
    setState((s) => (s.data && s.key === forKey ? { ...s, data: fn(s.data) } : s));
  }, []);
  return { ...state, reload: load, patch };
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

/**
 * The reader column's width, so the toolbar can fold its middle groups (null until measured).
 * Returns [width, callbackRef]: the element is tracked in state, so the observer follows the
 * section even when it first appears after mount (the reader starts on "Pick a conversation").
 */
function useWidth() {
  const [el, setEl] = useState(null);
  const [width, setWidth] = useState(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, setEl];
}

// ── Summary block ─────────────────────────────────────────────────────────────
function Story({ text, onCite, phone }) {
  const parts = storyParts(text);
  return parts.map((p, i) => (p.cite != null
    ? (
      <button
        key={i}
        type="button"
        onClick={() => onCite(p.cite)}
        aria-label={tv('hedwig.v2.thread.citation', 'Message {{n}}', { n: p.cite })}
        className={phone ? 'hw-hit' : undefined}
        style={{ fontFamily: V.sans, fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums', verticalAlign: 'super', marginLeft: 1, color: V.accentInk, padding: '0 1px', border: 0, background: 'none', cursor: 'pointer', lineHeight: 1 }}
      >
        {p.cite}
      </button>
    )
    : <span key={i}>{p.text}</span>));
}

/**
 * The sparkles of a summary as its "Regenerate" control: a 20×20 (16×16 on a TL;DR) borderless
 * icon button, the glyph in the accent, turning slowly while the rewrite runs. Clicks while it
 * turns do nothing (it stays focusable, so the focus is not lost).
 */
function RegenButton({ phase, onRegenerate, label, size = 20, glyph = 14, style }) {
  const busy = phase === 'busy';
  return (
    <button
      type="button"
      className="hw-regen"
      data-regenerate=""
      aria-label={label}
      title={label}
      aria-busy={busy || undefined}
      onClick={() => { if (!busy) onRegenerate(); }}
      style={{ width: size, height: size, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, margin: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.accent, cursor: busy ? 'default' : 'pointer', ...style }}
    >
      <span className={busy ? 'hw-spin' : undefined} style={{ display: 'inline-flex' }}><Icon name="sparkles" size={glyph} /></span>
    </button>
  );
}

/** After a rewrite: "Rewritten just now" for a few seconds, or the retry note when it failed. 11px. */
function RegenNote({ phase, onRetry }) {
  if (phase === 'done') {
    return <span role="status" data-regen-note="done" style={{ fontSize: 11, lineHeight: '14px', color: V.muted, whiteSpace: 'nowrap' }}>{tv('hedwig.v2.thread.rewritten', 'Rewritten just now')}</span>;
  }
  if (phase === 'failed') {
    return (
      <button type="button" role="alert" data-regen-note="failed" onClick={onRetry} style={{ padding: 0, margin: 0, border: 0, background: 'none', font: 'inherit', fontSize: 11, lineHeight: '14px', color: V.attentionInk, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {tv('hedwig.v2.thread.rewriteFailed', 'Could not rewrite. Try again')}
      </button>
    );
  }
  return null;
}

/** While a rewrite runs the old text stays at 60%; the new text fades in. */
function RegenText({ phase, version, children }) {
  return (
    <div
      key={version}
      className={phase === 'done' ? 'hw-regen-new' : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: phase === 'busy' ? 0.6 : 1, transition: 'opacity 160ms ease' }}
    >
      {children}
    </div>
  );
}

/**
 * The box the summary, the deadline and the cards share: radius 10, --field, hairline. With
 * `regen` ({ phase, trigger, label }) its sparkles rewrite the summary.
 */
function SummaryBox({ label, ariaLabel, right, regen = null, children, style, ...rest }) {
  return (
    <Slip as="section" aria-label={ariaLabel || label} style={{ gap: 6, ...style }} {...rest}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16 }}>
        {regen
          ? <RegenButton phase={regen.phase} onRegenerate={regen.trigger} label={regen.label} style={{ margin: -3 }} />
          : <span style={{ color: V.accent, display: 'inline-flex' }}><Icon name="sparkles" size={14} /></span>}
        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: '16px' }}>{label}</span>
        <span style={{ flexGrow: 1 }} />
        {regen && <RegenNote phase={regen.phase} onRetry={regen.trigger} />}
        {right}
      </div>
      {regen ? <RegenText phase={regen.phase} version={regen.version}>{children}</RegenText> : children}
    </Slip>
  );
}

/** Three lines, then "Show more" (only when there is more). */
function Clamped({ children, lines = 3 }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    // Against the three lines themselves: superscript citations overhang a line box a little.
    setOverflows(el.scrollHeight > lines * 19 + 8);
  }, [children, open, lines]);
  return (
    <>
      <p
        ref={ref}
        style={{
          margin: 0, fontSize: 13, lineHeight: '19px', textWrap: 'pretty', overflowWrap: 'anywhere',
          ...(open ? {} : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' }),
        }}
      >
        {children}
      </p>
      {(overflows || open) && (
        <LinkBtn onClick={() => setOpen((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 12, color: V.accentInk, textDecoration: 'none' }}>
          {open ? tv('hedwig.v2.thread.showLess', 'Show less') : tv('hedwig.v2.thread.showMore', 'Show more')}
        </LinkBtn>
      )}
    </>
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
  return (
    <Slip aria-label={tv('hedwig.v2.thread.deadline', 'Deadline')} style={{ gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 17, fontWeight: 600, lineHeight: '22px', fontVariantNumeric: 'tabular-nums', color: V.attentionInk }}>
          <Icon name="calendar" size={16} />
          {slipDate(deadline.due_at)}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 160px' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{deadline.what}</span>
          <span style={{ fontSize: 12, color: V.muted }}>{note}</span>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <LinkBtn hit={phone} onClick={onRemind} style={{ fontSize: 12, color: V.accentInk, textDecoration: 'none' }}>{phone ? tv('hedwig.v2.thread.remind', 'Remind me') : remindLabel}</LinkBtn>
        {onWrong && <LinkBtn muted hit={phone} onClick={onWrong} style={{ fontSize: 12, textDecoration: 'none' }}>{tv('hedwig.v2.thread.wrong', 'Wrong?')}</LinkBtn>}
      </div>
    </Slip>
  );
}

// ── Message bodies ───────────────────────────────────────────────────────────
/**
 * One message's body for the reader: the body route result, fetched when the message opens (the
 * latest one arrives with the thread). Under the mock the message's own html / text is used.
 * `remote` refetches with remote images, after the user asked.
 */
function useBody(m, open) {
  const local = isMockMode() || !m.id;
  const initial = () => {
    if (m.body) return { body: m.body, error: null, loading: false };
    if (local) return { body: { html: m.html || null, text: m.text ?? m.snippet ?? '', attachments: m.raw?.attachments || [], hasBlockedRemoteImages: m.hasBlockedRemoteImages }, error: null, loading: false };
    return { body: null, error: null, loading: false };
  };
  const [state, setState] = useState(initial);
  const [remote, setRemote] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || local) return undefined;
    if (!remote && attempt === 0 && state.body) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadFullBody(m.id, remote)
      .then((body) => { if (alive) setState({ body, error: null, loading: false }); })
      .catch((error) => { if (alive) setState((s) => ({ body: s.body, error, loading: false })); });
    return () => { alive = false; };
  }, [open, remote, attempt, m.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadImages = useCallback(() => {
    if (local) { setState((s) => ({ ...s, body: s.body && { ...s.body, hasBlockedRemoteImages: false } })); return; }
    setRemote(true);
  }, [local]);
  return { ...state, remote, loadImages, retry: () => setAttempt((n) => n + 1) };
}

/** The "•••" that folds quoted history in and out, in place (28×16, radius 4). */
function QuoteToggle({ open, onToggle }) {
  const label = open ? tv('hedwig.v2.thread.hideQuoted', 'Hide quoted text') : tv('hedwig.v2.thread.showQuoted', 'Show quoted text');
  return (
    <button
      type="button"
      data-quote-toggle=""
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="hw-btn"
      style={{ alignSelf: 'flex-start', width: 28, height: 16, padding: 0, border: 0, borderRadius: 4, background: V.field, color: V.muted, fontFamily: V.sans, fontSize: 10, lineHeight: '16px', letterSpacing: '0.08em', cursor: 'pointer', flexShrink: 0 }}
    >
      •••
    </button>
  );
}

function RemoteImagesBanner({ senderEmail, onLoad, phone }) {
  const [saving, setSaving] = useState(false);
  const always = async () => {
    setSaving(true);
    try {
      const add = useStore.getState().addToImageWhitelist;
      if (add && !isMockMode()) await add({ type: 'address', value: senderEmail });
      onLoad();
    } catch (err) {
      useStore.getState().addNotification?.({ type: 'error', title: tv('hedwig.v2.thread.whitelistFailed', 'Could not remember this sender.'), body: err?.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div role="note" data-remote-images="" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 36, padding: '4px 12px', boxSizing: 'border-box', borderRadius: 8, background: V.field, fontSize: 12, color: V.muted }}>
      <Icon name="image-off" size={14} />
      <span style={{ flex: '1 1 200px', minWidth: 0 }}>{tv('hedwig.v2.thread.imagesHidden', 'Remote images are hidden to protect your privacy.')}</span>
      <LinkBtn hit={phone} onClick={onLoad} style={{ fontSize: 12, color: V.accentInk, textDecoration: 'none' }}>{tv('hedwig.v2.thread.loadImages', 'Load images')}</LinkBtn>
      {senderEmail && (
        <LinkBtn hit={phone} disabled={saving} onClick={always} style={{ fontSize: 12, color: V.accentInk, textDecoration: 'none' }}>{tv('hedwig.v2.thread.imagesAlways', 'Always for this sender')}</LinkBtn>
      )}
    </div>
  );
}

function HtmlBody({ m, html, body, isReply, darkMode = false, onDarkMode = null }) {
  const iframeRef = useRef(null);
  const emailScaleRef = useRef(1);
  const split = useMemo(() => splitQuotedHtml(html, { isReply }), [html, isReply]);
  const [showQuoted, setShowQuoted] = useState(false);
  const shown = useMemo(() => ({ ...body, html: showQuoted || !split.quoted ? html : split.main }), [body, html, showQuoted, split]);
  // Darkened, the card is the content colour the frame's page matches (still the hairline and
  // radius 10); in its original colours it is the white card.
  return (
    <>
      <div
        data-html-body=""
        data-dark={darkMode ? '' : undefined}
        style={{ background: darkMode ? V.content : '#FFFFFF', borderRadius: 10, padding: '14px 16px 12px', overflow: 'hidden', contain: 'layout', border: `1px solid ${V.line}`, colorScheme: darkMode ? 'dark' : 'light' }}
      >
        <MessageBodyView iframeRef={iframeRef} body={shown} messageId={m.id} emailScaleRef={emailScaleRef} hasNativeContextTarget={NATIVE} onContextMenu={NOOP} darkMode={darkMode} onDarkMode={onDarkMode} />
      </div>
      {split.quoted && <QuoteToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
    </>
  );
}

function TextBody({ text }) {
  const split = useMemo(() => splitQuotedText(text), [text]);
  const [showQuoted, setShowQuoted] = useState(false);
  const style = { margin: 0, fontSize: 14, lineHeight: '21px', maxWidth: '68ch', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textWrap: 'pretty' };
  return (
    <>
      <p data-text-body="" style={style}>{split.main}</p>
      {split.quoted && <QuoteToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
      {split.quoted && showQuoted && <p data-quoted="" style={{ ...style, color: V.muted }}>{split.quoted}</p>}
    </>
  );
}

/**
 * The body of one message: the rendered HTML (or plain text), the remote-images banner, the
 * attachments. Loading and error states in place.
 */
export function MessageBody({ m, state, phone = false, darkMode = false, onDarkMode = null }) {
  const { body, error, loading, remote, loadImages, retry } = state;
  const isReply = isReplyMessage(m.subject || m.raw?.subject, m.inReplyTo);
  if (!body) {
    if (error) {
      return (
        <div role="alert" style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', fontSize: 13, color: V.red }}>
          <span>{tv('hedwig.v2.thread.bodyFailed', 'This message could not be loaded.')}</span>
          <LinkBtn hit={phone} onClick={retry} style={{ color: V.red }}>{tv('hedwig.v2.action.retry', 'Try again')}</LinkBtn>
        </div>
      );
    }
    return <Quiet style={{ padding: '4px 0' }}>{loading ? tv('hedwig.v2.loading', 'Loading…') : m.snippet}</Quiet>;
  }
  const html = typeof body.html === 'string' && body.html.trim() ? body.html : null;
  const text = html ? '' : String(body.text ?? m.text ?? m.snippet ?? '');
  return (
    <div data-message-body="" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {html && body.hasBlockedRemoteImages && !remote && (
        <RemoteImagesBanner senderEmail={body.senderEmail || m.from?.email} onLoad={loadImages} phone={phone} />
      )}
      {html ? <HtmlBody m={m} html={html} body={body} isReply={isReply} darkMode={darkMode} onDarkMode={onDarkMode} /> : <TextBody text={text} />}
      {error && <ErrorLine error={error} onRetry={retry} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {Array.isArray(body.attachments) && body.attachments.length > 0 && (
        <AttachmentChips look="hedwig" messageId={m.id} attachments={body.attachments} />
      )}
    </div>
  );
}

// ── Smart dark mode per message ──────────────────────────────────────────────
/** The remembered choice for a sender ('light' = original colours), following every change. */
function useSenderMailDark(email) {
  return useSyncExternalStore(subscribeSenderMailDark, () => senderMailDark(email), () => null);
}

/**
 * Dark mode for one message: whether its HTML body is darkened, what the frame decided, and
 * the toggle. Only in the dark theme with Settings → The look → Dark mode for mail on Smart.
 * The choice is remembered per sender address (a sender without one: this view only).
 */
export function useMessageDark(m, body) {
  const dark = useStore((s) => s.theme) === 'hedwig-night';
  const setting = normaliseMailDark(useV2((s) => s.prefs?.mailDark));
  const email = body?.senderEmail || m.from?.email || '';
  const remembered = useSenderMailDark(email);
  const [local, setLocal] = useState(null);
  const pref = email ? remembered : local;
  const darkMode = mailDarkWanted({ dark, setting, senderPref: pref });
  const [frameMode, setFrameMode] = useState(null);
  const onDarkMode = useCallback((mode) => setFrameMode(mode), []);
  const hasHtml = typeof body?.html === 'string' && Boolean(body.html.trim());
  // A mail that is dark by itself was left alone: nothing to switch.
  const control = dark && setting === 'smart' && hasHtml && (pref === 'light' || frameMode !== 'already');
  const toggle = useCallback(() => {
    const next = pref === 'light' ? null : 'light';
    if (email) setSenderMailDark(email, next);
    else setLocal(next);
  }, [email, pref]);
  return { darkMode, onDarkMode, control, darkened: darkMode, toggle, frameMode: darkMode ? frameMode : null };
}

/** The per-message glyph: a sun on a darkened message (show its original colours), a moon otherwise. */
export function MailDarkToggle({ darkened, onToggle }) {
  const label = darkened ? tv('hedwig.v2.thread.mailOriginal', 'Show original colours') : tv('hedwig.v2.thread.mailDarken', 'Darken this message');
  return (
    <button
      type="button"
      data-mail-dark={darkened ? 'dark' : 'original'}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="hw-icon-btn"
      style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.muted, cursor: 'pointer', flexShrink: 0 }}
    >
      <Icon name={darkened ? 'sun' : 'moon'} size={14} />
    </button>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────
function MessageMenu({ onReply, onForward, onSource, visible }) {
  return (
    <span style={{ opacity: visible ? 1 : 0, transition: 'opacity 120ms ease', display: 'inline-flex' }}>
      <MenuButton
        label={tv('hedwig.v2.thread.messageActions', 'Message actions')}
        align="right"
        width={200}
        buttonClassName="hw-icon-btn"
        buttonStyle={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.muted, cursor: 'pointer' }}
        items={() => [
          { id: 'reply', label: tv('hedwig.v2.thread.reply', 'Reply'), icon: 'reply', onSelect: onReply },
          { id: 'forward', label: tv('hedwig.v2.thread.forward', 'Forward'), icon: 'forward', onSelect: onForward },
          { id: 'source', label: tv('hedwig.v2.thread.viewSource', 'View source'), icon: 'file', onSelect: onSource },
        ]}
      >
        <Icon name="ellipsis" size={16} />
      </MenuButton>
    </span>
  );
}

/**
 * One message, as `article#hw-msg-N`. Open: the header (36px avatar, name, address on hover,
 * To/Cc, date, paperclip, the hover ellipsis), the TL;DR, the body. Collapsed: a 44px row.
 */
/**
 * A message's TL;DR ("In short"), its sparkles the Regenerate control when `onRegenerate` is given.
 * `lighter`: the lighter model wrote it (known after a rewrite, whose answer carries provenance).
 */
function TldrLine({ messageId, text, lighter = false, onRegenerate = null }) {
  const regen = useRegenerate(() => onRegenerate(messageId), { resetKey: messageId, running: (id) => isRewriting(`tldr:${id}`) });
  const glyph = onRegenerate
    ? <RegenButton phase={regen.phase} onRegenerate={regen.trigger} label={tv('hedwig.v2.thread.regenerateTldr', 'Regenerate')} size={16} glyph={12} style={{ marginTop: 0 }} />
    : <span aria-hidden="true" style={{ color: V.accent, display: 'inline-flex', paddingTop: 2, flexShrink: 0 }}><Icon name="sparkles" size={12} /></span>;
  return (
    <p data-tldr="" aria-label={tv('hedwig.v2.thread.tldrLabel', 'In short: {{text}}', { text })} style={{ margin: 0, fontSize: 12, lineHeight: '17px', color: V.muted, maxWidth: '68ch', textWrap: 'pretty', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
      {glyph}
      <span
        key={text}
        data-tldr-text=""
        className={regen.phase === 'done' ? 'hw-regen-new' : undefined}
        style={{ opacity: regen.phase === 'busy' ? 0.6 : 1, transition: 'opacity 160ms ease' }}
      >
        {text}
        {(lighter || regen.phase === 'done' || regen.phase === 'failed') && (
          <span style={{ display: 'inline-flex', gap: 6, marginLeft: 6, verticalAlign: 'baseline' }}>
            {lighter && <LighterLabel what="story" />}
            <RegenNote phase={regen.phase} onRetry={regen.trigger} />
          </span>
        )}
      </span>
    </p>
  );
}

function MessageItem({ m, n, you, open, onToggle, phone, tldr = null, tldrLighter = false, onRegenerateTldr = null, cards = false, onReply, onForward, onSource, children }) {
  const state = useBody(m, open);
  const mailDark = useMessageDark(m, state.body);
  const [hover, setHover] = useState(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const name = you ? tv('hedwig.v2.thread.you', 'You') : senderName(m.from);
  const attachCount = Array.isArray(state.body?.attachments) ? state.body.attachments.length : 0;
  const clip = attachCount > 0 || m.hasAttachments;
  const when = fullTime(m.date);

  if (!open) {
    return (
      <article id={`hw-msg-${n}`} style={{ borderTop: `1px solid ${V.line}` }}>
        <button
          type="button"
          aria-expanded={false}
          onClick={onToggle}
          className="hw-btn"
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: phone ? 48 : 44, padding: phone ? '0 16px' : '0 24px', border: 0, borderRadius: 0, background: 'transparent', color: V.ink, font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
        >
          <Avatar name={senderName(m.from)} email={m.from?.email} size={24} />
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{snippetOf(m)}</span>
          {clip && <span style={{ color: V.muted, display: 'inline-flex' }}><Icon name="paperclip" size={12} /></span>}
          <span title={when} style={{ fontSize: 12, color: V.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>{listTime(m.date)}</span>
        </button>
      </article>
    );
  }

  const recipients = recipientsLine(m.to && m.to !== 'you' ? m.to : tv('hedwig.v2.thread.youLower', 'you'), m.cc);
  return (
    <article
      id={`hw-msg-${n}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHover(false); }}
      style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${V.line}`, padding: phone ? '14px 16px 16px' : '16px 24px 18px', gap: 12 }}
    >
      <header style={{ display: 'grid', gridTemplateColumns: '36px minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
        <Avatar name={senderName(m.from)} email={m.from?.email} size={36} />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            aria-expanded
            onClick={onToggle}
            title={tv('hedwig.v2.thread.collapse', 'Collapse')}
            style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, padding: 0, border: 0, background: 'none', color: V.ink, font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, lineHeight: '19px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            {m.from?.email && !phone && (
              <span style={{ fontSize: 12, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: hover ? 1 : 0, transition: 'opacity 120ms ease' }}>{m.from.email}</span>
            )}
          </button>
          {recipients && (
            <button
              type="button"
              onClick={() => setRecipientsOpen((v) => !v)}
              aria-expanded={recipientsOpen}
              aria-label={recipients}
              style={{ padding: 0, border: 0, background: 'none', font: 'inherit', fontSize: 12, lineHeight: '16px', color: V.muted, textAlign: 'left', cursor: 'pointer', minWidth: 0, ...(recipientsOpen ? { whiteSpace: 'normal', overflowWrap: 'anywhere' } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}
            >
              {recipients}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span title={when} style={{ fontSize: 12, lineHeight: '19px', color: V.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{phone ? listTime(m.date) : when}</span>
            {mailDark.control && <MailDarkToggle darkened={mailDark.darkened} onToggle={mailDark.toggle} />}
            {!phone && m.id && <MessageMenu visible={hover} onReply={onReply} onForward={onForward} onSource={onSource} />}
          </div>
          {clip && (
            <span aria-label={attachCount ? tvn(attachCount, ['hedwig.v2.thread.attachmentOne', '1 attachment'], ['hedwig.v2.thread.attachmentMany', '{{n}} attachments']) : tv('hedwig.v2.thread.hasAttachments', 'Has attachments')} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: V.muted, fontVariantNumeric: 'tabular-nums' }}>
              <Icon name="paperclip" size={12} />{attachCount || null}
            </span>
          )}
        </div>
      </header>
      {cards && m.id && <MessageCards messageId={m.id} phone={phone} />}
      {tldr && <TldrLine messageId={m.id} text={tldr} lighter={tldrLighter} onRegenerate={m.id ? onRegenerateTldr : null} />}
      <MessageBody m={m} state={state} phone={phone} darkMode={mailDark.darkMode} onDarkMode={mailDark.onDarkMode} />
      {children}
    </article>
  );
}

/**
 * A saved draft in the thread, as `article#hw-msg-N`: the "Draft" label, who it is to, the
 * snippet and Edit draft, which reopens it in the composer (saving replaces it, sending deletes
 * it). Never a read-only body and never a reply to yourself.
 */
function DraftItem({ m, n, phone, busy, onEdit }) {
  const snippet = snippetOf(m);
  const to = m.to && m.to !== 'you' ? m.to : '';
  return (
    <article id={`hw-msg-${n}`} data-draft="" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${V.line}`, padding: phone ? '14px 16px 16px' : '14px 24px 16px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span data-draft-label="" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'center', flexShrink: 0, fontSize: 12, fontWeight: 600, lineHeight: '16px', color: V.attentionInk }}>
          <Icon name="file" size={14} />
          {tv('hedwig.v2.drafts.label', 'Draft')}
        </span>
        {to && <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 12, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tv('hedwig.v2.drafts.to', 'To {{names}}', { names: to })}</span>}
        {!to && <span style={{ flexGrow: 1 }} />}
        <span title={fullTime(m.date)} style={{ flexShrink: 0, fontSize: 12, color: V.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{listTime(m.date)}</span>
      </header>
      {snippet && <p data-draft-snippet="" style={{ margin: 0, fontSize: 13, lineHeight: '19px', color: V.muted, maxWidth: '68ch', overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>{snippet}</p>}
      <div>
        <Btn accent size={phone ? 'phone' : 'md'} disabled={busy} onClick={onEdit}>
          <Icon name="file" size={14} />
          {busy ? tv('hedwig.v2.drafts.opening', 'Opening…') : tv('hedwig.v2.drafts.edit', 'Edit draft')}
        </Btn>
      </div>
    </article>
  );
}

/**
 * Which messages fold away: each unbroken run of more than `over` collapsed messages becomes one
 * "N earlier messages" row where the run starts. An unread (open) message between two runs keeps
 * its place, so nothing is shown out of order. `collapsed[i]` says message i would be a 44px row.
 * Returns Map(index → { start, count }) for every folded index.
 */
export function foldRuns(collapsed, over = FOLD_OVER) {
  const out = new Map();
  let i = 0;
  while (i < collapsed.length) {
    if (!collapsed[i]) { i += 1; continue; }
    let j = i;
    while (j < collapsed.length && collapsed[j]) j += 1;
    if (j - i > over) for (let k = i; k < j; k += 1) out.set(k, { start: i, count: j - i });
    i = j;
  }
  return out;
}

function FoldRow({ count, onOpen, phone }) {
  return (
    <div style={{ borderTop: `1px solid ${V.line}` }}>
      <button
        type="button"
        aria-expanded={false}
        onClick={onOpen}
        className="hw-btn"
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: phone ? 48 : 44, padding: phone ? '0 16px' : '0 24px', border: 0, borderRadius: 0, background: 'transparent', color: V.accentInk, font: 'inherit', fontSize: 13, fontWeight: 500, textAlign: 'left', cursor: 'pointer' }}
      >
        <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', color: V.muted }}><Icon name="history" size={16} /></span>
        {tvn(count, ['hedwig.v2.thread.earlierOne', 'One earlier message'], ['hedwig.v2.thread.earlierMany', '{{n}} earlier messages'])}
      </button>
    </div>
  );
}

// ── Reply bar ────────────────────────────────────────────────────────────────
const WAIT_DAYS = [1, 2, 3, 5, 7, 10, 14];
function defaultWaitDays() {
  const n = Math.round(Number(settingValue('work.waitingDefaultDays', 3)));
  return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : 3;
}

/** "Remind me if no reply" (a bell toggle) with its number of days. */
function RemindIfNoReply({ on, days, onToggle, onDays, phone }) {
  const options = WAIT_DAYS.includes(days) ? WAIT_DAYS : [...WAIT_DAYS, days].sort((a, b) => a - b);
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: on ? V.accentInk : V.muted }}>
      <label
        title={tv('hedwig.v2.waiting.remindTip', 'If nobody answers in time, Hedwig puts this thread back in front of you.')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: phone ? 44 : 28, cursor: 'pointer' }}
      >
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} style={{ accentColor: 'var(--hw-accent)', width: 14, height: 14, margin: 0 }} />
        <Icon name="bell" size={14} />
        {tv('hedwig.v2.waiting.remindIfNoReply', 'Remind me if no reply')}
      </label>
      <select
        value={days}
        onChange={(e) => { onDays(Number(e.target.value)); onToggle(true); }}
        aria-label={tv('hedwig.v2.waiting.remindAfter', 'Remind me after')}
        style={{ height: phone ? 44 : 24, border: 0, borderRadius: 6, padding: '0 4px', background: 'transparent', color: on ? V.ink : V.muted, font: 'inherit', fontSize: 12, cursor: 'pointer' }}
      >
        {options.map((n) => <option key={n} value={n}>{tvn(n, ['hedwig.v2.waiting.inOneDay', 'in 1 day'], ['hedwig.v2.waiting.inDays', 'in {{n}} days'])}</option>)}
      </select>
    </div>
  );
}

function QuickReplies({ items, onPick, disabled, phone }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: phone ? 'nowrap' : 'wrap', overflowX: phone ? 'auto' : undefined, scrollbarWidth: phone ? 'none' : undefined }}>
      {items.map((q) => (
        <button
          key={q}
          type="button"
          className="hw-btn"
          disabled={disabled}
          onClick={() => onPick(q)}
          style={{ height: phone ? 44 : 28, padding: '0 10px', borderRadius: 8, border: `1px solid ${V.line2}`, background: 'transparent', color: V.ink, font: 'inherit', fontSize: 13, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0 }}
        >
          {q}
        </button>
      ))}
    </div>
  );
}

// ── The reader ───────────────────────────────────────────────────────────────
export default function Thread({ props }) {
  const phoneCtx = usePhone();
  const phone = Boolean(phoneCtx?.phone);
  const selected = useV2((s) => s.selected);
  const helpMeWrite = useV2((s) => s.prefs.helpMeWrite);
  const accounts = useStore((s) => s.accounts);
  const storeFolders = useStore((s) => s.folders);
  const draftFolders = useV2((s) => s.draftFolders);
  const work = useWork();
  const status = useHedwig((s) => s.status);
  const item = props?.item || selected;
  const t = useThread(item);
  const door = useWhyDoor();
  const sectionRef = useRef(null);
  const [width, measure] = useWidth();
  const setSection = useCallback((node) => { sectionRef.current = node; measure(node); }, [measure]);
  const [toggled, setToggled] = useState({});         // messageId → open / closed, over the default
  const [unfolded, setUnfolded] = useState(false);
  const [draft, setDraft] = useState('');
  const [savedText, setSavedText] = useState(null);  // the reply text last kept for this thread
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [warnings, setWarnings] = useState(null);     // { body, list } from the send guard
  const [watchOn, setWatchOn] = useState(false);      // "remind me if no reply in N days"
  const [remindDays, setRemindDays] = useState(() => defaultWaitDays());
  const [focused, setFocused] = useState(false);      // the reply bar has focus (it grows)
  const [headersFor, setHeadersFor] = useState(null);
  const [folders, setFolders] = useState({ account: null, list: null, loading: false });
  const inputRef = useRef(null);
  const pointerInBar = useRef(false);
  const snoozeRef = useRef(null);
  const moveRef = useRef(null);
  const moreRef = useRef(null);

  // The reply field's text is kept per thread: leaving a thread keeps what was typed (memory and
  // localStorage), coming back restores it. Server-side drafts stay with the composer.
  const threadKey = item ? (item.threadId || item.messageId) : null;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const restored = getReplyDraft(threadKey);
    setToggled({}); setUnfolded(false); setDraft(restored); setSavedText(restored || null); setActionError(null); setWarnings(null); setWatchOn(false);
    setRemindDays(defaultWaitDays()); setFocused(false); setHeadersFor(null);
    return () => { setReplyDraft(threadKey, draftRef.current); };
  }, [item?.messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!threadKey) return undefined;
    const timer = setTimeout(() => setSavedText(setReplyDraft(threadKey, draft) ? draft : null), 800);
    return () => clearTimeout(timer);
  }, [draft, threadKey]);
  // The Drafts folders tell a saved draft apart from a message (loaded once per session).
  useEffect(() => { useV2.getState().ensureDrafts(); }, []);

  const data = t.data;
  const messages = useMemo(() => data?.messages || [], [data]);
  const isDraft = (m) => isDraftMessage(m, { accounts, folders: storeFolders, draftFolders });
  const newest = messages[messages.length - 1];
  // A draft is never what you reply to: `latest` is the newest real message; a draft at the end
  // turns the reply bar into Continue draft.
  const trailingDraft = newest && isDraft(newest) ? newest : null;
  const latest = trailingDraft ? ([...messages].reverse().find((m) => !isDraft(m)) || newest) : newest;
  const latestIdx = latest ? messages.indexOf(latest) : -1;
  const reason = useWhy(latest?.id && item ? item.messageId : null, item?.reason);
  const [question, setQuestion] = useInlineQuestion(latest?.id || null);
  const myEmails = new Set((accounts || []).flatMap((a) => [a.email_address, ...(a.aliases || []).map((x) => x.email)]).filter(Boolean).map((e) => e.toLowerCase()));
  const isMine = (m) => myEmails.has(String(m?.from?.email || '').toLowerCase());
  // Flag follows the optimistic overlay (actions.js) over what the server said.
  const latestPatch = useV2((s) => (latest?.id ? s.patches[latest.id] : null));
  const flagged = latestPatch?.flagged ?? Boolean(latest?.starred);

  const run = async (key, fn) => {
    setBusy(key);
    setActionError(null);
    try { return await fn(); } catch (e) {
      setActionError(isMissing(e) ? new Error(tv('hedwig.v2.notYet', 'Not available yet.')) : e);
      return undefined;
    } finally { setBusy(null); }
  };

  const threadId = item ? (item.threadId || item.messageId) : null;

  // "Regenerate summary": the sparkles in the summary and in each TL;DR write them again.
  const patchThread = t.patch;
  const storyRegen = useRegenerate(async () => {
    const key = threadKey;
    const r = await regenerateStory(key);
    patchThread(key, (d) => ({ ...d, story: r.story, storyProvenance: r.storyProvenance, storyProblem: null, tldr: r.tldr || d.tldr }));
    return r;
  }, { resetKey: threadKey, running: (k) => isRewriting(`story:${k}`) });
  const rewriteTldr = useCallback(async (messageId) => {
    const key = threadKey;
    const r = await regenerateTldr(messageId);
    patchThread(key, (d) => ({
      ...d,
      messageTldrs: { ...(d.messageTldrs || {}), [messageId]: r.text },
      messageTldrMeta: { ...(d.messageTldrMeta || {}), [messageId]: r.provenance },
    }));
    if (r.provenance) putTldr(messageId, r.provenance);
    return r;
  }, [threadKey, patchThread]);
  const latestId = latest?.id || item?.messageId;
  const whyItem = item ? { ...item, messageId: item.messageId, reason } : null;

  // Inbox actions go through the optimistic layer: the screen changes at once, a toast offers
  // Undo, the call runs behind it. Drafts are never part of Done, Delete, Junk or Move.
  const act = (kind, extra = {}) => {
    if (!item) return;
    performAction({ kind, items: [item], messages: messages.filter((m) => m.id && !isDraft(m)), advance: !phone, ...extra });
    if (phone && TAKES_AWAY.has(kind)) phoneCtx?.back?.();
  };
  const done = () => act('done');
  const del = () => act('delete');
  const junk = () => act('junk');
  const later = () => act('replyLater');
  const aside = () => act('setAside');
  const snoozeItems = () => snoozeTimes().map((s) => ({ id: s.id, label: s.label, icon: 'alarm-clock', onSelect: () => act('snooze', { until: s.until }) }));
  const showOriginal = async () => {
    const row = await openMessage(latestId);
    if (row && !phone) useHedwig.getState().openView('core.thread');
  };
  const focusReply = () => {
    if (phone) { run('reply', () => openReplyComposer(latestId, draft)); return; }
    setFocused(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const replyAll = () => run('reply', () => openReplyAllComposer(latestId, draft.trim()));
  const forward = () => run('forward', () => openForwardComposer(latestId));
  const popOut = () => run('reply', async () => { await openReplyComposer(latestId, draft); setDraft(''); clearReplyDraft(threadKey); setSavedText(null); setWarnings(null); });
  const editDraft = (m) => run('editDraft', () => openDraft(m.raw || m));
  const toggleFlag = () => act('flag', { on: !flagged, messageIds: [latestId] });
  const unread = () => act('read', { read: false, messageIds: [latestId] });
  const unsub = () => run('unsubscribe', () => unsubscribe(latestId));
  const block = () => run('block', () => blockSender(latest?.from?.email));
  const openDoor = (anchor) => { if (whyItem) door.open(whyItem, anchor); };

  const moveSet = () => messages.filter((m) => m.id && !isDraft(m) && m.folder === latest?.folder && m.accountId === latest?.accountId);
  const loadFolders = () => {
    const account = latest?.accountId || null;
    if (folders.loading || (folders.list && folders.account === account)) return;
    setFolders({ account, list: null, loading: true });
    folderList(account)
      .then((list) => setFolders({ account, list, loading: false }))
      .catch(() => setFolders({ account, list: [], loading: false }));
  };
  const moveItems = () => {
    const list = (folders.list || []).filter((f) => f?.path && f.path !== latest?.folder);
    return [
      { id: 'stream', label: tv('hedwig.v2.thread.changeStream', 'Change stream…'), icon: 'list-filter', onSelect: () => openDoor((moveRef.current || moreRef.current)?.querySelector('button')) },
      { type: 'header', label: tv('hedwig.v2.thread.folders', 'Folders') },
      ...(folders.loading || !folders.list
        ? [{ id: 'loading', label: tv('hedwig.v2.loading', 'Loading…'), icon: 'refresh', disabled: true }]
        : list.length
          ? list.map((f) => ({ id: `f:${f.path}`, label: f.name || f.path, icon: 'folder-input', onSelect: () => act('move', { folder: f.path, label: f.name || f.path, messages: moveSet() }) }))
          : [{ id: 'none', label: tv('hedwig.v2.thread.noFolders', 'No other folders'), icon: 'folder-input', disabled: true }]),
    ];
  };

  // A citation names a message: by id (the work route's citations) or by its number (older shape).
  const onCite = (n) => {
    const id = data?.story?.cites?.[n];
    const idx = id ? messages.findIndex((m) => m.id === id) : n - 1;
    if (idx < 0 || !messages[idx]) return;
    setUnfolded(true);
    setToggled((x) => ({ ...x, [messages[idx].id]: true }));
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
  // The send guard runs first; its warnings show above the field and the button becomes "Send
  // anyway". It never blocks: a second press with the same text sends.
  const send = () => run('send', async () => {
    const body = draft.trim();
    if (!body) return;
    const payload = await prepareReply(latestId, body);
    if (!payload) return;
    if (warnings?.body !== body) {
      const list = await guardReply(payload, threadId);
      if (list.length) { setWarnings({ body, list }); return; }
    }
    await sendPrepared(payload);
    setDraft('');
    clearReplyDraft(threadKey);
    setSavedText(null);
    setWarnings(null);
    if (watchOn) { setWatchOn(false); await watchForReply(threadId, remindDays); }
  });
  const warned = warnings && warnings.body === draft.trim() ? warnings.list : null;

  // Keys (desktop): the toolbar's letters. Upstream's own map still runs beside this one; it
  // only acts on upstream's selection. Never inside a field, a dialog or an open menu, and never
  // as the second key of a "g" sequence (g r, g h are Hedwig's go-to keys).
  const keyActions = useRef(null);
  keyActions.current = {
    e: done, r: focusReply, a: replyAll, f: forward, u: unread,
    // Upstream's own letters where it has them: # delete, ! spam. S is Set Aside here, so Flag
    // (upstream's star on S) is Shift+S.
    '#': del, Delete: del, Backspace: del, '!': junk, S: toggleFlag,
    ...(work ? { l: later, s: aside } : {}),
    // Folded into More below 900px: H and V open More, which holds Snooze and Move then.
    h: () => (snoozeRef.current || moreRef.current)?.querySelector('button')?.click(),
    v: () => { loadFolders(); (moveRef.current || moreRef.current)?.querySelector('button')?.click(); },
  };
  const keysOn = !phone && Boolean(data && latest);
  useEffect(() => {
    if (!keysOn) return undefined;
    let lastG = 0;
    const onKey = (e) => {
      if (e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      if (st.composing || st.showAdmin) return;
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.closest?.('[role="dialog"], [role="menu"], [contenteditable="true"]'))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      // A reader in a hidden pane (display:none beside a wide view, while the overlay reader has
      // the thread) stays quiet, so the overlay's keys run once.
      if (!sectionRef.current || hiddenInPage(sectionRef.current)) return;
      // Upstream's keymap acts on its own selection with the same letters: it wins, once.
      if (upstreamOwnsKey(e.key, { shortcuts: st.shortcuts, selectedMessageId: st.selectedMessageId, hasListener: shortcutBus.has })) return;
      // Letters without Shift are lower case whatever Caps Lock says; with Shift only the
      // symbols (#, !) and Shift+S mean something. Named keys (Delete, Backspace) stay as they are.
      const raw = String(e.key || '');
      const key = raw.length === 1 && !e.shiftKey ? raw.toLowerCase() : raw;
      const now = Date.now();
      if (key === 'g') { lastG = now; return; }
      if (now - lastG < 1000) { lastG = 0; return; }
      const fn = keyActions.current?.[key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keysOn]);

  // The reply field grows while anything in the bar has focus, and while there is a draft.
  const expanded = focused || Boolean(draft) || watchOn || Boolean(warned);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || phone) return;
    el.style.height = 'auto';
    const min = expanded ? 64 : 22;
    el.style.height = `${Math.max(min, Math.min(148, el.scrollHeight || 0))}px`;
  }, [draft, expanded, phone]);

  if (!item) {
    return (
      <div className="hw-v2" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
        <Why size={13}>{tv('hedwig.v2.thread.empty', 'Pick a conversation to read it here.')}</Why>
      </div>
    );
  }

  const title = data?.subject || item.subject || '';
  const people = data?.participants || (data?.people?.length
    ? tv('hedwig.v2.thread.andYou', '{{names}} and you', { names: data.people.filter((p) => !myEmails.has(String(p).toLowerCase())).slice(0, 3).join(', ') || senderName(item.from) })
    : senderName(item.from));
  const meta = [people, messages.length ? tvn(messages.length, ['hedwig.v2.thread.messagesOne', '1 message'], ['hedwig.v2.thread.messagesMany', '{{n}} messages']) : null, !phone ? data?.label : null].filter(Boolean).join(' · ');
  const replyTo = firstName(latest?.from || item.from);
  const narrow = !phone && width != null && width < NARROW_READER;
  const tight = !phone && width != null && width < TIGHT_READER;
  const trackerNote = latest?.trackersBlocked
    ? tvn(latest.trackersBlocked, ['hedwig.v2.thread.trackerOne', '1 tracker blocked'], ['hedwig.v2.thread.trackerMany', 'Trackers blocked: {{n}}'])
    : null;

  // ── toolbar ──
  const iconMenuStyle = { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.ink, cursor: 'pointer', flexShrink: 0 };
  const snoozeLabel = `${tv('hedwig.v2.thread.snooze', 'Snooze')} (H)`;
  const moreLabel = tv('hedwig.v2.thread.more', 'More');
  const flagLabel = flagged ? tv('hedwig.v2.thread.unflag', 'Unflag') : tv('hedwig.v2.thread.flag', 'Flag');
  const deleteLabel = tv('hedwig.v2.thread.delete', 'Delete');
  const junkLabel = tv('hedwig.v2.thread.junk', 'Junk');
  const moreItems = ({ withGroup2 = false, withMove = false, withReply = false } = {}) => [
    ...(withGroup2 && work ? [{ id: 'later', label: tv('hedwig.v2.rail.replyLater', 'Reply Later'), icon: 'clock', hint: 'L', onSelect: later }] : []),
    ...(withGroup2 ? snoozeItems().map((s) => ({ ...s, label: `${tv('hedwig.v2.thread.snooze', 'Snooze')}: ${s.label}` })) : []),
    ...(withGroup2 && work ? [{ id: 'aside', label: tv('hedwig.v2.thread.setAside', 'Set Aside'), icon: 'bookmark', hint: 'S', onSelect: aside }] : []),
    ...(withReply ? [
      { id: 'replyAll', label: tv('hedwig.v2.thread.replyAll', 'Reply all'), icon: 'reply-all', hint: 'A', onSelect: replyAll },
      { id: 'forward', label: tv('hedwig.v2.thread.forward', 'Forward'), icon: 'forward', hint: 'F', onSelect: forward },
    ] : []),
    ...(withMove ? [
      { type: 'header', label: `${tv('hedwig.v2.thread.move', 'Move')} (V)` },
      ...moveItems().filter((x) => x.type !== 'header'),
    ] : []),
    ...(withGroup2 || withMove || withReply ? [{ type: 'separator' }] : []),
    { id: 'unread', label: tv('hedwig.v2.thread.markUnread', 'Mark as unread'), icon: 'mail', hint: 'U', onSelect: unread },
    { id: 'source', label: tv('hedwig.v2.thread.viewSource', 'View source'), icon: 'file', onSelect: () => setHeadersFor(latestId) },
    { id: 'unsubscribe', label: tv('hedwig.v2.thread.unsubscribe', 'Unsubscribe'), icon: 'mail-open', onSelect: unsub },
    ...(latest?.from?.email && !isMine(latest) ? [{ id: 'block', label: tv('hedwig.v2.thread.blockSender', 'Block sender'), icon: 'ban', onSelect: block }] : []),
    { id: 'original', label: tv('hedwig.v2.thread.original', 'Open original'), icon: 'external', onSelect: showOriginal },
  ];

  // Groups, left to right: Done, Delete, Junk, Flag (always); Reply Later, Snooze, Set Aside
  // (into More below 900px); Reply, Reply all, Forward (the last two into More below 640px);
  // then Move (into More below 900px) and More.
  const group = (children, key) => <div key={key} role="group" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>{children}</div>;
  const toolbar = !phone && (
    <Sheet
      as="div"
      role="toolbar"
      aria-label={tv('hedwig.v2.thread.toolbar', 'Message actions')}
      material="bar"
      radius={0}
      style={{ position: 'sticky', top: 0, zIndex: 3, flexShrink: 0, height: 48, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', borderBottom: `1px solid ${V.line}` }}
    >
      {group(<>
        <IconButton icon="circle-check" label={tv('hedwig.v2.thread.done', 'Done')} kbd="E" primary showLabel onClick={done} />
        <IconButton icon="trash" label={deleteLabel} kbd="⌫" data-action="delete" onClick={del} />
        <IconButton icon="alert-octagon" label={junkLabel} kbd="!" data-action="junk" onClick={junk} />
        <IconButton icon="flag" label={flagLabel} kbd="⇧S" data-action="flag" active={flagged} fill={flagged ? 'currentColor' : undefined} onClick={toggleFlag} style={flagged ? { color: V.accent } : undefined} />
      </>, 'g1')}
      {!narrow && group(<>
        {work && <IconButton icon="clock" label={tv('hedwig.v2.rail.replyLater', 'Reply Later')} kbd="L" onClick={later} />}
        <span ref={snoozeRef} style={{ display: 'inline-flex' }}>
          <MenuButton label={snoozeLabel} items={snoozeItems} align="left" width={220} buttonClassName="hw-icon-btn" buttonStyle={iconMenuStyle}>
            <Icon name="alarm-clock" size={16} />
          </MenuButton>
        </span>
        {work && <IconButton icon="bookmark" label={tv('hedwig.v2.thread.setAside', 'Set Aside')} kbd="S" onClick={aside} />}
      </>, 'g2')}
      {group(<>
        <IconButton icon="reply" label={tv('hedwig.v2.thread.reply', 'Reply')} kbd="R" onClick={focusReply} />
        {!tight && <IconButton icon="reply-all" label={tv('hedwig.v2.thread.replyAll', 'Reply all')} kbd="A" disabled={Boolean(busy)} onClick={replyAll} />}
        {!tight && <IconButton icon="forward" label={tv('hedwig.v2.thread.forward', 'Forward')} kbd="F" disabled={Boolean(busy)} onClick={forward} />}
      </>, 'g3')}
      <span style={{ flexGrow: 1 }} />
      {group(<>
        {!narrow && (
          <span ref={moveRef} style={{ display: 'inline-flex' }} onClickCapture={loadFolders}>
            <MenuButton label={`${tv('hedwig.v2.thread.move', 'Move')} (V)`} items={moveItems} align="right" width={240} buttonClassName="hw-icon-btn" buttonStyle={iconMenuStyle}>
              <Icon name="folder-input" size={16} />
            </MenuButton>
          </span>
        )}
        <span ref={moreRef} style={{ display: 'inline-flex' }} onClickCapture={narrow ? loadFolders : undefined}>
          <MenuButton label={moreLabel} items={() => moreItems({ withGroup2: narrow, withMove: narrow, withReply: tight })} align="right" width={240} buttonClassName="hw-icon-btn" buttonStyle={iconMenuStyle}>
            <Icon name="ellipsis" size={16} />
          </MenuButton>
        </span>
      </>, 'g4')}
    </Sheet>
  );

  // ── subject, reason, summary, deadline, cards ──
  const reasonLine = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 12, lineHeight: '17px', color: V.muted }}>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{meta}</span>
      {reason && (
        <>
          <span aria-hidden="true">·</span>
          <Reason glyph="info" onOpen={openDoor} hit={phone} label={tv('hedwig.v2.thread.whyLabel', 'Why: {{reason}}. Open to see or change', { reason })}>{reason}</Reason>
          <LinkBtn hit={phone} onClick={(e) => openDoor(e.currentTarget)} aria-haspopup="dialog" style={{ fontSize: 12, color: V.accentInk, textDecoration: 'none' }}>{tv('hedwig.v2.thread.change', 'Change')}</LinkBtn>
        </>
      )}
      {trackerNote && <><span aria-hidden="true">·</span><span>{trackerNote}</span></>}
    </div>
  );

  const pad = phone ? '0 16px' : '0 24px';
  const short = messages.length <= 3;
  const lighter = data?.story && isLighter(data.storyProvenance, status);
  const notice = tierNotice(status);
  const summary = data && (
    <>
      {data.story && (
        <SummaryBox
          label={short ? tv('hedwig.v2.thread.summary', 'Summary') : tv('hedwig.v2.thread.storyShort', 'Story so far')}
          ariaLabel={short ? tv('hedwig.v2.thread.summary', 'Summary') : tv('hedwig.v2.thread.story', 'The story so far')}
          regen={work ? { ...storyRegen, label: tv('hedwig.v2.thread.regenerate', 'Regenerate summary'), version: data.story.text } : null}
          right={lighter && (
            <span title={notice?.detail || notice?.text || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: V.muted }}>
              <Icon name="info" size={12} />
              <LighterLabel what="story" />
            </span>
          )}
        >
          <Clamped><Story text={data.story.text} onCite={onCite} phone={phone} /></Clamped>
        </SummaryBox>
      )}
      {!data.story && data.tldr && messages.length > 1 && (
        <SummaryBox
          label={tv('hedwig.v2.thread.summary', 'Summary')}
          ariaLabel={tv('hedwig.v2.thread.inShort', 'In short')}
          regen={work ? { ...storyRegen, label: tv('hedwig.v2.thread.regenerate', 'Regenerate summary'), version: data.tldr } : null}
        >
          <p data-thread-tldr="" style={{ margin: 0, fontSize: 13, lineHeight: '19px', textWrap: 'pretty' }}>{data.tldr}</p>
        </SummaryBox>
      )}
      {!data.story && data.storyProblem && messages.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <Reason glyph="info">{data.storyProblem === 'budget'
            ? tv('hedwig.v2.thread.storyBudget', 'Today’s budget for summaries is spent; the story so far is back tomorrow.')
            : tv('hedwig.v2.thread.storyFailed', 'Hedwig could not write the story so far just now.')}
          </Reason>
          {data.storyProblem !== 'budget' && (
            <LinkBtn hit={phone} disabled={t.loading || Boolean(busy)} onClick={() => t.reload(true, true)} style={{ fontSize: 12 }}>{tv('hedwig.v2.action.retry', 'Try again')}</LinkBtn>
          )}
        </div>
      )}
      {data.deadline && <DeadlineSlip deadline={data.deadline} from={latest?.from || item.from} phone={phone} onRemind={remind} onWrong={wrongDeadline} />}
      {latest?.id && <MessageCards messageId={latest.id} phone={phone} />}
    </>
  );

  // ── messages ──
  const defaultOpen = (m, i) => i === latestIdx || m.unread || isDraft(m);
  const isOpen = (m, i) => toggled[m.id] ?? defaultOpen(m, i);
  const folds = unfolded ? new Map() : foldRuns(messages.map((m, i) => !defaultOpen(m, i) && toggled[m.id] !== true), FOLD_OVER);
  const messageList = (
    <div data-messages="" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {messages.map((m, i) => {
        const fold = folds.get(i);
        if (fold) {
          return fold.start === i ? <FoldRow key={`fold-${i}`} count={fold.count} phone={phone} onOpen={() => setUnfolded(true)} /> : null;
        }
        if (isDraft(m)) {
          return <DraftItem key={m.id || i} m={m} n={i + 1} phone={phone} busy={busy === 'editDraft'} onEdit={() => editDraft(m)} />;
        }
        const latestOne = i === latestIdx;
        return (
          <MessageItem
            key={m.id || i}
            m={m}
            n={i + 1}
            you={isMine(m)}
            open={isOpen(m, i)}
            onToggle={() => setToggled((x) => ({ ...x, [m.id]: !isOpen(m, i) }))}
            phone={phone}
            tldr={data.messageTldrs?.[m.id] || null}
            tldrLighter={Boolean(data.messageTldrMeta?.[m.id]?.lighter)}
            onRegenerateTldr={work ? rewriteTldr : null}
            cards={!latestOne}
            onReply={() => run('reply', () => openReplyComposer(m.id))}
            onForward={() => run('forward', () => openForwardComposer(m.id))}
            onSource={() => setHeadersFor(m.id)}
          >
            {latestOne && question && <Question question={question} compact phone={phone} onDone={() => setQuestion(null)} />}
          </MessageItem>
        );
      })}
    </div>
  );

  const quick = helpMeWrite && data?.quickReplies?.length ? data.quickReplies : [];
  const warningLine = warned && (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {warned.map((w, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 4, fontSize: 12, lineHeight: '17px', color: V.attentionInk }}>
          <span style={{ display: 'inline-flex', alignSelf: 'center' }}><Icon name="circle-alert" size={12} /></span>
          {w.text || w.message}
        </span>
      ))}
    </div>
  );

  const replyLabel = tv('hedwig.v2.thread.replyToLabel', 'Reply to {{name}}', { name: replyTo });
  const continueLabel = busy === 'editDraft' ? tv('hedwig.v2.drafts.opening', 'Opening…') : tv('hedwig.v2.drafts.continue', 'Continue draft');
  const continueBar = data && trailingDraft && (phone
    ? (
      <div data-reply-bar="" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px 16px', flexShrink: 0 }}>
        <Btn accent size="phone" disabled={busy === 'editDraft'} onClick={() => editDraft(trailingDraft)}>
          <Icon name="file" size={16} />
          {continueLabel}
        </Btn>
      </div>
    )
    : (
      <div data-reply-bar="" style={{ position: 'sticky', bottom: 0, zIndex: 2, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 24px 14px', background: V.content, borderTop: `1px solid ${V.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, boxSizing: 'border-box', padding: '0 6px 0 12px', borderRadius: 10, background: V.field }}>
          <span aria-hidden="true" style={{ display: 'inline-flex', color: V.attentionInk }}><Icon name="file" size={14} /></span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: V.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tv('hedwig.v2.drafts.waiting', 'Your reply is saved as a draft.')}</span>
          <Btn accent disabled={busy === 'editDraft'} onClick={() => editDraft(trailingDraft)}>{continueLabel}</Btn>
        </div>
      </div>
    ));
  const savedNote = !phone && draft.trim() && savedText === draft
    ? <span data-draft-saved="" role="status" style={{ fontSize: 11, color: V.muted }}>{tv('hedwig.v2.drafts.saved', 'Draft saved')}</span>
    : null;
  const replyBar = continueBar || (data && latest && (phone
    ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px 16px', flexShrink: 0 }}>
        <QuickReplies phone items={quick} disabled={Boolean(busy)} onPick={(q) => run('reply', () => openReplyComposer(latestId, q))} />
        <button
          type="button"
          aria-label={replyLabel}
          onClick={() => run('reply', () => openReplyComposer(latestId, ''))}
          style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 14px', borderRadius: 10, border: 0, background: V.field, color: V.muted, font: 'inherit', fontSize: 15, textAlign: 'left', cursor: 'pointer' }}
        >
          <Icon name="reply" size={16} />
          {tv('hedwig.v2.thread.replyTo', 'Reply to {{name}}…', { name: replyTo })}
        </button>
      </div>
    )
    : (
      <div
        data-reply-bar=""
        onPointerDownCapture={() => { pointerInBar.current = true; setTimeout(() => { pointerInBar.current = false; }, 400); }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && !pointerInBar.current) setFocused(false); }}
        style={{ position: 'sticky', bottom: 0, zIndex: 2, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 24px 14px', background: V.content, borderTop: `1px solid ${V.line}` }}
      >
        <QuickReplies items={quick} disabled={Boolean(busy)} onPick={(q) => { setDraft(q); setFocused(true); inputRef.current?.focus(); }} />
        {warningLine}
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, boxSizing: 'border-box', padding: expanded ? '8px 8px 6px 12px' : '0 6px 0 12px', minHeight: 40, borderRadius: 10, background: V.field, border: `1px solid ${focused ? V.line2 : 'transparent'}` }}
        >
          <div style={{ display: 'flex', alignItems: expanded ? 'flex-start' : 'center', gap: 6, minHeight: expanded ? 0 : 38 }}>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
              placeholder={tv('hedwig.v2.thread.replyTo', 'Reply to {{name}}…', { name: replyTo })}
              aria-label={replyLabel}
              style={{ flexGrow: 1, minWidth: 0, resize: 'none', border: 0, padding: 0, margin: 0, background: 'transparent', font: 'inherit', fontSize: 13, lineHeight: '19px', color: V.ink, outline: 'none', overflowY: 'auto' }}
            />
            {!expanded && <IconButton icon="popout" label={tv('hedwig.v2.thread.popOut', 'Open in the composer')} onClick={popOut} />}
          </div>
          {expanded && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {helpMeWrite && work && (
                <button
                  type="button"
                  className="hw-btn"
                  disabled={Boolean(busy)}
                  onClick={draftInVoice}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 8px 0 6px', borderRadius: 6, border: 0, background: 'transparent', color: V.accentInk, font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                >
                  <Icon name="sparkles" size={14} />
                  <span>{busy === 'draft' ? tv('hedwig.v2.thread.drafting', 'Drafting…') : tv('hedwig.v2.thread.draftVoice', 'Draft in my voice')}</span>
                </button>
              )}
              {work && <RemindIfNoReply on={watchOn} days={remindDays} onToggle={setWatchOn} onDays={setRemindDays} />}
              <span style={{ flexGrow: 1 }} />
              {savedNote}
              <IconButton icon="popout" label={tv('hedwig.v2.thread.popOut', 'Open in the composer')} onClick={popOut} />
              <span aria-hidden="true" style={{ fontSize: 11, color: V.muted, fontVariantNumeric: 'tabular-nums' }}>{SEND_KEYS}</span>
              <Btn accent type="submit" title={`${tv('hedwig.v2.thread.send', 'Send')} (${SEND_KEYS})`} disabled={Boolean(busy) || !draft.trim()}>
                {busy === 'send' ? tv('hedwig.v2.thread.sending', 'Sending…') : warned ? tv('hedwig.v2.thread.sendAnyway', 'Send anyway') : tv('hedwig.v2.thread.send', 'Send')}
              </Btn>
            </div>
          )}
        </form>
      </div>
    )));

  const headersModal = headersFor && (
    <MessageHeaderModal messageId={headersFor} subject={title} onClose={() => setHeadersFor(null)} />
  );

  const content = (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: phone ? '16px 16px 0' : '20px 24px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontFamily: V.sans, fontWeight: 600, fontSize: phone ? 22 : 20, lineHeight: phone ? '28px' : '26px', letterSpacing: '-0.01em', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{title}</h2>
        {reasonLine}
      </div>
      {t.error && <ErrorLine error={t.error} onRetry={() => t.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {t.loading && !data && <Quiet style={{ padding: phone ? '16px' : '16px 24px' }}>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {data && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: pad, margin: '14px 0 16px', flexShrink: 0 }}>{summary}</div>
          {messageList}
        </>
      )}
      <div style={{ padding: pad, flexShrink: 0 }}><ErrorLine error={actionError} /></div>
    </>
  );

  if (phone) {
    const barBtn = { width: 44, height: 44, minWidth: 44, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: 0, background: 'transparent', color: V.ink, cursor: 'pointer', padding: 0 };
    return (
      <section ref={setSection} className="hw-v2" aria-label={title} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', color: V.ink, fontFamily: V.sans, background: V.content }}>
        <Sheet as="header" phone material="bar" radius={0} style={{ position: 'relative', zIndex: 3, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 4px) 4px 4px', borderBottom: `0.5px solid ${V.line2}` }}>
          <IconButton icon="chevron-left" size={44} label={tv('hedwig.v2.thread.back', 'Back')} onClick={() => phoneCtx?.back?.()} />
          <span style={{ flexGrow: 1 }} />
          <IconButton icon="flag" size={44} label={flagLabel} active={flagged} fill={flagged ? 'currentColor' : undefined} onClick={toggleFlag} style={flagged ? { color: V.accent } : undefined} />
        </Sheet>
        <div className="hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {content}
          <div style={{ flexGrow: 1 }} />
          {replyBar}
        </div>
        <Sheet as="footer" phone material="bar" radius={0} role="toolbar" aria-label={tv('hedwig.v2.thread.toolbar', 'Message actions')} style={{ position: 'relative', zIndex: 3, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-around', padding: '2px 8px calc(2px + env(safe-area-inset-bottom, 0px))', borderTop: `0.5px solid ${V.line2}` }}>
          <IconButton icon="circle-check" size={44} label={tv('hedwig.v2.thread.done', 'Done')} onClick={done} style={{ color: V.accent }} />
          <IconButton icon="trash" size={44} label={deleteLabel} onClick={del} />
          <MenuButton label={tv('hedwig.v2.thread.snooze', 'Snooze')} items={snoozeItems} align="left" width={220} buttonClassName="hw-icon-btn" buttonStyle={barBtn}>
            <Icon name="alarm-clock" size={22} />
          </MenuButton>
          <IconButton icon="reply" size={44} label={tv('hedwig.v2.thread.reply', 'Reply')} onClick={focusReply} />
          <MenuButton label={moreLabel} items={() => [
            ...(work ? [
              { id: 'later', label: tv('hedwig.v2.rail.replyLater', 'Reply Later'), icon: 'clock', onSelect: later },
              { id: 'aside', label: tv('hedwig.v2.thread.setAside', 'Set Aside'), icon: 'bookmark', onSelect: aside },
            ] : []),
            { id: 'junk', label: junkLabel, icon: 'alert-octagon', onSelect: junk },
            ...moreItems({ withReply: true }),
            { id: 'stream', label: tv('hedwig.v2.thread.changeStream', 'Change stream…'), icon: 'folder-input', onSelect: () => openDoor(null) },
          ]} align="right" width={240} buttonClassName="hw-icon-btn" buttonStyle={barBtn}>
            <Icon name="ellipsis" size={22} />
          </MenuButton>
        </Sheet>
        {door.element}
        {headersModal}
      </section>
    );
  }

  return (
    <section
      ref={setSection}
      className="hw-v2 hw-scroll"
      aria-label={title}
      style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden', color: V.ink, fontFamily: V.sans, fontSize: 13, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums', position: 'relative' }}
    >
      {toolbar}
      {content}
      <div style={{ flexGrow: 1 }} />
      {replyBar}
      {door.element}
      {headersModal}
    </section>
  );
}
