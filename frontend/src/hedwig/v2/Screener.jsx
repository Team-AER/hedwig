// The Screener (GET /sort/screener): each new sender with Hedwig's proposed stream and the reason.
// Pick another stream or keep the proposal, accept it, or accept every proposal at once. Mail
// found in the server's spam folder that looks real is tinted and says so.
import { useMemo, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2Resource, useWork } from './hooks.js';
import { useTldrs, withTldrs } from './tldrs.js';
import { v2Api, listOf, announceSortChange } from './client.js';
import { Btn, ErrorLine, Glyph, Hair, Mono, Pick, Quiet, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { tv, tvn } from './i18n.js';
import { tldrOf } from './format.js';

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

function SenderRow({ sender, choice, onChoose, onAccept, busy, phone }) {
  const block = choice === 'block';
  const rescue = Boolean(sender.inSpam);
  const acceptLabel = rescue && !block
    ? tv('hedwig.v2.screener.acceptRescue', 'Accept: {{stream}}, rescue from spam', { stream: decisionLabel(choice) })
    : tv('hedwig.v2.screener.accept', 'Accept: {{stream}}', { stream: decisionLabel(choice) });
  const meta = [sender.address, sender.count ? String(sender.count) : null, rescue ? tv('hedwig.v2.screener.inSpam', 'in spam') : null].filter(Boolean).join(' · ');
  // What they wrote: Hedwig's one-line TL;DR of the latest message when there is one, else its subject.
  const latestSubject = Array.isArray(sender.subjects) ? sender.subjects.find((x) => typeof x === 'string' && x.trim()) : null;
  const summary = tldrOf(sender) || (latestSubject ? latestSubject.trim() : null);
  return (
    <article
      aria-label={sender.display || sender.address}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: rescue ? '16px 12px' : '16px 4px',
        margin: rescue ? '0 -8px' : 0,
        borderRadius: rescue ? 16 : 0,
        background: rescue ? V.accentTint : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sender.display || sender.address}</span>
          <Mono color={rescue ? V.inkSoft : V.muted} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</Mono>
        </div>
        <button
          type="button"
          aria-label={acceptLabel}
          title={acceptLabel}
          disabled={busy}
          onClick={onAccept}
          className="hw-btn-solid"
          style={{
            width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, padding: 0, flexShrink: 0, cursor: 'pointer',
            background: block ? V.ink : V.accent, color: block ? V.paper : V.onAccent,
          }}
        >
          <Glyph name={block ? 'close' : 'check'} stroke={1.8} />
        </button>
      </div>
      {summary && (
        <span data-tldr="" style={{ fontSize: 14, lineHeight: 1.4, color: rescue ? V.inkSoft : V.ink, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {summary}
        </span>
      )}
      {(rescue || sender.reason) && (
        <Why tone={rescue ? 'accent' : 'muted'}>
          {rescue ? rescueLine(sender.reason) : sender.reason}
        </Why>
      )}
      <Pick label={tv('hedwig.v2.screener.streamFor', 'Stream for {{name}}', { name: sender.display || sender.address })} options={decisionOptions()} value={choice} onChange={onChoose} size={phone ? 44 : 40} />
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
    ? <Btn solid size={phone ? 'phone' : 'md'} disabled={Boolean(busy)} onClick={acceptAll}>{tv('hedwig.v2.screener.acceptAll', 'Accept all')}</Btn>
    : null;

  return (
    <ViewBody phone={phone} label={title} padded={!phone}>
      <ViewHead phone={phone} title={title} sub={sub} actions={acceptAllBtn}>
        <Why style={{ paddingBottom: phone ? 0 : 0 }}>{tv('hedwig.v2.screener.intro', 'Each new sender comes with a proposed stream and the reason. Accept it or pick another; Hedwig remembers.')}</Why>
      </ViewHead>
      <div style={{ padding: phone ? '0 16px' : '0 12px', display: 'flex', flexDirection: 'column' }}>
        {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
        <ErrorLine error={error} />
        {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
        {!res.loading && !res.error && !senders.length && <Quiet><Why>{tv('hedwig.v2.screener.empty', 'No new senders. Hedwig will ask when someone new writes.')}</Why></Quiet>}
        {senders.map((s, i) => {
          const k = `${s.scope}:${s.key}`;
          const prevRescue = i > 0 && senders[i - 1].inSpam;
          return (
            <div key={k}>
              {i > 0 && !s.inSpam && !prevRescue && <Hair />}
              <SenderRow
                sender={s}
                phone={phone}
                choice={choiceOf(s)}
                busy={Boolean(busy)}
                onChoose={(v) => setChoices((c) => ({ ...c, [k]: v }))}
                onAccept={() => decide(s)}
              />
            </div>
          );
        })}
      </div>
    </ViewBody>
  );
}
