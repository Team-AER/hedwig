// hedwig.ask — ask a question across all mail; streamed, cited answer with numbered sources.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { hedwigStream } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { ASK_INITIAL, followUps, formatAgo, reduceAsk, senderName, truncate } from './helpers.js';
import { openMessage, useResource } from './hooks.js';
import {
  AccountDot, ActionError, Button, Chip, IconButton, Markdown, RelativeTime, SectionLabel, Spinner, T, TextInput,
} from './ui.jsx';
import { tr } from './i18n.js';

export default function Ask({ props = {} }) {
  const inputId = useId();
  const accounts = useStore((s) => s.accounts);
  const openView = useHedwig((s) => s.openView);
  const askPrompt = useHedwig((s) => s.askPrompt);
  const setAskPrompt = useHedwig((s) => s.setAskPrompt);
  const [question, setQuestion] = useState(props.question || '');
  const [scope, setScope] = useState({ entityId: props.entityId || null, topicId: props.topicId || null });
  const [answer, setAnswer] = useState(ASK_INITIAL);
  const [asked, setAsked] = useState(null);
  const [error, setError] = useState(null);
  const ctlRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { setScope({ entityId: props.entityId || null, topicId: props.topicId || null }); }, [props.entityId, props.topicId]);

  const entity = useResource(scope.entityId ? `/context/entities/${encodeURIComponent(scope.entityId)}` : null);
  const topic = useResource(scope.topicId ? `/context/topics/${encodeURIComponent(scope.topicId)}` : null);
  const history = useResource('/context/ask/history');
  const entityName = entity.data?.entity?.display_name;
  const topicLabel = topic.data?.topic?.label;
  const reloadHistory = history.reload;

  useEffect(() => () => ctlRef.current?.abort(), []);

  const run = useCallback(async (raw, override) => {
    const q = String(raw || '').trim();
    if (!q) return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    const sc = override || scope;
    setQuestion(q);
    setAsked({ question: q, ...sc });
    setError(null);
    setAnswer({ ...ASK_INITIAL, status: 'streaming' });
    const body = { question: q };
    if (sc.entityId) body.entityId = sc.entityId;
    if (sc.topicId) body.topicId = sc.topicId;
    try {
      await hedwigStream('/context/ask', body, { signal: ctl.signal, onEvent: (ev) => setAnswer((s) => reduceAsk(s, ev)) });
      setAnswer((s) => (s.status === 'streaming' ? { ...s, status: 'done' } : s));
      reloadHistory({ quiet: true });
    } catch (err) {
      if (ctl.signal.aborted) { setAnswer((s) => ({ ...s, status: s.answer ? 'done' : 'idle' })); return; }
      setError(err);
      setAnswer((s) => ({ ...s, status: 'error' }));
    }
  }, [scope, reloadHistory]);

  // Autorun once for a question handed over by another view or the palette.
  const autoRan = useRef('');
  useEffect(() => {
    if (!props.question || autoRan.current === props.question) return;
    autoRan.current = props.question;
    run(props.question);
  }, [props.question, run]);
  useEffect(() => {
    if (!askPrompt) return;
    setAskPrompt('');
    run(askPrompt);
  }, [askPrompt, setAskPrompt, run]);
  useEffect(() => { if (!props.question) inputRef.current?.focus({ preventScroll: true }); }, [props.question]);

  const streaming = answer.status === 'streaming';
  const sources = answer.sources || [];
  const cited = new Set(answer.citations || []);
  const suggestions = asked && answer.status === 'done' ? followUps(asked.question, { entityName, topicLabel }) : [];
  const accountCount = accounts?.length || 0;

  return (
    <section aria-label="Ask" style={{
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
      background: T.surface, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <form onSubmit={(e) => { e.preventDefault(); run(question); }} style={{ padding: '22px 24px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ margin: 0, fontFamily: T.display, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{tr('ask.askAcrossAllMail', 'Ask across all mail')}</h1>
        <label htmlFor={inputId} style={{ fontSize: 12, color: T.muted }}>
          Question · searches {accountCount ? `${accountCount} account${accountCount === 1 ? '' : 's'}` : 'your mail'}
          {scope.entityId || scope.topicId ? ', scoped as below' : ''}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput id={inputId} ref={inputRef} value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(question); } }}
            placeholder={tr('ask.whereAreWeOnWhat', 'Where are we on…, what do I still owe…, when did…')}
            style={{ flexGrow: 1, height: 40, fontSize: 14, background: T.ground }} />
          {streaming
            ? <Button variant="secondary" onClick={() => ctlRef.current?.abort()} style={{ height: 40 }}>{tr('ask.stop', 'Stop')}</Button>
            : <Button variant="primary" type="submit" disabled={!question.trim()} style={{ height: 40, padding: '0 16px' }}>Ask</Button>}
        </div>
        {(scope.entityId || scope.topicId) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {scope.topicId && (
              <ScopeChip tone="teal" label={`topic: ${topicLabel || '…'}`} onRemove={() => setScope((s) => ({ ...s, topicId: null }))} />
            )}
            {scope.entityId && (
              <ScopeChip tone="neutral" label={`person: ${entityName || '…'}`} onRemove={() => setScope((s) => ({ ...s, entityId: null }))} />
            )}
          </div>
        )}
      </form>

      <div style={{ flexGrow: 1, padding: '4px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ActionError error={error} onDismiss={() => setError(null)} />
        {answer.error && <ActionError error={{ message: answer.error }} />}

        {asked && (answer.answer || streaming) && (
          <div aria-live="polite" style={{ padding: '16px 18px', borderRadius: 12, background: T.ground, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {answer.answer
              ? <Markdown text={answer.answer} resolveCite={(n) => sources.find((s) => s.n === n)?.message} />
              : <Spinner label={sources.length ? `Reading ${sources.length} messages…` : 'Searching your mail…'} />}
            {answer.status === 'done' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6, borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.muted }}>
                <span>{sources.length} source{sources.length === 1 ? '' : 's'}{cited.size ? ` · ${cited.size} cited` : ''}</span>
                <span style={{ flexGrow: 1 }} />
                <Button size="sm" onClick={() => navigator.clipboard?.writeText(answer.answer)}>{tr('ask.copy', 'Copy')}</Button>
                <Button size="sm" onClick={() => openView('hedwig.agent', { prompt: asked.question })}>{tr('ask.askTheAgentInstead', 'Ask the agent instead')}</Button>
              </div>
            )}
          </div>
        )}

        {sources.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>{tr('ask.sources', 'Sources')}</SectionLabel>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {sources.map((s) => (
                <li key={s.n}>
                  <button type="button" onClick={() => openMessage(s.message?.id, { lite: s.message })} style={{
                    display: 'flex', gap: 10, alignItems: 'baseline', width: '100%', padding: '7px 0', border: 0, borderTop: `1px solid ${T.raised}`,
                    background: 'transparent', color: T.ink, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
                    opacity: cited.size && !cited.has(s.n) ? 0.6 : 1,
                  }}>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.tealText, minWidth: 22 }}>[{s.n}]</span>
                    <AccountDot account={s.message?.account} size={8} />
                    <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong style={{ fontWeight: 600 }}>{senderName(s.message)}</strong> · {s.message?.subject || '(no subject)'}
                    </span>
                    <RelativeTime value={s.message?.date} style={{ fontSize: 12, color: T.muted }} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        {suggestions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SectionLabel>{tr('ask.followUps', 'Follow-ups')}</SectionLabel>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => run(s)} style={{
                  padding: '6px 10px', border: `1px solid ${T.border}`, borderRadius: 999, background: T.surface, color: T.ink, font: 'inherit', fontSize: 12, cursor: 'pointer',
                }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {!asked && (
          <div style={{ fontSize: 13, color: T.muted, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>{tr('ask.answersCiteTheMessagesThey', 'Answers cite the messages they come from; click a number to open it.')}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button size="sm" onClick={() => openView('hedwig.agent', { prompt: question })}>{tr('ask.askTheAgentInstead', 'Ask the agent instead')}</Button>
            </div>
          </div>
        )}

        <span style={{ flexGrow: 1 }} />
        {history.data?.length > 0 && (
          <div style={{ fontSize: 12, color: T.muted, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span>{tr('ask.earlier', 'Earlier:')}</span>
            {history.data.slice(0, 6).map((h, i) => (
              <span key={h.id || i} style={{ display: 'inline-flex', gap: 6 }}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <button type="button" title={h.created_at ? `Asked ${formatAgo(h.created_at)}` : undefined} onClick={() => run(h.question, { entityId: null, topicId: null })}
                  style={{ border: 0, padding: 0, background: 'none', color: T.muted, font: 'inherit', fontStyle: 'italic', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: T.border }}>
                  {truncate(h.question, 60)}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ScopeChip({ label, tone, onRemove }) {
  return (
    <Chip tone={tone} size="md" style={{ paddingRight: 4, fontWeight: 400 }}>
      {label}
      <IconButton label={`Remove scope ${label}`} icon="close" size={18} onClick={onRemove} style={{ color: 'inherit' }} />
    </Chip>
  );
}
