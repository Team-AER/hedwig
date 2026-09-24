// Editable commitment and fact lists, shared by the context card and the topic timeline.
import { useState } from 'react';
import { hedwigApi } from '../api.js';
import { dueLabel, formatAgo } from './helpers.js';
import { openMessage, useAction } from './hooks.js';
import { ActionError, Button, Dot, IconButton, SectionLabel, T, TextInput } from './ui.jsx';
import { tr } from './i18n.js';

export function patchCommitment(id, patch) {
  return hedwigApi.patch(`/context/commitments/${encodeURIComponent(id)}`, patch);
}

export function patchFact(id, patch) {
  return hedwigApi.patch(`/context/facts/${encodeURIComponent(id)}`, patch);
}

function commitmentLine(c, counterpartyName) {
  const who = c.counterparty || counterpartyName || 'them';
  return c.direction === 'i_owe' ? `You → ${who}: ${c.what}` : `${who} → you: ${c.what}`;
}

function commitmentSub(c) {
  const bits = [];
  if (c.due_at) bits.push(dueLabel(c.due_at));
  else if (c.direction === 'they_owe' && c.created_at) bits.push(`waiting since ${formatAgo(c.created_at).replace(' ago', '')}`);
  if (c.status && c.status !== 'open') bits.push(c.status);
  return bits.join(' · ');
}

/**
 * Commitments with done / dismiss / edit. `onChange(updated)` receives the patched commitment;
 * `editable` adds inline editing of the text and due date.
 */
export function CommitmentList({ items, onChange, counterpartyName, editable = false, title = 'Open commitments', showDone = false }) {
  const [editing, setEditing] = useState(null);
  const act = useAction(async (c, patch) => {
    const updated = await patchCommitment(c.id, patch);
    onChange?.(updated || { ...c, ...patch });
    setEditing(null);
  });
  const list = (items || []).filter((c) => showDone || !c.status || c.status === 'open');
  if (!list.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {title && <SectionLabel>{title}</SectionLabel>}
      {list.map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, opacity: c.status && c.status !== 'open' ? 0.6 : 1 }}>
          <Dot color={c.direction === 'i_owe' ? T.amber : T.teal} style={{ marginTop: 6 }} />
          {editing === c.id ? (
            <CommitmentEditor c={c} busy={act.busy} onCancel={() => setEditing(null)} onSave={(patch) => act.run(c, patch)} />
          ) : (
            <span style={{ flexGrow: 1, minWidth: 0 }}>
              {commitmentLine(c, counterpartyName)}
              <br />
              <span style={{ fontSize: 12, color: c.overdue ? T.red : T.muted }}>
                {commitmentSub(c)}
                {c.source_message_id && (
                  <>{commitmentSub(c) ? ' · ' : ''}<button type="button" onClick={() => openMessage(c.source_message_id)}
                    style={{ border: 0, padding: 0, background: 'none', color: T.teal, font: 'inherit', cursor: 'pointer' }}>source</button></>
                )}
              </span>
            </span>
          )}
          {editing !== c.id && (
            <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              {(!c.status || c.status === 'open') && <IconButton label={`Mark done: ${c.what}`} icon="check" size={24} onClick={() => act.run(c, { status: 'done' })} />}
              {editable && <IconButton label={`Edit: ${c.what}`} icon="edit" size={24} onClick={() => setEditing(c.id)} />}
              {(!c.status || c.status === 'open') && <IconButton label={`Dismiss: ${c.what}`} icon="close" size={24} onClick={() => act.run(c, { status: 'dismissed' })} />}
              {c.status && c.status !== 'open' && <Button size="sm" variant="ghost" onClick={() => act.run(c, { status: 'open' })}>{tr('contextParts.reopen', 'Reopen')}</Button>}
            </span>
          )}
        </div>
      ))}
      <ActionError error={act.error} onDismiss={act.clearError} />
    </div>
  );
}

function CommitmentEditor({ c, onSave, onCancel, busy }) {
  const [what, setWhat] = useState(c.what || '');
  const [due, setDue] = useState(c.due_at ? String(c.due_at).slice(0, 10) : '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ what, due_at: due ? new Date(due).toISOString() : null }); }}
      style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexGrow: 1 }}>
      <TextInput aria-label={tr('contextParts.commitment', 'Commitment')} value={what} onChange={(e) => setWhat(e.target.value)} style={{ flexGrow: 1, height: 30 }} />
      <TextInput aria-label={tr('contextParts.dueDate', 'Due date')} type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ height: 30 }} />
      <Button size="sm" variant="primary" type="submit" busy={busy}>{tr('contextParts.save', 'Save')}</Button>
      <Button size="sm" onClick={onCancel}>{tr('contextParts.cancel', 'Cancel')}</Button>
    </form>
  );
}

/** Facts as a two-column grid of key / mono value with pin, edit and dismiss. */
export function FactsGrid({ items, onChange, onRemove, editable = false, title = 'Facts' }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const act = useAction(async (f, patch) => {
    const updated = await patchFact(f.id, patch);
    if (patch.dismissed) onRemove?.(f);
    else onChange?.(updated || { ...f, ...patch });
    setEditing(null);
  });
  const list = items || [];
  if (!list.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {title && <SectionLabel>{title}</SectionLabel>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', gap: '4px 10px', fontSize: 12, alignItems: 'center' }}>
        {list.map((f) => (
          <FactRow key={f.id} f={f} editable={editable} editing={editing === f.id} draft={draft} setDraft={setDraft}
            onEdit={() => { setEditing(f.id); setDraft(String(f.value ?? '')); }}
            onCancel={() => setEditing(null)} onSave={() => act.run(f, { value: draft })}
            onPin={() => act.run(f, { pinned: !f.pinned })} onDismiss={() => act.run(f, { dismissed: true })} busy={act.busy} />
        ))}
      </div>
      <ActionError error={act.error} onDismiss={act.clearError} />
    </div>
  );
}

function FactRow({ f, editable, editing, draft, setDraft, onEdit, onCancel, onSave, onPin, onDismiss, busy }) {
  return (
    <>
      <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.key}>{f.key}</span>
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); onSave(); }} style={{ display: 'flex', gap: 4 }}>
          <TextInput aria-label={`Value for ${f.key}`} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ height: 26, fontSize: 12, flexGrow: 1 }} autoFocus />
          <Button size="sm" type="submit" busy={busy}>{tr('contextParts.save', 'Save')}</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>{tr('contextParts.cancel', 'Cancel')}</Button>
        </form>
      ) : (
        <span style={{ overflowWrap: 'anywhere' }}>
          {f.source_message_id
            ? <button type="button" onClick={() => openMessage(f.source_message_id)} title={tr('contextParts.openTheMessageThisCame', 'Open the message this came from')}
              style={{ border: 0, padding: 0, background: 'none', color: T.ink, font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>{String(f.value)}</button>
            : String(f.value)}
        </span>
      )}
      <span style={{ display: 'flex', gap: 0 }}>
        <IconButton label={f.pinned ? `Unpin ${f.key}` : `Pin ${f.key}`} icon="pin" size={22} active={f.pinned} onClick={onPin} />
        {editable && !editing && <IconButton label={`Edit ${f.key}`} icon="edit" size={22} onClick={onEdit} />}
        <IconButton label={`Dismiss ${f.key}`} icon="close" size={22} onClick={onDismiss} />
      </span>
    </>
  );
}

/** Replace an item by id in a list. */
export function replaceById(list, item) {
  if (!item?.id) return list;
  return (list || []).map((x) => (x.id === item.id ? { ...x, ...item } : x));
}

export function removeById(list, item) {
  return (list || []).filter((x) => x.id !== item?.id);
}

export function mergeById(...lists) {
  const seen = new Map();
  for (const l of lists) for (const x of l || []) if (x?.id && !seen.has(x.id)) seen.set(x.id, x);
  return [...seen.values()];
}
