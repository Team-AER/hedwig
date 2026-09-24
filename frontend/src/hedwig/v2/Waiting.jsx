// hedwig.waiting: what you asked and have not heard back about (GET /work/waiting). Each row says
// who, what, and how long ago you asked; Nudge drafts a follow-up in your voice and opens the
// composer with it (POST /work/waiting/:threadId/nudge), Resolve stops waiting
// (POST /work/waiting/:threadId/resolve).
import { useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2Resource, useWork, isMissing } from './hooks.js';
import { v2Api, listOf, announceSortChange } from './client.js';
import { openThread } from './nav.js';
import { useV2 } from './state.js';
import { nudgeThread } from './mail.js';
import { Avatar, ErrorLine, Hair, IconButton, Num, Quiet, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { tv, tvn } from './i18n.js';

function notify(type, title, body) {
  useStore.getState().addNotification?.({ type, title, ...(body ? { body } : {}) });
}

/** "asked 6 days ago", "asked today". */
export function askedLabel(days) {
  const n = Math.max(0, Math.round(Number(days) || 0));
  if (n === 0) return tv('hedwig.v2.waiting.askedToday', 'asked today');
  return tvn(n, ['hedwig.v2.waiting.askedOne', 'asked yesterday'], ['hedwig.v2.waiting.askedMany', 'asked {{n}} days ago']);
}

export function WaitingRow({ w, phone, busy, onNudge, onResolve }) {
  const av = phone ? 40 : 36;
  const open = () => openThread({ threadId: w.threadId, messageId: w.messageId, subject: w.subject });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `8px ${av}px minmax(0, 1fr)`, columnGap: 10, alignItems: 'start', padding: phone ? '12px 8px' : '10px 14px 10px 8px', minHeight: phone ? 88 : 76, boxSizing: 'border-box' }}>
      <span aria-hidden="true" />
      <Avatar name={w.who} email={w.email || w.to?.email} size={av} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '16px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.who || w.subject}</span>
          <Num size={phone ? 13 : 11}>{askedLabel(w.days)}</Num>
        </span>
        <button
          type="button"
          onClick={open}
          className="hw-link"
          aria-label={[w.who, w.subject].filter(Boolean).join(' · ')}
          style={{ padding: 0, border: 0, background: 'none', color: V.ink, font: 'inherit', fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '18px', textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent', overflowWrap: 'anywhere', minHeight: phone ? 44 : undefined }}
        >
          {w.subject || w.who}
        </button>
        {w.reason && <Why size={phone ? 13 : 12}>{w.reason}</Why>}
        <div style={{ display: 'flex', alignItems: 'center', gap: phone ? 4 : 12, paddingTop: 4, marginLeft: phone ? -10 : -4 }}>
          <IconButton
            icon="bell"
            data-nudge=""
            label={busy === 'nudge' ? tv('hedwig.v2.thread.drafting', 'Drafting…') : tv('hedwig.v2.brief.nudge', 'Nudge')}
            aria-busy={busy === 'nudge' || undefined}
            size={phone ? 44 : 28}
            disabled={Boolean(busy)}
            onClick={() => onNudge(w)}
            style={{ color: V.accentInk }}
          />
          <IconButton
            icon="circle-check"
            data-resolve=""
            label={tv('hedwig.v2.waiting.resolve', 'Resolve')}
            size={phone ? 44 : 28}
            disabled={Boolean(busy)}
            onClick={() => onResolve(w)}
            style={{ color: V.muted }}
          />
        </div>
      </div>
    </div>
  );
}

export default function Waiting() {
  const phone = Boolean(usePhone()?.phone);
  const work = useWork();
  const caps = useV2((s) => s.caps.work);
  const res = useV2Resource(work ? '/work/waiting' : null);
  const [busy, setBusy] = useState({}); // threadId -> 'nudge' | 'resolve'
  const [gone, setGone] = useState([]);
  const rows = listOf(res.data, 'items').filter((w) => !gone.includes(w.threadId));
  const title = tv('hedwig.v2.waiting.title', 'Waiting on');

  const act = async (w, key, fn) => {
    setBusy((b) => ({ ...b, [w.threadId]: key }));
    try { await fn(); } catch (e) {
      notify('error', key === 'nudge' ? tv('hedwig.v2.waiting.nudgeFailed', 'Could not start the nudge') : tv('hedwig.v2.waiting.resolveFailed', 'Could not stop waiting'), e?.message);
    } finally { setBusy((b) => ({ ...b, [w.threadId]: null })); }
  };
  const onNudge = (w) => act(w, 'nudge', () => nudgeThread(w));
  const onResolve = (w) => act(w, 'resolve', async () => {
    await v2Api.post(`/work/waiting/${encodeURIComponent(w.threadId)}/resolve`);
    setGone((g) => [...g, w.threadId]);
    notify('success', tv('hedwig.v2.waiting.resolved', 'No longer waiting on {{who}}.', { who: w.who || '' }));
    announceSortChange({ resolved: w.threadId });
  });

  const body = (
    <>
      {caps === false && <Quiet><Why>{tv('hedwig.v2.list.unavailable', 'This list is not available yet.')}</Why></Quiet>}
      {res.error && (isMissing(res.error)
        ? <Quiet><Why>{tv('hedwig.v2.list.unavailable', 'This list is not available yet.')}</Why></Quiet>
        : <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />)}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {res.data && !rows.length && <Quiet><Why>{tv('hedwig.v2.waiting.empty', 'Nobody owes you a reply.')}</Why></Quiet>}
      {rows.map((w, i) => (
        <div key={w.threadId}>
          {i > 0 && <Hair style={{ margin: `0 0 0 ${phone ? 66 : 62}px` }} />}
          <WaitingRow w={w} phone={phone} busy={busy[w.threadId]} onNudge={onNudge} onResolve={onResolve} />
        </div>
      ))}
    </>
  );
  const sub = rows.length ? String(rows.length) : null;
  if (phone) {
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub} />
        <div style={{ padding: '0 8px' }}>{body}</div>
      </ViewBody>
    );
  }
  return (
    <ViewBody label={title} padded={false} style={{ padding: '14px 0 16px' }}>
      <ViewHead title={title} sub={sub} />
      <div style={{ padding: '0 6px' }}>{body}</div>
    </ViewBody>
  );
}
