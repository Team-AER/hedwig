// Settings → Hedwig, the v2 part. The Power mode switch (the rail no longer carries it), then
// Simple: five switches and the look (a blue-family accent, blur, light or dark, dark mode for
// mail). Power adds the rules list with dry-run (/sort/rules), the model routing table (read-only
// unless admin), prompt versions (admin) and index status (/index/status). Section headers are the 11px/600
// SectionLabel, rows 13px, fields radius 8 on --hw-field; mono only for model and prompt ids.
import { useState } from 'react';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { useIsAdmin } from '../views/hooks.js';
import { DEFAULT_ACCENT } from '../theme/tokens.js';
import { useV2, UI_DEFAULTS } from './state.js';
import { v2Api, listOf, isMockMode } from './client.js';
import { useV2Resource } from './hooks.js';
import { nextScheme, schemeLabel } from './Rail.jsx';
import { Code, ErrorLine, Hair, IconButton, LinkBtn, Mono, Quiet, SectionLabel, V, Why } from './primitives.jsx';
import { listTime, percent } from './format.js';
import { tv } from './i18n.js';
import { tierLabel } from './tiers.js';
import { TierNote } from './TierNote.jsx';
import { tierChoiceLabel } from '../views/settings/RoutingSettings.jsx';
import { normaliseMailDark } from '../../utils/mailDarkMode.js';

// Blue-family accents only (spec §e): orange means attention now. System blue first (the default).
const ACCENTS = ['#007AFF', '#0B5FCC', '#3B5A8A', '#5856D6'];

// The five Simple controls. `ui.*` keys are this stream's; sort.* / spam.* come from sorting (C).
// Bundle delivery is per bundle in C (a schedule on each, PATCH /sort/bundles/:id), so that row
// opens the bundles and their times instead of being one on/off switch.
export function simpleSwitches() {
  return [
    { key: 'sort.autoScreen', label: tv('hedwig.v2.settings.autoScreen', 'Screen new senders for me'), help: tv('hedwig.v2.settings.autoScreenHelp', 'Hedwig decides when it is sure, and every decision can be undone.') },
    { key: 'bundles', label: tv('hedwig.v2.settings.bundleTimes', 'Bundle delivery times'), help: tv('hedwig.v2.settings.bundleTimesHelp', 'Bundled mail can arrive together at set times instead of one by one.') },
    { key: 'ui.notifications', label: tv('hedwig.v2.settings.notifications', 'Tell me when something needs me'), help: tv('hedwig.v2.settings.notificationsHelp', 'Only for People mail Hedwig thinks needs you.') },
    { key: 'spam.autoMove', label: tv('hedwig.v2.settings.autoSpam', 'Move spam out of the way'), help: tv('hedwig.v2.settings.autoSpamHelp', 'Confident spam goes to the Junk folder. Hedwig never deletes mail.') },
    { key: 'ui.helpMeWrite', label: tv('hedwig.v2.settings.helpWrite', 'Help me write'), help: tv('hedwig.v2.settings.helpWriteHelp', 'Quick replies and drafts in your voice under each thread.') },
  ];
}

function Switch({ checked, onChange, label, help, disabled, note, title, ...rest }) {
  return (
    <label title={title} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}`, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        {help && <span style={{ fontSize: 12, color: V.muted }}>{help}</span>}
        {note && <Why>{note}</Why>}
      </span>
      <input type="checkbox" role="switch" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} {...rest} style={{ width: 16, height: 16, marginTop: 1, accentColor: 'var(--hw-accent)', flexShrink: 0 }} />
    </label>
  );
}

function Section({ title, children, right }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <SectionLabel as="h2" style={{ padding: '0 0 2px' }}>{title}</SectionLabel>
        <span style={{ flexGrow: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

function SimpleSection() {
  const fields = useV2((s) => s.settingsFields);
  const prefs = useV2((s) => s.prefs);
  const [error, setError] = useState(null);
  const byKey = new Map((fields || []).map((f) => [f.key, f]));

  const save = async (key, value) => {
    setError(null);
    if (key.startsWith('ui.')) { await useV2.getState().setPref(key.slice(3), value); return; }
    try {
      const next = await hedwigApi.patch('/settings', { [key]: value });
      useV2.getState().setSettingsFields(next);
    } catch (e) { setError(e); }
  };

  return (
    <Section title={tv('hedwig.v2.settings.simple', 'Hedwig for you')}>
      {simpleSwitches().map((s) => {
        if (s.key === 'bundles') return <BundleTimes key={s.key} label={s.label} help={s.help} />;
        const isUi = s.key.startsWith('ui.');
        const f = byKey.get(s.key);
        const available = isUi || Boolean(f) || isMockMode();
        const value = isUi ? prefs[s.key.slice(3)] : (f ? f.value : false);
        return (
          <Switch key={s.key} label={s.label} help={s.help} checked={value} disabled={!available}
            note={available ? null : tv('hedwig.v2.notYet', 'Not available yet.')}
            onChange={(v) => save(s.key, v)} />
        );
      })}
      <ErrorLine error={error} />
    </Section>
  );
}

const MODES = ['instant', 'daily', 'weekly'];

export function scheduleLabel(schedule) {
  const mode = schedule?.mode || 'instant';
  if (mode === 'daily') return tv('hedwig.v2.settings.daily', 'Every day at {{at}}', { at: schedule.at || '08:00' });
  if (mode === 'weekly') {
    const day = new Date(2026, 0, 4 + (Number(schedule.day) || 0)).toLocaleDateString(undefined, { weekday: 'long' });
    return tv('hedwig.v2.settings.weekly', 'Every {{day}} at {{at}}', { day, at: schedule.at || '08:00' });
  }
  return tv('hedwig.v2.settings.instant', 'As it arrives');
}

function BundleTimes({ label, help }) {
  const [open, setOpen] = useState(false);
  const res = useV2Resource(open ? '/sort/bundles' : null, { refreshOn: [] });
  const [error, setError] = useState(null);
  const bundles = listOf(res.data, 'bundles');
  const save = async (b, schedule) => {
    setError(null);
    try {
      const out = await v2Api.patch(`/sort/bundles/${encodeURIComponent(b.id)}`, { schedule });
      const next = out?.bundle || { ...b, schedule };
      res.setData((d) => ({ ...(d || {}), bundles: listOf(d, 'bundles').map((x) => (x.id === b.id ? { ...x, ...next } : x)) }));
    } catch (e) { setError(e); }
  };
  const inputStyle = { font: 'inherit', fontSize: 13, color: V.ink, background: V.field, border: `1px solid ${V.line}`, borderRadius: 8, height: 28, boxSizing: 'border-box', padding: '0 8px' };
  return (
    <div style={{ padding: '10px 0', borderTop: `1px solid ${V.line}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13 }}>{label}</span>
          <span style={{ fontSize: 12, color: V.muted }}>{help}</span>
        </span>
        <IconButton icon={open ? 'chevron-up' : 'chevron-down'} aria-expanded={open} label={open ? tv('hedwig.v2.records.hide', 'Hide') : tv('hedwig.v2.records.show', 'Show')} onClick={() => setOpen((v) => !v)} />
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>
          {res.error && <ErrorLine error={res.error.status === 404 ? new Error(tv('hedwig.v2.notYet', 'Not available yet.')) : res.error} />}
          {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
          {bundles.map((b) => {
            const sc = b.schedule || { mode: 'instant' };
            const mode = MODES.includes(sc.mode) ? sc.mode : 'instant';
            return (
              <div key={b.id || b.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${V.line}`, flexWrap: 'wrap' }}>
                <span style={{ flexGrow: 1, minWidth: 120, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 13 }}>{b.name || b.key}</span>
                  <span style={{ fontSize: 12, color: V.muted }}>{scheduleLabel(sc)}</span>
                </span>
                <select aria-label={tv('hedwig.v2.settings.whenFor', 'When {{name}} arrives', { name: b.name || b.key })} value={mode} style={inputStyle}
                  onChange={(e) => save(b, e.target.value === 'instant' ? { mode: 'instant' } : { mode: e.target.value, at: sc.at || '08:00', ...(e.target.value === 'weekly' ? { day: sc.day ?? 6 } : {}) })}>
                  {MODES.map((m) => <option key={m} value={m}>{m === 'instant' ? tv('hedwig.v2.settings.instant', 'As it arrives') : m === 'daily' ? tv('hedwig.v2.settings.modeDaily', 'Daily') : tv('hedwig.v2.settings.modeWeekly', 'Weekly')}</option>)}
                </select>
                {mode === 'weekly' && (
                  <select aria-label={tv('hedwig.v2.settings.dayFor', 'Day for {{name}}', { name: b.name || b.key })} value={Number(sc.day) || 0} style={inputStyle} onChange={(e) => save(b, { ...sc, day: Number(e.target.value) })}>
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{new Date(2026, 0, 4 + d).toLocaleDateString(undefined, { weekday: 'long' })}</option>)}
                  </select>
                )}
                {mode !== 'instant' && (
                  <input type="time" aria-label={tv('hedwig.v2.settings.timeFor', 'Time for {{name}}', { name: b.name || b.key })} defaultValue={sc.at || '08:00'} style={inputStyle}
                    onBlur={(e) => { if (e.target.value && e.target.value !== sc.at) save(b, { ...sc, at: e.target.value }); }} />
                )}
              </div>
            );
          })}
          <ErrorLine error={error} />
        </div>
      )}
    </div>
  );
}

/** The mail dark mode choices, in order: Smart (the default) and Off. */
export function mailDarkChoices() {
  return [
    { value: 'smart', label: tv('hedwig.v2.settings.mailDarkSmart', 'Smart') },
    { value: 'off', label: tv('hedwig.v2.settings.mailDarkOff', 'Off') },
  ];
}

// "Dark mode for mail": Smart darkens light mail in the dark theme (images keep their colours),
// Off shows every mail on its own light page. Two segments on the field fill, radius 8.
function MailDarkRow({ value }) {
  const current = normaliseMailDark(value);
  const label = tv('hedwig.v2.settings.mailDark', 'Dark mode for mail');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}` }}>
      <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.settings.mailDarkHelp', 'In the dark look, light mail is darkened and photos keep their colours.')}</span>
      </span>
      <div role="radiogroup" aria-label={label} data-mail-dark-setting="" style={{ display: 'inline-flex', padding: 2, gap: 2, borderRadius: 8, background: V.field, flexShrink: 0 }}>
        {mailDarkChoices().map((c) => {
          const on = current === c.value;
          return (
            <button key={c.value} type="button" role="radio" aria-checked={on} onClick={() => { if (!on) useV2.getState().setPref('mailDark', c.value); }}
              className="hw-btn"
              style={{ height: 24, padding: '0 10px', border: 0, borderRadius: 6, background: on ? V.content : 'transparent', boxShadow: on ? `0 0 0 1px ${V.line}` : 'none', color: on ? V.ink : V.muted, font: 'inherit', fontSize: 12, fontWeight: on ? 600 : 400, cursor: on ? 'default' : 'pointer' }}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LookSection() {
  const prefs = useV2((s) => s.prefs);
  const schemeChoice = useV2((s) => s.scheme);
  const theme = useStore((s) => s.theme);
  const scheme = schemeChoice || (theme === 'hedwig-night' ? 'dark' : 'light');
  const [blur, setBlur] = useState(prefs.blur);
  const accent = (prefs.accent || DEFAULT_ACCENT).toUpperCase();
  return (
    <Section title={tv('hedwig.v2.settings.look', 'The look')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}`, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, flexGrow: 1 }}>{tv('hedwig.v2.settings.accent', 'Accent')}</span>
        <div role="radiogroup" aria-label={tv('hedwig.v2.settings.accent', 'Accent')} style={{ display: 'flex', gap: 10 }}>
          {ACCENTS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={accent === c} aria-label={c} title={c} onClick={() => useV2.getState().setPref('accent', c)}
              style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: accent === c ? `2px solid ${V.ink}` : '2px solid transparent', outline: accent === c ? `2px solid ${V.paper}` : 'none', outlineOffset: -4, cursor: 'pointer', padding: 0 }} />
          ))}
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}` }}>
        <span style={{ fontSize: 13, flexGrow: 1 }}>{tv('hedwig.v2.settings.blur', 'Glass blur')}</span>
        <input type="range" min={0} max={48} step={2} value={blur} onChange={(e) => setBlur(Number(e.target.value))}
          onPointerUp={() => useV2.getState().setPref('blur', blur)} onKeyUp={() => useV2.getState().setPref('blur', blur)} onBlur={() => { if (blur !== prefs.blur) useV2.getState().setPref('blur', blur); }}
          style={{ width: 180, accentColor: 'var(--hw-accent)' }} />
        <Mono size={12}>{`${blur}px`}</Mono>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}` }}>
        <span style={{ fontSize: 13, flexGrow: 1 }}>{tv('hedwig.v2.settings.scheme', 'Light or dark')}</span>
        <LinkBtn onClick={() => useV2.getState().setScheme(nextScheme(scheme))}>{schemeLabel(scheme)}</LinkBtn>
      </div>
      <MailDarkRow value={prefs.mailDark} />
      {(prefs.accent !== UI_DEFAULTS.accent || prefs.blur !== UI_DEFAULTS.blur) && (
        <div style={{ paddingTop: 4 }}>
          <LinkBtn muted onClick={() => { useV2.getState().setPref('accent', UI_DEFAULTS.accent); useV2.getState().setPref('blur', UI_DEFAULTS.blur); setBlur(UI_DEFAULTS.blur); }}>
            {tv('hedwig.v2.settings.resetLook', 'Back to the default look')}
          </LinkBtn>
        </div>
      )}
    </Section>
  );
}

// C's rules: conditions { match: 'all'|'any', items: [{ field, op, value }] }, actions
// [{ type, value }]. Anything else is shown as key: value pairs.
export function describe(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj)) return obj.map((a) => (a && typeof a === 'object' ? [a.type, a.value].filter(Boolean).join(' ') : String(a))).join(', ');
  if (Array.isArray(obj.items)) {
    return obj.items.map((i) => [i.field, i.op, i.value].filter((x) => x != null && x !== '').join(' ')).join(obj.match === 'any' ? ' or ' : ' and ');
  }
  return Object.entries(obj).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

function RulesSection() {
  const res = useV2Resource('/sort/rules');
  const [dry, setDry] = useState({});
  const rules = listOf(res.data, 'rules');
  const dryRun = async (r) => {
    setDry((d) => ({ ...d, [r.id]: { loading: true } }));
    try {
      const out = await v2Api.post(`/sort/rules/${encodeURIComponent(r.id)}/dryrun`, {});
      setDry((d) => ({ ...d, [r.id]: { data: out } }));
    } catch (error) {
      setDry((d) => ({ ...d, [r.id]: { error } }));
    }
  };
  return (
    <Section title={tv('hedwig.v2.power.rules', 'Rules')}>
      {res.error && <ErrorLine error={res.error.status === 404 ? new Error(tv('hedwig.v2.notYet', 'Not available yet.')) : res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {res.data && !rules.length && <Quiet><Why>{tv('hedwig.v2.power.noRules', 'No rules yet. "Always" corrections become rules here.')}</Why></Quiet>}
      {rules.map((r) => {
        const d = dry[r.id];
        return (
          <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0', borderTop: `1px solid ${V.line}`, opacity: r.enabled === false ? 0.6 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <Mono size={12}>{r.position ?? ''}</Mono>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name || r.id}</span>
              {r.enabled === false && <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.power.off', 'off')}</span>}
              <span style={{ flexGrow: 1 }} />
              <Mono size={12}>{tv('hedwig.v2.power.hits', '{{n}} hits', { n: r.hits ?? 0 })}</Mono>
              <LinkBtn onClick={() => dryRun(r)} disabled={d?.loading}>{tv('hedwig.v2.power.dryRun', 'Dry run')}</LinkBtn>
            </div>
            <span style={{ fontSize: 12, color: V.muted }}>{describe(r.conditions)}{r.actions ? ` → ${describe(r.actions)}` : ''}</span>
            {d?.loading && <span style={{ fontSize: 13, color: V.muted }}>{tv('hedwig.v2.loading', 'Loading…')}</span>}
            {d?.error && <ErrorLine error={d.error} />}
            {d?.data && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 12 }}>
                <Why>{tv('hedwig.v2.power.matched', 'Would match {{n}} messages', { n: d.data.matched ?? 0 })}</Why>
                {listOf(d.data.sample, 'sample').slice(0, 5).map((m, i) => (
                  <span key={m.messageId || i} style={{ fontSize: 13 }}>
                    <Mono>{listTime(m.date)}</Mono> {typeof m.from === 'string' ? m.from : (m.from?.name || m.from?.email || '')} · {m.subject}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/** One role's routing from /status models ({ primary, fallback, active, degraded }) as a line. */
export function routingLine(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return '';
  const main = model.active || model.primary || model.id || model.model || '';
  const parts = [main];
  if (model.degraded && model.primary && model.primary !== main) parts.push(tv('hedwig.v2.power.onFallback', 'standing in for {{model}}', { model: model.primary }));
  else if (model.fallback && model.fallback !== main) parts.push(tv('hedwig.v2.power.fallback', 'falls back to {{model}}', { model: model.fallback }));
  return parts.filter(Boolean).join(' · ');
}

function RoutingSection({ admin }) {
  const status = useHedwig((s) => s.status);
  // GET /routing: the household's routing table, read-only, with this person's tokens today.
  const table = useV2Resource('/routing', { refreshOn: [] });
  const features = listOf(table.data, 'features');
  // What serves each tier: /status `tiers` (reflex, reasoning, agent), else the older `models`.
  const tiers = status?.tiers && typeof status.tiers === 'object' ? status.tiers : null;
  const models = status?.models || {};
  const fromTier = (t) => (t && typeof t === 'object' ? { ...t, primary: t.model ?? t.primary } : null);
  const rows = [['fast', 'reflex'], ['long', 'reasoning'], ['agent', 'agent']]
    .map(([role, tier]) => [role, (tiers && fromTier(tiers[tier])) || models[role]])
    .filter(([, m]) => m);
  const openRouting = () => useHedwig.getState().openView('hedwig.settings.routing');
  return (
    <Section title={tv('hedwig.v2.power.routing', 'Routing')} right={admin ? <LinkBtn onClick={openRouting}>{tv('hedwig.v2.power.editRoutingTiers', 'Change models and routing')}</LinkBtn> : <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.power.readOnly', 'read-only')}</span>}>
      <TierNote />
      {!rows.length && <Quiet>{tv('hedwig.v2.power.noRouting', 'The model routing is not known yet.')}</Quiet>}
      {rows.map(([role, model]) => (
        <div key={role} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) minmax(0, 1fr)', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}`, alignItems: 'baseline' }}>
          <span style={{ fontSize: 13 }}>{tierLabel(role)}</span>
          <Code size={12} color={model?.degraded ? V.attentionInk : V.ink} style={{ overflowWrap: 'anywhere' }}>{routingLine(model)}</Code>
        </div>
      ))}
      {features.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>
          {features.map((f) => (
            <div key={f.feature} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) minmax(0, 1fr) auto', gap: 12, padding: '8px 0', borderTop: `1px solid ${V.line}`, alignItems: 'baseline' }}>
              <span style={{ fontSize: 13 }}>{f.feature}</span>
              <span style={{ fontSize: 12, color: V.muted, minWidth: 0 }}>{[tierChoiceLabel(f.override, f.defaultTier), f.cadence].filter(Boolean).join(' · ')}</span>
              <Mono size={11}>{f.usedToday ? tv('hedwig.v2.power.usedToday', '{{n}} tokens today', { n: Number(f.usedToday).toLocaleString() }) : ''}</Mono>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function PromptsSection() {
  const res = useV2Resource('/admin/prompts');
  const prompts = listOf(res.data, 'prompts');
  return (
    <Section title={tv('hedwig.v2.power.prompts', 'Prompt versions')}>
      {res.error && <Quiet>{res.error.status === 404 ? tv('hedwig.v2.notYet', 'Not available yet.') : (res.error.message || String(res.error))}</Quiet>}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {prompts.map((p) => (
        <div key={p.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 14, padding: '10px 0', borderTop: `1px solid ${V.line}`, alignItems: 'baseline' }}>
          <Code size={12}>{p.id}</Code>
          <Mono size={12}>{p.version}{p.tier ? ` · ${p.tier}` : ''}</Mono>
          <Code size={11} color={V.muted} title={p.hash || undefined}>{p.hash ? String(p.hash).slice(0, 8) : ''}</Code>
        </div>
      ))}
    </Section>
  );
}

function IndexSection() {
  const res = useV2Resource('/index/status', { pollMs: 30_000, refreshOn: [] });
  const d = res.data || {};
  const rows = listOf(d.coverage, 'coverage');
  const embeddedPct = d.pct?.embedded ?? percent(d.embedded, d.total);
  const recipe = typeof d.recipe === 'string' ? d.recipe : (d.recipe?.active || d.recipe?.target || '');
  return (
    <Section title={tv('hedwig.v2.power.index', 'Index')} right={res.data ? <Code size={11} color={V.muted}>{recipe}</Code> : null}>
      {res.error && <ErrorLine error={res.error.status === 404 ? new Error(tv('hedwig.v2.notYet', 'Not available yet.')) : res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {res.data && !d.total && (
        // No coverage rows yet: "100% · 0 of 0" would claim a finished index.
        <Quiet>{tv('hedwig.v2.power.indexEmpty', 'Hedwig has not counted this mailbox yet. Indexing starts with the next sync.')}</Quiet>
      )}
      {res.data && d.total > 0 && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap', padding: '6px 0 10px' }}>
          <span data-figure="" style={{ fontFamily: V.sans, fontWeight: 600, fontSize: 20, lineHeight: 1.15, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>{`${embeddedPct}%`}</span>
          <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.power.indexSummary', '{{embedded}} of {{total}} messages searchable · {{pending}} to go', { embedded: (d.embedded ?? 0).toLocaleString(), total: (d.total ?? 0).toLocaleString(), pending: (d.pending ?? 0).toLocaleString() })}</span>
          {d.embedError && <span role="alert" style={{ fontSize: 13, color: V.red }}>{d.embedError}</span>}
        </div>
      )}
      {rows.map((r, i) => {
        const pct = r.pct?.embedded ?? percent(r.embedded, r.total || r.seen);
        return (
          <div key={`${r.accountId || r.account_id}-${r.folder}-${i}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px 60px', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}`, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13 }}>{[r.account, r.folder].filter(Boolean).join(' · ')}</span>
              <span style={{ fontSize: 12, color: r.error ? V.red : V.muted }}>{r.error || r.state}</span>
            </div>
            <div aria-hidden="true" style={{ height: 4, borderRadius: 2, background: V.line, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: r.state === 'paused' ? V.muted : V.accent }} />
            </div>
            <Mono size={12} style={{ textAlign: 'right' }}>{`${pct}%`}</Mono>
          </div>
        );
      })}
    </Section>
  );
}

/** The v2 part of Settings → Hedwig. */
export default function HedwigSettingsV2() {
  const power = useV2((s) => s.prefs.powerMode);
  const admin = useIsAdmin();
  return (
    <div className="hw-v2" style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: V.sans, fontSize: 13, color: V.ink }}>
      <section data-power-mode="" style={{ display: 'flex', flexDirection: 'column', maxWidth: 900 }}>
        <Switch
          label={tv('hedwig.v2.power.label', 'Power mode')}
          help={power
            ? tv('hedwig.v2.power.onIntro', 'Power is on: rules, routing, prompts and the index are below.')
            : tv('hedwig.v2.power.offIntro', 'Simple keeps it to five switches. Power shows how Hedwig decides.')}
          title={tv('hedwig.v2.power.hint', 'Power shows rules, routing, prompts and index status')}
          checked={power}
          onChange={() => useV2.getState().togglePower()}
          data-power-switch=""
        />
      </section>
      <SimpleSection />
      <LookSection />
      {power && (
        <>
          <Hair />
          <RulesSection />
          <RoutingSection admin={admin} />
          {admin && <PromptsSection />}
          <IndexSection />
        </>
      )}
    </div>
  );
}
