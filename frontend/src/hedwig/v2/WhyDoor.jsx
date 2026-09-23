// The why → door. Every reason line Hedwig shows opens this small sheet: which layer decided
// (rule, classifier, Reflex, Reasoning, you), how sure it was, the signals, the rule or the
// prompt and model, and "Change this" with its four scopes (just this one, always for this
// sender, this list, this kind) → POST /sort/correct.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/index.js';
import { v2Api, announceSortChange } from './client.js';
import { Btn, Hair, LinkBtn, Mono, Pick, Sheet, V, Why, usePhone } from './primitives.jsx';
import { tv } from './i18n.js';

const LAYERS = {
  rule: () => tv('hedwig.v2.why.layer.rule', 'A rule'),
  classifier: () => tv('hedwig.v2.why.layer.classifier', 'Your history'),
  reflex: () => tv('hedwig.v2.why.layer.reflex', 'Reflex model'),
  reasoning: () => tv('hedwig.v2.why.layer.reasoning', 'Reasoning model'),
  user: () => tv('hedwig.v2.why.layer.user', 'You'),
};

export function streamOptions() {
  return [
    { id: 'people', label: tv('hedwig.v2.stream.people', 'People') },
    { id: 'reading', label: tv('hedwig.v2.stream.reading', 'Reading') },
    { id: 'records', label: tv('hedwig.v2.stream.records', 'Records') },
  ];
}

/**
 * Whether the message came through a mailing list (a List-Id). The why record says so directly:
 * `senderScope` is the scope of the key the message is grouped under, 'list' when it has a
 * List-Id. Personal mail has none, and "Everything from this list" is not offered for it.
 * A server older than that field is read the old way (the list-scoped sender decision, or the
 * List-Id form of the sorter's signal).
 */
export function hasListKey(d) {
  if (!d || typeof d !== 'object') return false;
  if ('senderScope' in d) return d.senderScope === 'list';
  if (d.listId || d.list) return true;
  if (d.senderDecision?.scope === 'list') return true;
  // The sorter's 'list' signal also fires for bulk headers without a List-Id ("Mailing list or
  // bulk headers …"); only the List-Id form ("Mailing list <id>") counts.
  return (Array.isArray(d.signals) ? d.signals : []).some((s) => s && typeof s === 'object'
    && (s.name === 'list-id' || s.name === 'listId' || (s.name === 'list' && !/bulk|unsubscribe|precedence/i.test(String(s.label || '')))));
}

export function scopeOptions(why) {
  return [
    { id: 'one', label: tv('hedwig.v2.why.scope.one', 'Just this one') },
    { id: 'sender', label: tv('hedwig.v2.why.scope.sender', 'Always for this sender') },
    ...(hasListKey(why) ? [{ id: 'list', label: tv('hedwig.v2.why.scope.list', 'Everything from this list') }] : []),
    { id: 'kind', label: tv('hedwig.v2.why.scope.kind', 'All mail of this kind') },
  ];
}

/** Hook: `open(item, anchorEl)` shows the door for a stream item; render `element` once. */
export function useWhyDoor() {
  const [state, setState] = useState(null); // { item, anchor, key }
  const open = useCallback((item, anchor) => {
    if (!item?.messageId) return;
    setState({ item, anchor: anchor || null, key: `${item.messageId}-${Date.now()}` });
  }, []);
  const close = useCallback(() => {
    setState((s) => {
      const a = s?.anchor;
      if (a && document.contains(a)) requestAnimationFrame(() => a.focus?.({ preventScroll: true }));
      return null;
    });
  }, []);
  const element = state ? <WhyDoor key={state.key} item={state.item} anchor={state.anchor} onClose={close} /> : null;
  return { open, close, element };
}

export function WhyDoor({ item, anchor, onClose }) {
  const phone = usePhone()?.phone;
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [why, setWhy] = useState({ data: null, error: null, loading: true });
  const [changing, setChanging] = useState(false);
  const [stream, setStream] = useState(item.stream || 'people');
  const [needsYou, setNeedsYou] = useState(item.needsYou ? 'yes' : 'no');
  const [scope, setScope] = useState('one');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let alive = true;
    v2Api.get(`/sort/message/${encodeURIComponent(item.messageId)}/why`)
      .then((data) => {
        if (!alive) return;
        setWhy({ data, error: null, loading: false });
        // Start the change form from where it actually is now.
        if (['people', 'reading', 'records'].includes(data?.stream)) setStream(data.stream);
        if (typeof data?.needsYou === 'boolean') setNeedsYou(data.needsYou ? 'yes' : 'no');
      })
      .catch((error) => { if (alive) setWhy({ data: null, error, loading: false }); });
    return () => { alive = false; };
  }, [item.messageId]);

  useLayoutEffect(() => {
    if (phone || !anchor) { setPos(null); return; }
    const r = anchor.getBoundingClientRect();
    const width = 380;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const below = window.innerHeight - r.bottom;
    const top = below > 360 ? r.bottom + 8 : Math.max(12, r.top - 8 - Math.min(460, window.innerHeight - 24));
    setPos({ top, left, width });
  }, [anchor, phone]);

  useEffect(() => {
    const el = ref.current;
    requestAnimationFrame(() => el?.querySelector('button, [tabindex]')?.focus({ preventScroll: true }));
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); } };
    const onDown = (e) => {
      if (el && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) {
        // A tap on the phone backdrop closes the door and goes no further (not to the tab bar).
        if (e.target?.hasAttribute?.('data-why-backdrop')) e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, anchor]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const always = scope === 'one' ? null : scope;
      await v2Api.post('/sort/correct', { messageId: item.messageId, stream, needsYou: needsYou === 'yes', always });
      announceSortChange({ messageId: item.messageId, stream, needsYou: needsYou === 'yes', always });
      useStore.getState().addNotification?.({
        type: 'success',
        title: always ? tv('hedwig.v2.why.savedAlways', 'Changed. Hedwig will do the same next time.') : tv('hedwig.v2.why.saved', 'Changed for this message.'),
      });
      onClose();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const d = why.data;
  const layer = d?.layer ? (LAYERS[d.layer]?.() || d.layer) : null;
  const conf = typeof d?.confidence === 'number' ? Math.round(d.confidence * 100) : null;
  const title = tv('hedwig.v2.why.title', 'Why Hedwig put it here');

  const body = (
    <Sheet
      as="div"
      ref={ref}
      role="dialog"
      aria-modal={phone ? 'true' : 'false'}
      aria-label={title}
      phone={phone}
      radius={phone ? 28 : 20}
      className="hw-v2"
      style={{
        // A floating sheet sits over busy content, so its glass is nearly opaque.
        // On a phone it also covers the floating tab bar, which must not show through.
        '--hw-glass': `color-mix(in srgb, var(--hw-paper) ${phone ? 97 : 90}%, transparent)`,
        boxShadow: '0 30px 80px -30px var(--hw-shadow-color)',
        position: 'fixed', zIndex: 9500, display: 'flex', flexDirection: 'column', gap: 12, padding: phone ? '20px 20px calc(24px + env(safe-area-inset-bottom, 0px))' : '18px 20px 18px',
        maxHeight: phone ? '80vh' : 'min(560px, calc(100vh - 24px))', overflowY: 'auto', fontFamily: V.sans, fontSize: 14,
        animation: 'hw-pop-in var(--motion-fast, 120ms) var(--ease-standard, ease) both',
        ...(phone ? { left: 0, right: 0, bottom: 0, borderRadius: '28px 28px 0 0', borderBottom: 0 } : pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: '20vh', left: 'calc(50% - 190px)', width: 380 }),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: V.serif, fontSize: 22, lineHeight: 1.1, flexGrow: 1 }}>{title}</span>
        <LinkBtn muted hit={phone} onClick={onClose}>{tv('hedwig.v2.action.close', 'Close')}</LinkBtn>
      </div>
      {why.loading && <span style={{ color: V.muted, fontSize: 13 }}>{tv('hedwig.v2.loading', 'Loading…')}</span>}
      {why.error && (
        <span role="alert" style={{ color: V.muted, fontSize: 13 }}>
          {why.error.status === 404 ? tv('hedwig.v2.why.none', 'Hedwig has no record of how this was sorted yet.') : (why.error.message || String(why.error))}
        </span>
      )}
      {d && (
        <>
          <Why tone="ink" size={19}>{d.reason || item.reason}</Why>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 13, color: V.muted }}>
            {layer && <span>{tv('hedwig.v2.why.decidedBy', 'Decided by {{layer}}', { layer })}</span>}
            {conf != null && <Mono size={12}>{tv('hedwig.v2.why.confidence', '{{n}}% sure', { n: conf })}</Mono>}
          </div>
          {Array.isArray(d.signals) && d.signals.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {d.signals.map((s, i) => (
                <div key={i} style={{ padding: '8px 0', borderTop: `1px solid ${V.line}`, fontSize: 14 }}>{typeof s === 'string' ? s : (s.label || s.name || JSON.stringify(s))}</div>
              ))}
            </div>
          )}
          {d.rule && (
            <div style={{ fontSize: 13 }}>
              <span style={{ color: V.muted }}>{tv('hedwig.v2.why.rule', 'Rule')} </span>
              {typeof d.rule === 'string' ? d.rule : (d.rule.name || d.rule.id)}
            </div>
          )}
          {(d.promptId || d.model) && (
            <Mono size={11} style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
              {[d.promptId && `${d.promptId}${d.promptVersion ? `@${d.promptVersion}` : ''}`, d.model].filter(Boolean).join(' · ')}
            </Mono>
          )}
        </>
      )}
      <Hair />
      {!changing ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Btn solid onClick={() => setChanging(true)}>{tv('hedwig.v2.why.change', 'Change this')}</Btn>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Why>{tv('hedwig.v2.why.moveTo', 'Where it belongs')}</Why>
          <Pick label={tv('hedwig.v2.why.moveTo', 'Where it belongs')} options={streamOptions()} value={stream} onChange={setStream} size={phone ? 44 : 36} />
          <Pick
            label={tv('hedwig.v2.why.needsYouLabel', 'Does it need you?')}
            options={[{ id: 'yes', label: tv('hedwig.v2.why.needsMe', 'Needs me') }, { id: 'no', label: tv('hedwig.v2.why.notMe', 'Doesn’t need me') }]}
            value={needsYou}
            onChange={setNeedsYou}
            size={phone ? 44 : 36}
          />
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            <legend style={{ padding: 0, marginBottom: 4 }}><Why>{tv('hedwig.v2.why.scopeLabel', 'Remember it for')}</Why></legend>
            {scopeOptions(why.data).map((o) => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: phone ? 44 : 34, borderTop: `1px solid ${V.line}`, cursor: 'pointer', fontSize: 14 }}>
                <input type="radio" name={`why-scope-${item.messageId}`} value={o.id} checked={scope === o.id} onChange={() => setScope(o.id)} style={{ accentColor: 'var(--hw-accent)' }} />
                {o.label}
              </label>
            ))}
          </fieldset>
          {saveError && <span role="alert" style={{ color: V.red, fontSize: 13 }}>{saveError.message || String(saveError)}</span>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Btn solid disabled={saving} onClick={save}>{saving ? tv('hedwig.v2.saving', 'Saving…') : tv('hedwig.v2.why.apply', 'Change it')}</Btn>
            <LinkBtn muted hit={phone} onClick={() => setChanging(false)}>{tv('hedwig.v2.action.cancel', 'Cancel')}</LinkBtn>
          </div>
        </div>
      )}
    </Sheet>
  );
  // On a phone the door is a bottom sheet; a backdrop dims everything behind it, the floating tab
  // bar included, so nothing under it looks tappable.
  return createPortal(
    phone
      ? (
        <>
          <div data-why-backdrop="" aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 9400, background: 'color-mix(in srgb, var(--hw-ink) 28%, transparent)', animation: 'hw-fade-in var(--motion-fast, 120ms) ease both' }} />
          {body}
        </>
      )
      : body,
    document.body,
  );
}
