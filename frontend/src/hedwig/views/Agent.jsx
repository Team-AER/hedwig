// hedwig.agent — chat with the agent (streamed runs, tool steps, confirmations) and automations.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hedwigApi, hedwigStream } from '../api.js';
import { AGENT_INITIAL, citeResolver, formatArgs, formatAgo, itemsFromRun, reduceAgent, sourcesFromRun, truncate, updateActionInItems } from './helpers.js';
import { useAction, useResource } from './hooks.js';
import Automations from './Automations.jsx';
import {
  ActionError, Button, Card, Chip, Dot, Empty, Glyph, Loading, Markdown, SectionLabel, Spinner, StateView, T, Tabs, TextArea,
} from './ui.jsx';
import { tr } from './i18n.js';

const STATUS_TONE = { pending: 'amber', approved: 'teal', executed: 'teal', rejected: 'neutral', failed: 'red', running: 'teal', done: 'neutral', error: 'red', waiting: 'amber' };

export default function Agent({ props = {} }) {
  const [tab, setTab] = useState(props.tab === 'automations' ? 'automations' : 'chat');
  const [openRunId, setOpenRunId] = useState(props.runId || null);
  useEffect(() => { if (props.prompt) setTab('chat'); }, [props.prompt]);
  return (
    <section aria-label={tr('agent.agent', 'Agent')} style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: T.surface, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '16px 18px 10px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontFamily: T.display, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{tr('agent.agent', 'Agent')}</h1>
        <Tabs label="Agent sections" value={tab} onChange={setTab} tabs={[{ id: 'chat', label: 'Chat' }, { id: 'automations', label: 'Automations' }]} />
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex' }}>
        {tab === 'chat'
          ? <Chat initialPrompt={props.prompt} openRunId={openRunId} onRunOpened={() => setOpenRunId(null)} />
          : <Automations onOpenRun={(id) => { setOpenRunId(id); setTab('chat'); }} />}
      </div>
    </section>
  );
}

function Chat({ initialPrompt, openRunId, onRunOpened }) {
  const inputId = useId();
  const [input, setInput] = useState(initialPrompt || '');
  const [state, setState] = useState(AGENT_INITIAL);
  const [error, setError] = useState(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const ctlRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const runs = useResource('/agent/runs?limit=40');
  const pending = useResource('/agent/actions?status=pending', { refreshOn: ['hedwig:agent-actions-changed'] });

  useEffect(() => { if (initialPrompt) { setInput(initialPrompt); inputRef.current?.focus(); } }, [initialPrompt]);
  useEffect(() => () => ctlRef.current?.abort(), []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [state.items.length, state.status]);

  const loadRun = useCallback(async (id) => {
    ctlRef.current?.abort();
    setLoadingRun(true);
    setError(null);
    try {
      const data = await hedwigApi.get(`/agent/runs/${encodeURIComponent(id)}`);
      setState({
        ...AGENT_INITIAL, runId: data?.run?.id || id, status: data?.run?.status || 'done', items: itemsFromRun(data?.run, data?.actions),
        result: data?.run?.result ?? null, sources: Array.isArray(data?.sources) ? data.sources : sourcesFromRun(data?.run),
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoadingRun(false);
    }
  }, []);

  useEffect(() => { if (openRunId) { loadRun(openRunId); onRunOpened?.(); } }, [openRunId, loadRun, onRunOpened]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || state.status === 'running') return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setError(null);
    setInput('');
    setState((s) => ({ ...s, status: 'running', error: null, items: [...s.items, { kind: 'user', text: prompt }] }));
    const body = { prompt };
    if (state.runId) body.runId = state.runId;
    try {
      await hedwigStream('/agent/runs', body, { signal: ctl.signal, onEvent: (ev) => setState((s) => reduceAgent(s, ev)) });
      setState((s) => (s.status === 'running' ? { ...s, status: 'done' } : s));
    } catch (err) {
      if (!ctl.signal.aborted) setError(err);
      setState((s) => ({ ...s, status: ctl.signal.aborted ? 'stopped' : 'error' }));
    } finally {
      runs.reload({ quiet: true });
      pending.reload({ quiet: true });
    }
  };

  const onAction = (action) => {
    setState((s) => ({ ...s, items: updateActionInItems(s.items, action) }));
    pending.setData((list) => (list || []).filter((a) => a.id !== action.id || action.status === 'pending'));
  };

  const newChat = () => { ctlRef.current?.abort(); setState(AGENT_INITIAL); setError(null); inputRef.current?.focus(); };
  const shownActionIds = new Set(state.items.filter((i) => i.kind === 'action').map((i) => i.action?.id));
  const otherPending = (pending.data || []).filter((a) => !shownActionIds.has(a.id));
  const running = state.status === 'running';
  // [n] in the agent's answer is a message its search_mail found in this run; [msg:<id>] (older
  // runs) opens the message directly.
  const resolveCite = useMemo(() => citeResolver(state.sources), [state.sources]);

  return (
    <>
      <nav aria-label={tr('agent.runHistory', 'Run history')} style={{ width: 220, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: T.ground, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10 }}><Button size="sm" onClick={newChat} style={{ width: '100%' }}><Glyph name="plus" size={13} /> {tr('agent.newChat', 'New chat')}</Button></div>
        {runs.loading && !runs.data && <Loading />}
        {runs.error && !runs.data && <StateView error={runs.error} onRetry={runs.reload} what="Run history" compact />}
        {(runs.data || []).map((r) => (
          <button key={r.id} type="button" onClick={() => loadRun(r.id)} aria-current={state.runId === r.id || undefined} style={{
            display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px', border: 0, borderTop: `1px solid ${T.border}`, textAlign: 'left',
            background: state.runId === r.id ? T.surface : 'transparent', color: T.ink, font: 'inherit', fontSize: 13, cursor: 'pointer',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: state.runId === r.id ? 600 : 400 }}>{r.title || 'Untitled run'}</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: T.muted }}>
              <Dot size={6} color={toneColor(STATUS_TONE[r.status])} />{r.status}{r.trigger && r.trigger !== 'user' ? ` · ${r.trigger}` : ''} · {formatAgo(r.created_at)}
            </span>
          </button>
        ))}
      </nav>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', padding: '10px 18px', display: 'flex', flexDirection: 'column', gap: 12 }} aria-live="polite">
          {otherPending.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <SectionLabel>{tr('agent.waitingForYourApproval', 'Waiting for your approval')}</SectionLabel>
              {otherPending.map((a) => <ActionCard key={a.id} action={a} onChange={onAction} />)}
            </div>
          )}
          {loadingRun && <Loading label="Loading run…" />}
          {!loadingRun && !state.items.length && (
            <Empty title={tr('agent.whatShouldIDo', 'What should I do?')}>
              The agent can search and read your mail, look up people and topics, and draft replies. Anything that changes mail waits for you to approve it.
            </Empty>
          )}
          {state.items.map((it, i) => <Item key={i} item={it} onAction={onAction} resolveCite={resolveCite} />)}
          {running && <Spinner label="Working…" />}
          {state.error && <ActionError error={{ message: state.error }} />}
          <ActionError error={error} onDismiss={() => setError(null)} />
          <div ref={endRef} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ padding: '10px 18px 14px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label htmlFor={inputId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{tr('agent.messageTheAgent', 'Message the agent')}</label>
          <TextArea id={inputId} ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} rows={2}
            placeholder={state.runId ? 'Reply to continue this run…' : 'e.g. Find every invoice from Hetzner this year and total them'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            style={{ flexGrow: 1, minHeight: 44, background: T.ground }} />
          {running
            ? <Button onClick={() => ctlRef.current?.abort()}><Glyph name="stop" size={13} /> {tr('agent.stop', 'Stop')}</Button>
            : <Button variant="primary" type="submit" disabled={!input.trim()}><Glyph name="send" size={13} /> {tr('agent.send', 'Send')}</Button>}
        </form>
      </div>
    </>
  );
}

function toneColor(tone) {
  return { amber: T.amber, teal: T.teal, red: T.red }[tone] || T.muted;
}

function Item({ item, onAction, resolveCite }) {
  if (item.kind === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 12, background: T.raised, whiteSpace: 'pre-wrap', fontSize: 14 }}>
        {item.text}
      </div>
    );
  }
  if (item.kind === 'text') return item.text ? <Markdown text={item.text} resolveCite={resolveCite} /> : null;
  if (item.kind === 'note') return <div style={{ alignSelf: 'center', fontSize: 12, color: T.muted, textAlign: 'center', maxWidth: '85%' }}>{item.text}</div>;
  if (item.kind === 'tool') return <ToolStep step={item} />;
  if (item.kind === 'action') return <ActionCard action={item.action} onChange={onAction} />;
  return null;
}

function ToolStep({ step }) {
  const [open, setOpen] = useState(false);
  const color = !step.done ? T.muted : step.ok === false ? T.red : T.teal;
  return (
    <div style={{ fontSize: 12, color: T.muted, borderLeft: `2px solid ${T.border}`, paddingLeft: 10 }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{
        display: 'flex', gap: 6, alignItems: 'center', border: 0, padding: 0, background: 'none', color: T.muted, font: 'inherit', cursor: 'pointer', textAlign: 'left', maxWidth: '100%',
      }}>
        <Glyph name={open ? 'chevronDown' : 'chevron'} size={12} />
        {step.done ? <Dot color={color} size={6} /> : <Spinner size={10} />}
        <span style={{ fontFamily: T.mono, color: T.ink }}>{step.name}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {step.done ? truncate(step.summary || (step.ok === false ? 'failed' : 'done'), 120) : formatArgs(step.arguments)}
        </span>
      </button>
      {open && (
        <div style={{ padding: '6px 0 2px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {step.arguments && <code style={{ fontFamily: T.mono, fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{formatArgs(step.arguments)}</code>}
          {step.summary && <span style={{ whiteSpace: 'pre-wrap' }}>{step.summary}</span>}
        </div>
      )}
    </div>
  );
}

export function ActionCard({ action, onChange }) {
  const [result, setResult] = useState(null);
  const approve = useAction(async () => {
    const out = await hedwigApi.post(`/agent/actions/${encodeURIComponent(action.id)}/approve`);
    if (out?.result !== undefined) setResult(out.result);
    onChange?.(out?.action || { ...action, status: 'approved' });
    window.dispatchEvent(new CustomEvent('hedwig:agent-actions-changed'));
    window.dispatchEvent(new CustomEvent('mailflow:refresh'));
  });
  const reject = useAction(async () => {
    const out = await hedwigApi.post(`/agent/actions/${encodeURIComponent(action.id)}/reject`);
    onChange?.(out?.action || { ...action, status: 'rejected' });
    window.dispatchEvent(new CustomEvent('hedwig:agent-actions-changed'));
  });
  if (!action) return null;
  const pending = action.status === 'pending';
  const shownResult = result ?? action.result;
  return (
    <Card style={{ borderColor: pending ? T.amber : T.border, gap: 6 }} aria-label={tr('agent.proposedAction', 'Proposed action')}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip tone={STATUS_TONE[action.status] || 'neutral'}>{pending ? 'Needs your OK' : action.status}</Chip>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>{action.tool}</span>
      </div>
      <div style={{ fontWeight: 500 }}>{action.summary || action.tool}</div>
      {action.args && <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, overflowWrap: 'anywhere' }}>{formatArgs(action.args)}</div>}
      {pending && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm" busy={approve.busy} disabled={reject.busy} onClick={() => approve.run()}>{tr('agent.approve', 'Approve')}</Button>
          <Button size="sm" busy={reject.busy} disabled={approve.busy} onClick={() => reject.run()}>{tr('agent.reject', 'Reject')}</Button>
        </div>
      )}
      {shownResult != null && !pending && (
        <div style={{ fontSize: 12, color: T.muted }}>{typeof shownResult === 'string' ? shownResult : truncate(JSON.stringify(shownResult), 200)}</div>
      )}
      <ActionError error={approve.error || reject.error} onDismiss={() => { approve.clearError(); reject.clearError(); }} />
    </Card>
  );
}
