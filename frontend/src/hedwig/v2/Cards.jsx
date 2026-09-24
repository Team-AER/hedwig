// Cards above a message in the thread (GET /cards/message/:id): each one a slip with its figure and
// caption ("Today" / "DHL, out for delivery"), the fields Hedwig read, each tappable to show the
// sentence it came from, an edit form (PATCH /cards/:id), Dismiss, and the card's actions from
// GET /cards/:id/actions (calendar download, a reminder through the work module, tracking, copy).
// The owner's verdicts teach Hedwig (backend cards/feedback.js): "Not a subscription" on a
// subscription (POST /cards/:id/not-recurring; also the Correct form's "Not recurring" cadence) and
// "Not a <kind>" in the card's menu (POST /cards/:id/not-kind) hide the card with an Undo toast
// whose Undo is POST /cards/:id/restore.
// A route that is not there, or a message with no cards, shows nothing.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { v2Api, listOf } from './client.js';
import { useV2 } from './state.js';
import { openThread } from './nav.js';
import {
  actionLabel, cardFields, cardFigure, downloadIcs, editPatch, fieldLabel, fieldSource, fieldText, fieldType, inputValue,
  reminderBody, safeUrl, statusLabel, cadenceLabel, notKindLabel, CARD_FIELDS, NOT_RECURRING,
} from './cards.js';
import { performAction } from './actions.js';
import { Btn, IconButton, LinkBtn, Slip, V, Why } from './primitives.jsx';
import { MenuButton } from '../shell/Menu.jsx';
import { Icon } from '../icons.jsx';
import { tv } from './i18n.js';

function notify(type, title, body) {
  useStore.getState().addNotification?.({ type, title, ...(body ? { body } : {}) });
}

async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    notify('success', tv('hedwig.v2.card.copied', 'Copied.'));
  } catch {
    notify('error', tv('hedwig.v2.card.copyFailed', 'Could not copy. Select the code and copy it yourself.'));
  }
}

/** The cards for one message; the thread renders this above the message. */
export function MessageCards({ messageId, phone = false }) {
  const [cards, setCards] = useState([]);
  useEffect(() => {
    let alive = true;
    setCards([]);
    if (!messageId) return undefined;
    v2Api.get(`/cards/message/${encodeURIComponent(messageId)}`)
      .then((d) => { if (alive) setCards(listOf(d, 'cards')); })
      .catch(() => { if (alive) setCards([]); });
    return () => { alive = false; };
  }, [messageId]);
  // Deadlines already have the thread's own slip; dismissed cards stay hidden.
  const shown = cards.filter((c) => !c.dismissedAt && c.kind !== 'deadline' && CARD_FIELDS[c.kind]);
  if (!shown.length) return null;
  const replace = (card) => setCards((list) => list.map((c) => (c.id === card.id ? card : c)));
  return (
    <section aria-label={tv('hedwig.v2.card.label', 'What Hedwig read from this message')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {shown.map((c) => <CardSlip key={c.id} card={c} messageId={messageId} phone={phone} onChange={replace} />)}
    </section>
  );
}

function useActions(cardId) {
  const [actions, setActions] = useState([]);
  useEffect(() => {
    let alive = true;
    v2Api.get(`/cards/${encodeURIComponent(cardId)}/actions`)
      .then((d) => { if (alive) setActions(listOf(d, 'actions')); })
      .catch(() => { if (alive) setActions([]); });
    return () => { alive = false; };
  }, [cardId]);
  return actions;
}

export function CardSlip({ card, messageId, phone = false, onChange }) {
  const work = useV2((s) => s.caps.work === true);
  const actions = useActions(card.id);
  const [openField, setOpenField] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const fig = cardFigure(card);
  const fields = cardFields(card);

  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(null); }
  }, []);

  const dismiss = () => run('dismiss', async () => {
    await v2Api.post(`/cards/${encodeURIComponent(card.id)}/dismiss`);
    onChange?.({ ...card, dismissedAt: new Date().toISOString() });
    notify('success', tv('hedwig.v2.card.dismissed', 'Card dismissed. Hedwig will not show it again.'));
  });

  // The owner telling Hedwig it read the wrong thing: the card goes at once, the toast has Undo.
  const verdict = (route, title) => {
    setEditing(false);
    setError(null);
    const id = encodeURIComponent(card.id);
    performAction({
      kind: 'custom',
      items: [{ messageId: messageId || card.messageId, cardId: card.id }],
      title,
      failTitle: tv('hedwig.v2.card.verdictFailed', 'Could not tell Hedwig. The card is back.'),
      run: () => v2Api.post(`/cards/${id}/${route}`),
      undo: () => v2Api.post(`/cards/${id}/restore`),
      onApply: () => onChange?.({ ...card, dismissedAt: new Date().toISOString() }),
      onRevert: () => onChange?.({ ...card, dismissedAt: null }),
    });
  };
  const notRecurring = () => verdict('not-recurring', tv('hedwig.v2.card.notRecurringDone', 'Not a subscription. Hedwig will not list {{merchant}} as one again.', { merchant: card.fields?.merchant || tv('hedwig.v2.card.thisMerchant', 'this merchant') }));
  const notKind = () => (card.kind === 'subscription'
    ? notRecurring()
    : verdict('not-kind', tv('hedwig.v2.card.notKindDone', '{{label}}. Hedwig will remember that for this sender.', { label: notKindLabel(card.kind) })));

  const doAction = (a) => run(a.id, async () => {
    if (a.id === 'calendar') { downloadIcs(a); return; }
    if (a.id === 'copy') { await copyText(a.text); return; }
    if (a.id === 'track') { const url = safeUrl(a.url); if (url) window.open(url, '_blank', 'noopener,noreferrer'); return; }
    if (a.id === 'reminder') {
      const body = reminderBody(a.reminder);
      if (!body) return;
      await v2Api.post('/work/lists/reminder', body);
      notify('success', tv('hedwig.v2.card.reminded', 'Reminder set for {{when}}.', { when: new Date(body.until).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }));
      window.dispatchEvent(new CustomEvent('hedwig:sort-changed', { detail: { reminder: true } }));
    }
  });
  // A reminder goes through the work module; without it the action is not offered.
  const shownActions = actions.filter((a) => (a.id === 'reminder' ? work : a.id !== 'track' || safeUrl(a.url)));

  const figure = fig.code
    ? (
      <button
        type="button"
        onClick={() => copyText(fig.figure)}
        aria-label={tv('hedwig.v2.card.copyCode', 'Copy the code {{code}}', { code: fig.figure })}
        title={tv('hedwig.v2.card.action.copy', 'Copy code')}
        style={{ padding: 0, border: 0, background: 'none', color: V.ink, cursor: 'copy', fontFamily: V.code, fontSize: 20, fontWeight: 600, letterSpacing: '0.08em', lineHeight: '24px', textAlign: 'left', minHeight: phone ? 44 : 28, userSelect: 'all' }}
      >
        {fig.figure}
      </button>
    )
    : <span style={{ fontSize: 17, fontWeight: 600, lineHeight: '22px', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fig.figure}</span>;

  return (
    <Slip style={{ gap: 8 }} aria-label={[fig.figure, fig.caption].filter(Boolean).join(' · ')}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        {figure}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 160px' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{fig.caption}</span>
          {fig.sub && <span style={{ fontSize: 12, color: V.muted }}>{fig.sub}</span>}
        </div>
      </div>
      {!editing && fields.length > 0 && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 16, rowGap: 0, alignItems: 'baseline', fontSize: 12 }}>
          {fields.map((k) => (
            <FieldRow key={k} card={card} field={k} phone={phone} open={openField === k} onToggle={() => setOpenField((f) => (f === k ? null : k))} messageId={messageId} />
          ))}
        </dl>
      )}
      {editing && <EditForm card={card} phone={phone} onCancel={() => setEditing(false)} onNotRecurring={notRecurring} onSaved={(c) => { onChange?.(c); setEditing(false); notify('success', tv('hedwig.v2.card.saved', 'Card corrected.')); }} />}
      {!editing && (
        <div style={{ display: 'flex', gap: phone ? 4 : 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {shownActions.map((a) => (
            <LinkBtn key={a.id} hit={phone} disabled={Boolean(busy)} onClick={() => doAction(a)} style={{ fontSize: 12, color: V.accentInk, textDecoration: 'none', ...(phone ? { minHeight: 44, padding: '0 8px 0 0' } : {}) }}>{actionLabel(a)}</LinkBtn>
          ))}
          <span style={{ flexGrow: 1 }} />
          <span style={{ display: 'inline-flex', gap: phone ? 0 : 12, marginRight: phone ? -10 : -4 }}>
            <IconButton icon="pencil" data-card-correct="" label={tv('hedwig.v2.card.edit', 'Correct')} size={phone ? 44 : 28} disabled={Boolean(busy)} onClick={() => setEditing(true)} style={{ color: V.muted }} />
            {card.kind === 'subscription' && (
              <IconButton icon="ban" data-card-not-recurring="" label={tv('hedwig.v2.card.notRecurring', 'Not a subscription')} size={phone ? 44 : 28} disabled={Boolean(busy)} onClick={notRecurring} style={{ color: V.muted }} />
            )}
            <IconButton icon="x" data-card-dismiss="" label={tv('hedwig.v2.card.dismiss', 'Dismiss')} size={phone ? 44 : 28} disabled={Boolean(busy)} onClick={dismiss} style={{ color: V.muted }} />
            <MenuButton
              label={tv('hedwig.v2.card.more', 'More for this card')}
              align="right"
              width={220}
              buttonClassName="hw-icon-btn"
              sheet={phone}
              buttonStyle={{ width: phone ? 44 : 28, height: phone ? 44 : 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.muted, cursor: 'pointer' }}
              items={() => [
                { id: 'not-kind', label: notKindLabel(card.kind), icon: 'ban', description: tv('hedwig.v2.card.notKindHint', 'Hedwig will not read mail from this sender as this kind again.'), onSelect: notKind },
              ]}
            >
              <Icon name="ellipsis" size={phone ? 20 : 16} />
            </MenuButton>
          </span>
        </div>
      )}
      {error && <span role="alert" style={{ fontSize: 12, color: V.red }}>{error.message || String(error)}</span>}
    </Slip>
  );
}

function FieldRow({ card, field, phone, open, onToggle, messageId }) {
  const src = fieldSource(card, field);
  const value = fieldText(card, field);
  return (
    <>
      <dt style={{ fontSize: 12, color: V.muted, alignSelf: 'start', paddingTop: phone ? 14 : 3 }}>{fieldLabel(field)}</dt>
      <dd style={{ margin: 0, minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title={tv('hedwig.v2.card.whereFrom', 'Where Hedwig read this')}
          className="hw-link"
          style={{ padding: 0, border: 0, background: 'none', color: V.ink, font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer', textDecorationColor: 'transparent', minHeight: phone ? 44 : 20, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums', fontFamily: field === 'code' || field === 'trackingNumber' || field === 'reference' ? V.code : 'inherit' }}
        >
          {value}
        </button>
        {open && (
          <div style={{ padding: '2px 0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {src?.edited && (
              <Why>
                {src.before != null && src.before !== ''
                  ? tv('hedwig.v2.card.youChanged', 'You changed this from {{before}}.', { before: String(src.before) })
                  : tv('hedwig.v2.card.youSet', 'You set this yourself.')}
              </Why>
            )}
            {src?.quote && <Why tone="ink">“{src.quote}”</Why>}
            {src?.attachment && <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.card.inAttachment', 'In the attachment {{name}}', { name: src.attachment })}</span>}
            {src?.messageId && src.messageId !== messageId && (
              <LinkBtn hit={phone} style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => openThread({ messageId: src.messageId })}>{tv('hedwig.v2.card.openSource', 'Open the message it came from')}</LinkBtn>
            )}
            {!src && <Why>{tv('hedwig.v2.card.noSource', 'Hedwig kept no sentence for this field.')}</Why>}
          </div>
        )}
      </dd>
    </>
  );
}

function EditForm({ card, phone, onCancel, onSaved, onNotRecurring }) {
  const keys = CARD_FIELDS[card.kind] || [];
  const [draft, setDraft] = useState(() => Object.fromEntries(keys.map((k) => [k, inputValue(card, k)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    const patch = editPatch(card, draft);
    if (!patch) { onCancel(); return; }
    if (patch.notRecurring) { onNotRecurring?.(); return; }
    setSaving(true);
    setError(null);
    try {
      const out = await v2Api.patch(`/cards/${encodeURIComponent(card.id)}`, patch);
      onSaved(out && out.id ? out : { ...card, fields: { ...card.fields, ...patch.fields } });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  const inputStyle = { width: '100%', boxSizing: 'border-box', height: phone ? 44 : 28, border: `1px solid ${V.line}`, background: V.content, font: 'inherit', fontSize: 13, color: V.ink, outline: 'none', borderRadius: 6, padding: '0 8px' };
  return (
    <form onSubmit={save} aria-label={tv('hedwig.v2.card.editLabel', 'Correct this card')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: phone ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(180px, 1fr))', gap: phone ? 6 : 12 }}>
        {keys.map((k) => {
          const t = fieldType(card.kind, k);
          const id = `card-${card.id}-${k}`;
          const set = (v) => setDraft((d) => ({ ...d, [k]: v }));
          return (
            <label key={k} htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: V.muted }}>
              {fieldLabel(k)}
              {t.type === 'enum'
                ? (
                  <select id={id} value={draft[k]} onChange={(e) => set(e.target.value)} style={inputStyle}>
                    <option value="">{tv('hedwig.v2.card.none', 'Not set')}</option>
                    {t.options.map((o) => <option key={o} value={o}>{k === 'cadence' ? cadenceLabel(o) : statusLabel(o)}</option>)}
                    {card.kind === 'subscription' && k === 'cadence' && <option value={NOT_RECURRING}>{cadenceLabel(NOT_RECURRING)}</option>}
                  </select>
                )
                : (
                  <input
                    id={id}
                    type={t.type === 'date' ? 'date' : t.type === 'datetime' ? 'datetime-local' : 'text'}
                    inputMode={t.type === 'number' ? 'decimal' : undefined}
                    value={draft[k]}
                    onChange={(e) => set(e.target.value)}
                    style={{ ...inputStyle, fontFamily: k === 'code' || k === 'currency' ? V.code : 'inherit' }}
                  />
                )}
            </label>
          );
        })}
      </div>
      {error && <span role="alert" style={{ fontSize: 12, color: V.red }}>{error.message || String(error)}</span>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Btn accent type="submit" size={phone ? 'lg' : 'md'} disabled={saving}>{saving ? tv('hedwig.v2.saving', 'Saving…') : tv('hedwig.v2.card.save', 'Save')}</Btn>
        <LinkBtn muted hit={phone} onClick={onCancel}>{tv('hedwig.v2.action.cancel', 'Cancel')}</LinkBtn>
      </div>
      <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.card.editNote', 'Your corrections win over what Hedwig reads later.')}</span>
    </form>
  );
}
