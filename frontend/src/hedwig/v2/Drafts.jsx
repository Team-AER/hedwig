// hedwig.drafts: saved drafts from every account, newest first, as a message list (the search
// field, the title with its count, then rows in the stream rows' language). A row is the
// recipient's avatar (or "Draft" when there is no recipient yet), a small "Draft" label with the
// recipient and the date, the subject and the snippet. Opening one hands it to upstream's
// composer exactly as the classic Drafts folder does (openDraftInComposer): saving replaces the
// stored copy, sending deletes it. The list reloads when the composer closes and on mail events.
import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2, watchDrafts } from './state.js';
import { openDraft, draftRecipient } from './drafts.js';
import { ListSearch, rowDate, onListKeyDown } from './rows.jsx';
import { Avatar, ErrorLine, Hair, Num, Quiet, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { tv } from './i18n.js';

const draftKey = (m) => m.id || `${m.account_id}:${m.folder}:${m.uid}`;

/** One draft row: a single button (Enter opens it in the composer). */
export function DraftRow({ m, phone = false, busy = false, onOpen }) {
  const [hot, setHot] = useState(false);
  const to = draftRecipient(m);
  const name = to ? (to.name || to.email) : '';
  const subject = m.subject && m.subject !== '(no subject)' ? m.subject : tv('hedwig.v2.row.noSubject', '(no subject)');
  const snippet = typeof m.snippet === 'string' ? m.snippet.replace(/\s+/g, ' ').trim() : '';
  const draftWord = tv('hedwig.v2.drafts.label', 'Draft');
  const av = phone ? 40 : 36;
  const line1 = phone ? 20 : 16;
  return (
    <article
      className="hw-row"
      data-draft-row=""
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', minHeight: phone ? 88 : 76, padding: phone ? '12px 8px' : '10px 14px 10px 8px', borderRadius: 8, background: hot ? V.hover : undefined }}
    >
      <button
        type="button"
        data-row-button=""
        disabled={busy}
        onClick={() => onOpen(m)}
        aria-label={tv('hedwig.v2.drafts.rowLabel', 'Draft to {{name}}: {{subject}}', { name: name || tv('hedwig.v2.drafts.noRecipient', 'no recipient yet'), subject })}
        style={{
          display: 'grid', gridTemplateColumns: `8px ${av}px minmax(0, 1fr)`, columnGap: 10, alignItems: 'start',
          width: '100%', padding: 0, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: busy ? 'progress' : 'pointer',
        }}
      >
        <span aria-hidden="true" />
        <Avatar name={name || draftWord} email={to?.email} size={av} dashed={!to} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, minHeight: line1 }}>
            <span data-draft-label="" style={{ flexShrink: 0, fontSize: phone ? 13 : 11, lineHeight: `${line1}px`, fontWeight: 600, color: V.attentionInk }}>{draftWord}</span>
            <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: phone ? 15 : 13, lineHeight: `${line1}px`, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: name ? V.ink : V.muted }}>
              {name || tv('hedwig.v2.drafts.noRecipientShort', 'No recipient')}
            </span>
            <Num size={phone ? 13 : 11} style={{ flexShrink: 0 }}>{busy ? tv('hedwig.v2.drafts.opening', 'Opening…') : rowDate(m.date)}</Num>
          </span>
          <span style={{ fontSize: phone ? 15 : 13, lineHeight: phone ? '20px' : '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</span>
          {snippet && (
            <span style={{ fontSize: phone ? 14 : 12, lineHeight: phone ? '19px' : '16px', color: V.muted, overflow: 'hidden', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {snippet}
            </span>
          )}
        </span>
      </button>
    </article>
  );
}

export default function Drafts() {
  const phone = Boolean(usePhone()?.phone);
  const drafts = useV2((s) => s.drafts);
  const accounts = useStore((s) => s.accounts);
  const [opening, setOpening] = useState(null);

  // Fresh on open, and live (mail events, the composer closing) while on screen.
  useEffect(() => {
    const unwatch = watchDrafts();
    useV2.getState().refreshDrafts();
    return unwatch;
  }, []);

  const open = async (m) => {
    const key = draftKey(m);
    setOpening(key);
    try {
      await openDraft(m);
    } catch (e) {
      useStore.getState().addNotification?.({ type: 'error', title: tv('hedwig.v2.drafts.openFailed', 'Could not open this draft'), body: e?.message });
    } finally {
      setOpening((k) => (k === key ? null : k));
    }
  };

  const items = drafts.items || [];
  const title = tv('hedwig.v2.drafts.title', 'Drafts');
  const body = (
    <div onKeyDown={onListKeyDown}>
      {drafts.error && <ErrorLine error={drafts.error} onRetry={() => useV2.getState().refreshDrafts()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {drafts.items === null && !drafts.error && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {drafts.items !== null && !items.length && !drafts.error && (
        <Quiet><Why>{(accounts || []).length ? tv('hedwig.v2.drafts.empty', 'No drafts. Anything you save from the composer waits here.') : tv('hedwig.v2.rail.noAccounts', 'Add an account')}</Why></Quiet>
      )}
      {items.map((m, i) => (
        <div key={draftKey(m)}>
          {i > 0 && <Hair style={{ margin: `0 0 0 ${phone ? 66 : 62}px` }} />}
          <DraftRow m={m} phone={phone} busy={opening === draftKey(m)} onOpen={open} />
        </div>
      ))}
    </div>
  );
  const sub = items.length ? String(items.length) : null;
  if (phone) {
    // The phone stack gives this view its own title bar; the search field and the rows follow it.
    return (
      <ViewBody phone label={title} padded={false}>
        <div style={{ padding: '8px 16px 4px' }}><ListSearch phone /></div>
        <div style={{ padding: '0 8px' }}>{body}</div>
      </ViewBody>
    );
  }
  return (
    <ViewBody label={title} padded={false} style={{ padding: '10px 0 0' }}>
      <ViewHead title={title} sub={sub} before={<ListSearch style={{ marginBottom: 2 }} />} />
      <div style={{ padding: '0 6px 16px' }}>{body}</div>
    </ViewBody>
  );
}
