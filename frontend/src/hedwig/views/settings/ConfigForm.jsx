// A form rendered from Hedwig config field descriptions (GET /settings or /admin/config):
// [{ key, type, value, default, group, label, help, options, min, max, source, env, scope }].
import { useId, useMemo, useState } from 'react';
import { buildConfigPatch, groupFields, groupTitle, isModelField } from '../helpers.js';
import { useAction } from '../hooks.js';
import { ActionError, Button, Chip, SectionLabel, Select, T, TextArea, TextInput } from '../ui.jsx';
import { tr } from '../i18n.js';

const SOURCE_TONE = { default: 'neutral', env: 'teal', admin: 'amber', user: 'amber' };

/**
 * fields: the field descriptions. onSave(patch) persists and resolves to the new field list.
 * resettable: the source a reset clears ('admin' for the admin form, 'user' for personal).
 * catalog: [{ id, display_name, status, reasoning_efforts }] for model pickers.
 * grouped: render group headings.
 */
export default function ConfigForm({ fields, onSave, resettable = 'user', catalog, showEnv = false, grouped = true, keyLabel = false }) {
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  const datalistId = useId();
  const save = useAction(async () => {
    const { patch, errors: errs } = buildConfigPatch(fields, draft);
    setErrors(errs);
    if (Object.keys(errs).length || !Object.keys(patch).length) return;
    await onSave(patch);
    setDraft({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  });
  const groups = useMemo(() => (grouped ? groupFields(fields) : [{ group: null, fields }]), [fields, grouped]);
  const dirty = Object.keys(draft).length > 0;
  const set = (key, v) => {
    setDraft((d) => {
      const next = { ...d };
      if (v === undefined) delete next[key]; else next[key] = v;
      return next;
    });
    setSaved(false);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.run(); }} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {catalog?.length > 0 && (
        <datalist id={datalistId}>
          {catalog.map((m) => <option key={m.id} value={m.id}>{m.display_name && m.display_name !== m.id ? m.display_name : undefined}</option>)}
        </datalist>
      )}
      {groups.map(({ group, fields: list }) => (
        <div key={group || 'all'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {group && <SectionLabel>{groupTitle(group)}</SectionLabel>}
          {list.map((f) => (
            <FieldRow key={f.key} field={f} value={f.key in draft ? draft[f.key] : undefined} onChange={(v) => set(f.key, v)}
              error={errors[f.key]} resettable={resettable} showEnv={showEnv} keyLabel={keyLabel}
              datalist={isModelField(f) && catalog?.length ? datalistId : undefined} catalog={catalog} />
          ))}
        </div>
      ))}
      <ActionError error={save.error} onDismiss={save.clearError} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', position: 'sticky', bottom: 0, zIndex: 1, background: T.surface, borderTop: `1px solid ${T.border}`, padding: '10px 0' }}>
        <Button variant="primary" type="submit" disabled={!dirty} busy={save.busy}>{tr('configForm.saveChanges', 'Save changes')}</Button>
        {dirty && <Button onClick={() => { setDraft({}); setErrors({}); }}>{tr('configForm.discard', 'Discard')}</Button>}
        {saved && <span role="status" style={{ fontSize: 12, color: T.teal }}>{tr('configForm.saved', 'Saved')}</span>}
      </div>
    </form>
  );
}

function FieldRow({ field: f, value, onChange, error, resettable, showEnv, datalist, catalog, keyLabel }) {
  const id = useId();
  const pending = value !== undefined;
  const cleared = value === null;
  const current = pending && !cleared ? value : displayValue(f);
  const model = datalist ? catalog?.find((m) => m.id === current) : null;
  const canReset = f.source === resettable && !cleared;
  let input;
  if (f.type === 'boolean') {
    input = (
      <input id={id} type="checkbox" checked={Boolean(current)} onChange={(e) => onChange(e.target.checked)} disabled={cleared}
        style={{ width: 16, height: 16, accentColor: 'var(--hw-accent, #007AFF)' }} />
    );
  } else if (f.type === 'enum') {
    input = (
      <Select id={id} value={current ?? ''} onChange={(e) => onChange(e.target.value)} disabled={cleared} style={{ maxWidth: 260 }}>
        {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
  } else if (f.type === 'number') {
    input = <TextInput id={id} type="number" value={current ?? ''} min={f.min} max={f.max} step="any" onChange={(e) => onChange(e.target.value)} disabled={cleared} style={{ width: 140, fontVariantNumeric: 'tabular-nums' }} />;
  } else if (f.type === 'json') {
    input = <TextArea id={id} value={current ?? ''} onChange={(e) => onChange(e.target.value)} disabled={cleared} rows={3} style={{ fontFamily: T.mono, fontSize: 12 }} />;
  } else if (f.type === 'secret') {
    input = <TextInput id={id} type="password" autoComplete="new-password" value={current ?? ''} placeholder={f.value ? 'set · type to replace' : 'not set'}
      onChange={(e) => onChange(e.target.value)} disabled={cleared} style={{ maxWidth: 360 }} />;
  } else {
    input = <TextInput id={id} value={current ?? ''} list={datalist} onChange={(e) => onChange(e.target.value)} disabled={cleared} style={{ maxWidth: 420, fontFamily: datalist ? T.mono : undefined }} />;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.4fr)', gap: '4px 16px', alignItems: 'start', padding: '6px 0', borderTop: `1px solid ${T.line}` }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <label htmlFor={id} style={{ fontSize: 13, fontWeight: 500 }}>{f.label || f.key}</label>
        {f.help && <span style={{ fontSize: 12, color: T.muted }}>{f.help}</span>}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: T.muted }}>
          {keyLabel && <span style={{ fontFamily: T.mono }}>{f.key}</span>}
          {f.source && <Chip tone={SOURCE_TONE[f.source] || 'neutral'}>{f.source}</Chip>}
          {showEnv && f.env && <span style={{ fontFamily: T.mono }} title={tr('configForm.environmentVariable', 'Environment variable')}>{f.env}</span>}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {input}
          {canReset && <Button size="sm" variant="ghost" onClick={() => onChange(null)} title={tr('configForm.removeThisOverride', 'Remove this override')}>{tr('configForm.reset', 'Reset')}</Button>}
          {cleared && <><span style={{ fontSize: 12, color: T.muted }}>{tr('configForm.resetsOnSave', 'resets on save')}</span><Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>{tr('configForm.undo', 'Undo')}</Button></>}
        </div>
        {model?.reasoning_efforts && <span style={{ fontSize: 11, color: T.muted }}>reasoning: {model.reasoning_efforts.join(' · ')}{model.status && model.status !== 'ready' ? ` · ${model.status}` : ''}</span>}
        {f.default !== undefined && f.type !== 'secret' && <span style={{ fontSize: 11, color: T.muted }}>default {fmtDefault(f.default)}</span>}
        {error && <span role="alert" style={{ fontSize: 12, color: T.red }}>{error}</span>}
      </div>
    </div>
  );
}

function displayValue(f) {
  if (f.type === 'json') return JSON.stringify(f.value ?? null, null, 2);
  if (f.type === 'secret') return '';
  return f.value;
}

function fmtDefault(v) {
  if (v === '' || v == null) return '(empty)';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v);
}
