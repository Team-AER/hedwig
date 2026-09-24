// The why → door. Every reason line Hedwig shows opens this small sheet: which layer decided
// (rule, classifier, Reflex, Reasoning, you), how sure it was, the signals, the rule or the
// prompt and model, and "Change this" with its four scopes (just this one, always for this
// sender, this list, this kind) → POST /sort/correct.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/index.js';
import { v2Api, announceSortChange } from './client.js';
import { useV2 } from './state.js';
import { Btn, Hair, LinkBtn, Mono, Pick, Reason, Sheet, V, usePhone } from './primitives.jsx';
import { tv } from './i18n.js';

// Read inside "Decided by {{layer}}", so they are lower case mid-sentence.
const LAYERS = {
  rule: () => tv('hedwig.v2.why.layer.rule', 'a rule'),
  classifier: () => tv('hedwig.v2.why.layer.classifier', 'your history'),
  reflex: () => tv('hedwig.v2.why.layer.reflex', 'the Reflex model'),
  reasoning: () => tv('hedwig.v2.why.layer.reasoning', 'the Reasoning model'),
  user: () => tv('hedwig.v2.why.layer.user', 'you'),
};

/** The signals worth listing: as text, without blanks, repeats, or a repeat of the reason above them. */
export function whySignals(d, fallbackReason) {
  const reason = String(d?.reason || fallbackReason || '').trim().toLowerCase();
  const seen = new Set(reason ? [reason] : []);
  const out = [];
  for (const s of Array.isArray(d?.signals) ? d.signals : []) {
    const text = String(typeof s === 'string' ? s : (s?.label || s?.name || '')).trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

const SIGNAL_NAMES = {
  alwaysIn: () => tv('hedwig.v2.why.signal.alwaysIn', 'Always in'),
  listRule: () => tv('hedwig.v2.why.signal.listRule', 'List rule'),
};

/**
 * The signals for Power: { name, label, text, weight } each, in the order the sorter gave them,
 * with `alwaysIn` (you have written to them) and `listRule` (a List-Id sends it to Reading or
 * Records) named in words.
 */
export function powerSignals(d) {
  const out = [];
  for (const s of Array.isArray(d?.signals) ? d.signals : []) {
    if (!s) continue;
    if (typeof s === 'string') { out.push({ name: null, label: null, text: s, weight: null }); continue; }
    const name = typeof s.name === 'string' ? s.name : null;
    const text = String(s.label || s.name || '').trim();
    if (!text) continue;
    out.push({ name, label: name ? (SIGNAL_NAMES[name]?.() || name) : null, text, weight: typeof s.weight === 'number' && Number.isFinite(s.weight) ? s.weight : null });
  }
  return out;
}

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
    const width = 320;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const below = window.innerHeight - r.bottom;
    const top = below > 360 ? r.bottom + 8 : Math.max(12, r.top - 8 - Math.min(460, window.innerHeight - 24));
    // Never past the bottom of the window (the change form makes it taller), nor over the anchor.
    const maxHeight = Math.min(560, below > 360 ? window.innerHeight - top - 12 : Math.max(200, r.top - 8 - top));
    setPos({ top, left, width, maxHeight });
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
  const signals = whySignals(d, item.reason);
  const power = useV2((st) => st.prefs.powerMode);
  const detailed = power ? powerSignals(d) : [];
  const title = tv('hedwig.v2.why.title', 'Why Hedwig put it here');
  // A model wrote the decision (sparkles) or a rule, your history or you made it (info).
  const glyph = d?.layer === 'reflex' || d?.layer === 'reasoning' ? 'sparkles' : 'info';

  const body = (
    <Sheet
      as="div"
      ref={ref}
      role="dialog"
      aria-modal={phone ? 'true' : 'false'}
      aria-label={title}
      phone={phone}
      material="content"
      data-popover=""
      radius={phone ? 14 : 12}
      className="hw-v2"
      style={{
        // Opaque content material with the popover shadow (spec §f); on a phone a bottom sheet
        // that covers the tab bar.
        position: 'fixed', zIndex: 9500, display: 'flex', flexDirection: 'column', gap: 10, padding: phone ? '16px 16px calc(20px + env(safe-area-inset-bottom, 0px))' : '14px 16px 16px',
        maxHeight: phone ? '80vh' : (pos?.maxHeight || 'min(560px, calc(100vh - 24px))'), overflowY: 'auto', fontFamily: V.sans, fontSize: 13, lineHeight: 1.45,
        animation: 'hw-pop-in var(--motion-fast, 120ms) var(--ease-standard, ease) both',
        ...(phone ? { left: 0, right: 0, bottom: 0, borderRadius: '14px 14px 0 0' } : pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: '20vh', left: 'calc(50% - 160px)', width: 320 }),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: phone ? 44 : 24 }}>
        <span style={{ fontSize: 13, fontWeight: 600, lineHeight: '18px', flexGrow: 1 }}>{title}</span>
        <LinkBtn muted hit={phone} onClick={onClose} style={{ fontSize: 12 }}>{tv('hedwig.v2.action.close', 'Close')}</LinkBtn>
      </div>
      {why.loading && <span style={{ color: V.muted, fontSize: 12 }}>{tv('hedwig.v2.loading', 'Loading…')}</span>}
      {why.error && (
        <span role="alert" style={{ color: V.muted, fontSize: 12 }}>
          {why.error.status === 404 ? tv('hedwig.v2.why.none', 'Hedwig has no record of how this was sorted yet.') : (why.error.message || String(why.error))}
        </span>
      )}
      {d && (
        <>
          <Reason glyph={glyph} tone="ink" size={13} as="p" style={{ margin: 0, lineHeight: '19px' }}>{d.reason || item.reason}</Reason>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12, color: V.muted }}>
            {layer && <span>{tv('hedwig.v2.why.decidedBy', 'Decided by {{layer}}', { layer })}</span>}
            {conf != null && <Mono size={12}>{tv('hedwig.v2.why.confidence', '{{n}}% sure', { n: conf })}</Mono>}
          </div>
          {d.pending === 'reflex' && (
            <span data-pending="reflex"><Reason glyph="hourglass">{tv('hedwig.v2.why.pendingReflex', 'Waiting for Reflex: this is a first guess until the Reflex model has read it.')}</Reason></span>
          )}
          {!power && signals.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {signals.map((s) => (
                <div key={s} style={{ padding: '6px 0', borderTop: `1px solid ${V.line}`, fontSize: 12 }}>{s}</div>
              ))}
            </div>
          )}
          {power && detailed.length > 0 && (
            <div data-power-signals="" style={{ display: 'flex', flexDirection: 'column' }}>
              {detailed.map((s, i) => (
                <div key={`${s.name}-${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderTop: `1px solid ${V.line}`, fontSize: 12 }}>
                  <span style={{ flexGrow: 1, minWidth: 0 }}>{s.text}</span>
                  {s.label && <Mono size={11}>{s.label}</Mono>}
                  {s.weight != null && <Mono size={11} color={V.ink}>{s.weight.toFixed(2)}</Mono>}
                </div>
              ))}
            </div>
          )}
          {d.rule && (
            <div style={{ fontSize: 12 }}>
              <span style={{ color: V.muted }}>{tv('hedwig.v2.why.rule', 'Rule')} </span>
              {typeof d.rule === 'string' ? d.rule : (d.rule.name || d.rule.id)}
            </div>
          )}
          {(d.promptId || d.model || (power && d.engineVersion)) && (
            <Mono size={11} style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
              {[d.promptId && `${d.promptId}${d.promptVersion ? `@${d.promptVersion}` : ''}`, d.model, power && d.engineVersion ? tv('hedwig.v2.why.engine', 'engine {{v}}', { v: d.engineVersion }) : null].filter(Boolean).join(' · ')}
            </Mono>
          )}
        </>
      )}
      <Hair />
      {!changing ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Btn accent size={phone ? 'phone' : 'md'} onClick={() => setChanging(true)}>{tv('hedwig.v2.why.change', 'Change this')}</Btn>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Reason glyph={null}>{tv('hedwig.v2.why.moveTo', 'Where it belongs')}</Reason>
          <Pick label={tv('hedwig.v2.why.moveTo', 'Where it belongs')} options={streamOptions()} value={stream} onChange={setStream} size={phone ? 44 : 28} />
          <Pick
            label={tv('hedwig.v2.why.needsYouLabel', 'Does it need you?')}
            options={[{ id: 'yes', label: tv('hedwig.v2.why.needsMe', 'Needs me') }, { id: 'no', label: tv('hedwig.v2.why.notMe', 'Doesn’t need me') }]}
            value={needsYou}
            onChange={setNeedsYou}
            size={phone ? 44 : 28}
          />
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            <legend style={{ padding: 0, marginBottom: 4 }}><Reason glyph={null}>{tv('hedwig.v2.why.scopeLabel', 'Remember it for')}</Reason></legend>
            {scopeOptions(why.data).map((o) => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: phone ? 44 : 28, borderTop: `1px solid ${V.line}`, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name={`why-scope-${item.messageId}`} value={o.id} checked={scope === o.id} onChange={() => setScope(o.id)} style={{ accentColor: 'var(--hw-accent)' }} />
                {o.label}
              </label>
            ))}
          </fieldset>
          {saveError && <span role="alert" style={{ color: V.red, fontSize: 12 }}>{saveError.message || String(saveError)}</span>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Btn accent size={phone ? 'phone' : 'md'} disabled={saving} onClick={save}>{saving ? tv('hedwig.v2.saving', 'Saving…') : tv('hedwig.v2.why.apply', 'Change it')}</Btn>
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
