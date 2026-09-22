// Agent automations: scheduled prompts with a tool allow-list. Lives inside hedwig.agent.
import { useId, useState } from 'react';
import { hedwigApi } from '../api.js';
import { WEEKDAY_NAMES, buildSchedule, describeSchedule, formatAgo, parseSchedule } from './helpers.js';
import { useAction, useResource } from './hooks.js';
import {
  ActionError, Button, Card, Checkbox, Chip, Empty, IconButton, Loading, SectionLabel, Select, StateView, T, TextArea, TextInput,
} from './ui.jsx';
import { tr } from './i18n.js';

const EMPTY = { name: '', prompt: '', schedule: 'weekdays@08:00', allowed_tools: [], deliver: 'insight', enabled: true };

export default function Automations({ onOpenRun }) {
  const list = useResource('/agent/automations');
  const templates = useResource('/agent/automations/templates');
  const [editing, setEditing] = useState(null); // automation draft (with id when editing)
  const [confirmDelete, setConfirmDelete] = useState(null);

  const patch = useAction(async (a, body) => {
    const updated = await hedwigApi.patch(`/agent/automations/${encodeURIComponent(a.id)}`, body);
    list.setData((d) => (d || []).map((x) => (x.id === a.id ? { ...x, ...(updated || body) } : x)));
  });
  const del = useAction(async (a) => {
    await hedwigApi.del(`/agent/automations/${encodeURIComponent(a.id)}`);
    list.setData((d) => (d || []).filter((x) => x.id !== a.id));
    setConfirmDelete(null);
  });
  const runNow = useAction(async (a) => {
    const out = await hedwigApi.post(`/agent/automations/${encodeURIComponent(a.id)}/run`);
    if (out?.runId) onOpenRun?.(out.runId);
  });

  if (editing) {
    return (
      <Editor initial={editing} onCancel={() => setEditing(null)}
        onSaved={(saved) => {
          list.setData((d) => {
            const rows = d || [];
            return rows.some((x) => x.id === saved.id) ? rows.map((x) => (x.id === saved.id ? saved : x)) : [...rows, saved];
          });
          setEditing(null);
          list.reload({ quiet: true });
        }} />
    );
  }

  const rows = list.data || [];
  return (
    <div style={{ flexGrow: 1, overflowY: 'auto', padding: '6px 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: T.muted, flexGrow: 1 }}>{tr('automations.automationsRunTheAgentOn', 'Automations run the agent on a schedule. Anything that changes mail still waits for your approval.')}</span>
        <Button variant="primary" size="sm" onClick={() => setEditing({ ...EMPTY })}>{tr('automations.newAutomation', 'New automation')}</Button>
      </div>
      <ActionError error={patch.error || del.error || runNow.error} onDismiss={() => { patch.clearError(); del.clearError(); runNow.clearError(); }} />
      {list.loading && !list.data && <Loading />}
      {list.error && !list.data && <StateView error={list.error} onRetry={list.reload} what="Automations" />}
      {list.data && !rows.length && <Empty title={tr('automations.noAutomationsYet', 'No automations yet')}>{tr('automations.startFromATemplateBelow', 'Start from a template below, or write your own.')}</Empty>}
      {rows.map((a) => (
        <Card key={a.id} style={{ gap: 6, opacity: a.enabled ? 1 : 0.75 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{a.name}</strong>
            <Chip tone={a.enabled ? 'teal' : 'neutral'}>{a.enabled ? describeSchedule(a.schedule) : 'paused'}</Chip>
            <span style={{ fontSize: 12, color: T.muted }}>delivers as {a.deliver === 'notification' ? 'a notification' : 'an insight'}</span>
            <span style={{ flexGrow: 1 }} />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={Boolean(a.enabled)} onChange={(e) => patch.run(a, { enabled: e.target.checked })} /> Enabled
            </label>
            <Button size="sm" busy={runNow.busy} onClick={() => runNow.run(a)}>{tr('automations.runNow', 'Run now')}</Button>
            <IconButton label={`Edit ${a.name}`} icon="edit" onClick={() => setEditing({ ...EMPTY, ...a })} />
            {confirmDelete === a.id
              ? <Button size="sm" variant="danger" busy={del.busy} onClick={() => del.run(a)}>{tr('automations.deleteForGood', 'Delete for good?')}</Button>
              : <IconButton label={`Delete ${a.name}`} icon="trash" onClick={() => setConfirmDelete(a.id)} />}
          </div>
          <div style={{ fontSize: 13, color: T.muted, whiteSpace: 'pre-wrap' }}>{a.prompt}</div>
          <div style={{ fontSize: 12, color: T.muted, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>last run {a.last_run_at ? formatAgo(a.last_run_at) : 'never'}</span>
            {a.enabled && a.next_run_at && <span>next {formatAgo(a.next_run_at)}</span>}
            {a.allowed_tools?.length > 0 && <span style={{ fontFamily: T.mono }}>{a.allowed_tools.join(' · ')}</span>}
          </div>
        </Card>
      ))}

      {templates.data?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>{tr('automations.templates', 'Templates')}</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {templates.data.map((t, i) => (
              <Card key={t.id || t.name || i} style={{ gap: 6 }}>
                <strong style={{ fontSize: 13 }}>{t.name}</strong>
                <span style={{ fontSize: 12, color: T.muted }}>{t.description || t.prompt}</span>
                <span style={{ fontSize: 12, color: T.muted }}>{describeSchedule(t.schedule)}</span>
                <div><Button size="sm" onClick={() => setEditing({ ...EMPTY, ...t, id: undefined })}>{tr('automations.useTemplate', 'Use template')}</Button></div>
              </Card>
            ))}
          </div>
        </div>
      )}
      {templates.error && templates.error.status !== 404 && <StateView error={templates.error} onRetry={templates.reload} what="Templates" compact />}
    </div>
  );
}

function Editor({ initial, onCancel, onSaved }) {
  const ids = { name: useId(), prompt: useId(), deliver: useId() };
  const [draft, setDraft] = useState(initial);
  const tools = useResource('/agent/tools');
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = useAction(async () => {
    const body = {
      name: draft.name.trim(), prompt: draft.prompt.trim(), schedule: draft.schedule,
      allowed_tools: draft.allowed_tools?.length ? draft.allowed_tools : undefined, deliver: draft.deliver, enabled: Boolean(draft.enabled),
    };
    const saved = draft.id
      ? await hedwigApi.patch(`/agent/automations/${encodeURIComponent(draft.id)}`, body)
      : await hedwigApi.post('/agent/automations', body);
    onSaved(saved || { ...draft, ...body });
  });
  const valid = draft.name.trim() && draft.prompt.trim() && draft.schedule;
  const toggleTool = (name, on) => set('allowed_tools', on ? [...new Set([...(draft.allowed_tools || []), name])] : (draft.allowed_tools || []).filter((t) => t !== name));

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) save.run(); }}
      style={{ flexGrow: 1, overflowY: 'auto', padding: '6px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{draft.id ? `Edit ${initial.name}` : 'New automation'}</h2>
      <Field label="Name" id={ids.name}><TextInput id={ids.name} value={draft.name} onChange={(e) => set('name', e.target.value)} required /></Field>
      <Field label="What should the agent do?" id={ids.prompt}>
        <TextArea id={ids.prompt} value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} rows={4} required
          placeholder={tr('automations.eGListInvoicesReceived', 'e.g. List invoices received since the last run with vendor, amount and due date.')} />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend style={{ fontSize: 12, color: T.muted, padding: 0, marginBottom: 6 }}>{tr('automations.when', 'When')}</legend>
        <ScheduleBuilder value={draft.schedule} onChange={(s) => set('schedule', s)} />
      </fieldset>
      <Field label="Deliver the result as" id={ids.deliver}>
        <Select id={ids.deliver} value={draft.deliver || 'insight'} onChange={(e) => set('deliver', e.target.value)} style={{ maxWidth: 240 }}>
          <option value="insight">{tr('automations.anInsightCard', 'An insight card')}</option>
          <option value="notification">{tr('automations.aNotification', 'A notification')}</option>
        </Select>
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend style={{ fontSize: 12, color: T.muted, padding: 0, marginBottom: 6 }}>Tools it may use (none selected = all read-only tools)</legend>
        {tools.loading && !tools.data && <Loading />}
        {tools.error && <StateView error={tools.error} onRetry={tools.reload} what="The tool list" compact />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
          {(tools.data || []).map((t) => (
            <Checkbox key={t.name} mono checked={(draft.allowed_tools || []).includes(t.name)} onChange={(on) => toggleTool(t.name, on)}
              label={t.name} sub={`${t.description || ''}${t.mutates ? ' · changes mail, asks first' : ''}${t.pluginId ? ` · ${t.pluginId}` : ''}`} />
          ))}
        </div>
      </fieldset>
      <Checkbox checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
      <ActionError error={save.error} onDismiss={save.clearError} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" type="submit" busy={save.busy} disabled={!valid}>{draft.id ? 'Save changes' : 'Create automation'}</Button>
        <Button onClick={onCancel}>{tr('automations.cancel', 'Cancel')}</Button>
      </div>
    </form>
  );
}

function Field({ label, id, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: T.muted }}>{label}</label>
      {children}
    </div>
  );
}

/** daily / weekdays / weekly / every N → the schedule strings API.md defines. */
export function ScheduleBuilder({ value, onChange }) {
  const parsed = parseSchedule(value);
  const [b, setB] = useState(() => ({ kind: 'weekdays', time: '08:00', day: 1, every: 30, unit: 'm', ...(parsed || {}) }));
  const [custom, setCustom] = useState(value && !parsed ? value : null);
  const update = (patch) => {
    const next = { ...b, ...patch };
    setB(next);
    const s = buildSchedule(next);
    if (s) onChange(s);
  };
  const built = buildSchedule(b);
  if (custom != null) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextInput aria-label={tr('automations.scheduleString', 'Schedule string')} value={custom} onChange={(e) => { setCustom(e.target.value); onChange(e.target.value); }} style={{ fontFamily: T.mono }} />
        <Button size="sm" onClick={() => { setCustom(null); onChange(buildSchedule(b)); }}>{tr('automations.useTheBuilder', 'Use the builder')}</Button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Select aria-label={tr('automations.repeat', 'Repeat')} value={b.kind} onChange={(e) => update({ kind: e.target.value })}>
        <option value="daily">{tr('automations.everyDay', 'Every day')}</option>
        <option value="weekdays">{tr('automations.weekdays', 'Weekdays')}</option>
        <option value="weekly">{tr('automations.onceAWeek', 'Once a week')}</option>
        <option value="every">{tr('automations.everyNMinutesHours', 'Every N minutes / hours')}</option>
      </Select>
      {b.kind === 'weekly' && (
        <Select aria-label="Day" value={b.day} onChange={(e) => update({ day: Number(e.target.value) })}>
          {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </Select>
      )}
      {b.kind !== 'every' ? (
        <TextInput aria-label={tr('automations.time', 'Time')} type="time" value={b.time} onChange={(e) => update({ time: e.target.value })} />
      ) : (
        <>
          <TextInput aria-label={tr('automations.every', 'Every')} type="number" min={1} value={b.every} onChange={(e) => update({ every: Number(e.target.value) })} style={{ width: 80 }} />
          <Select aria-label={tr('automations.unit', 'Unit')} value={b.unit} onChange={(e) => update({ unit: e.target.value })}>
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </Select>
        </>
      )}
      <span style={{ fontSize: 12, color: built ? T.muted : T.red }}>
        {built ? <><span style={{ fontFamily: T.mono }}>{built}</span> · {describeSchedule(built)} (your timezone)</> : b.kind === 'every' && b.unit === 'm' ? 'At least every 5 minutes' : 'Check the values'}
      </span>
    </div>
  );
}
