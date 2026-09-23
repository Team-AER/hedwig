// "Hedwig today" (GET /sort/today): everything Hedwig decided on its own today, newest first,
// each with Undo (POST /sort/undo). The rail and the Brief link here with "Review or undo".
import { useState } from 'react';
import { useV2Resource } from './hooks.js';
import { v2Api, listOf, announceSortChange } from './client.js';
import { streamTitle } from './StreamView.jsx';
import { ErrorLine, Figure, LinkBtn, Mono, Quiet, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { listTime } from './format.js';
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

export default function Today() {
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource('/sort/today');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
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
  const figures = [
    { n: d.screened, label: tv('hedwig.v2.today.figScreened', 'senders screened') },
    { n: d.bundled, label: tv('hedwig.v2.today.figBundled', 'bundled') },
    { n: d.rescued, label: tv('hedwig.v2.today.figRescued', 'rescued from spam') },
    { n: d.blocked, label: tv('hedwig.v2.today.figBlocked', 'blocked') },
  ];

  return (
    <ViewBody phone={phone} label={title} padded={!phone}>
      <ViewHead phone={phone} title={title}>
        <Why>{tv('hedwig.v2.today.intro', 'Everything Hedwig decided on its own today. Undo puts it back and teaches it.')}</Why>
      </ViewHead>
      <div style={{ padding: phone ? '0 16px' : '0 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
        <ErrorLine error={error} />
        {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
        {res.data && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${phone ? 2 : 4}, minmax(0, 1fr))`, rowGap: 16 }}>
            {figures.map((f, i) => (
              <Figure key={i} value={String(f.n ?? 0)} caption={f.label} size={phone ? 30 : 36} style={{ paddingLeft: i % (phone ? 2 : 4) ? 16 : 0, borderLeft: i % (phone ? 2 : 4) ? `1px solid ${V.line2}` : 0 }} />
            ))}
          </div>
        )}
        {res.data && !entries.length && <Quiet><Why>{tv('hedwig.v2.today.empty', 'Hedwig has not decided anything on its own today.')}</Why></Quiet>}
        {entries.length > 0 && (
          <div role="list" style={{ display: 'flex', flexDirection: 'column' }}>
            {entries.map((e) => {
              const undone = e.undone;
              // Sender-level entries (a decision, a bundle delivery) have no message: the action is the line.
              const head = [e.sender, e.subject].filter(Boolean).join(' · ');
              return (
                <div role="listitem" key={e.id} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', columnGap: 12, alignItems: 'baseline', padding: '12px 0', borderTop: `1px solid ${V.line}`, opacity: undone ? 0.55 : 1 }}>
                  <Mono size={12}>{listTime(e.at)}</Mono>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    {head && e.messageId ? (
                      <button
                        type="button"
                        className="hw-link"
                        onClick={() => openThread({ messageId: e.messageId, threadId: e.threadId, subject: e.subject })}
                        style={{ font: 'inherit', fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0, border: 0, background: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent' }}
                      >
                        {head}
                      </button>
                    ) : head ? (
                      <span style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{head}</span>
                    ) : null}
                    <span style={head ? { fontSize: 13, color: V.muted } : { fontSize: 15 }}>{actionLabel(e)}</span>
                    {e.reason && <Why>{e.reason}</Why>}
                  </div>
                  {undone
                    ? <span style={{ fontSize: 13, color: V.muted }}>{tv('hedwig.v2.today.undone', 'Undone')}</span>
                    : !e.undoable ? <span />
                    : <LinkBtn disabled={busy === e.id} onClick={() => undo(e)} style={{ minHeight: phone ? 44 : undefined }}>{tv('hedwig.v2.today.undo', 'Undo')}</LinkBtn>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ViewBody>
  );
}
