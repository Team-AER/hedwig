// hedwig.settings.routing (admin) — Models and routing: the model behind each tier, picked from
// the gateway catalog, with its reasoning effort limited to what the catalog says the model
// supports; what is serving each tier right now and a live check; the per-feature routing table
// (tier, escalation, token budget); usage per feature; and the models people may pick.
//
// Routes (backend/src/hedwig/ledger/admin.js, onboarding/routing.js): GET/PUT /admin/runtime
// (tiers, fallback, enabledModels, status; PUT answers with `notes` on what each model will
// actually get, 400 on a catalog violation), GET /admin/models/catalog, POST /admin/tiers/probe
// (the Test button), GET /admin/usage?days=7 (falls back to GET /admin/health's aiCalls24h),
// GET/PUT /admin/routing. A route that is missing hides its section.
import { useState } from 'react';
import { useHedwig } from '../../store.js';
import { useIsAdmin } from '../hooks.js';
import SettingsFrame from './SettingsFrame.jsx';
import { v2Api, listOf } from '../../v2/client.js';
import { useV2Resource, isMissing } from '../../v2/hooks.js';
import { Btn, Code, ErrorLine, Mono, Quiet, Reason, SectionLabel, V, Why } from '../../v2/primitives.jsx';
import { tierLabel } from '../../v2/tiers.js';
import { tv } from '../../v2/i18n.js';

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
// Runtime tiers → the role keys PUT /admin/runtime takes for models and effort.
const TIERS = [['reflex', 'fast'], ['reasoning', 'long'], ['agent', 'agent']];
const USAGE_DAYS = 7;

/** Chat-capable catalog entries (embeddings, image models left out). */
export function chatModels(catalog) {
  return listOf(catalog, 'models').filter((m) => m && m.id && m.chat !== false
    && !(Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('chat')));
}

/**
 * The efforts a model accepts, in ladder order: the catalog's efforts ('none' is 'off'; the
 * admin catalog calls them reasoningEfforts, the raw one reasoning_efforts), only 'off' for a
 * model the catalog says cannot reason, every level when the catalog is silent.
 */
export function effortOptions(model) {
  if (!model) return EFFORTS;
  const raw = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length ? model.reasoningEfforts : model.reasoning_efforts;
  const listed = Array.isArray(raw) ? raw.map((e) => (e === 'none' ? 'off' : e)) : [];
  const known = EFFORTS.filter((e) => listed.includes(e));
  if (known.length) return known.includes('off') ? known : ['off', ...known];
  const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
  if (model.reasoning === false || (caps.length && !caps.includes('reasoning'))) return ['off'];
  return EFFORTS;
}

/** The effort to store for a model: the wanted one, or the nearest the model supports. */
export function clampEffort(want, model) {
  const opts = effortOptions(model);
  if (opts.includes(want)) return want;
  const w = EFFORTS.indexOf(want);
  return opts.reduce((best, e) => (Math.abs(EFFORTS.indexOf(e) - w) < Math.abs(EFFORTS.indexOf(best) - w) ? e : best), opts[0]);
}

function effortLabel(e) {
  if (e === 'off' || e === 'none') return tv('hedwig.v2.routing.effortOff', 'Off');
  if (e === 'low') return tv('hedwig.v2.routing.effortLow', 'Low');
  if (e === 'medium') return tv('hedwig.v2.routing.effortMedium', 'Medium');
  if (e === 'high') return tv('hedwig.v2.routing.effortHigh', 'High');
  return tv('hedwig.v2.routing.effortXhigh', 'Extra high');
}

/** A routing table tier choice as words. */
export function tierChoiceLabel(choice, defaultTier) {
  if (choice === 'reflex') return tierLabel('reflex');
  if (choice === 'reasoning') return tierLabel('reasoning');
  const def = defaultTier === 'reflex' || defaultTier === 'reasoning' ? tierLabel(defaultTier) : tv('hedwig.v2.routing.mixed', 'each prompt’s own tier');
  return tv('hedwig.v2.routing.auto', 'Auto: {{tier}}', { tier: def });
}

/**
 * Usage per feature, summed over tiers, from GET /admin/usage (`features: [{ feature, tier,
 * calls, errors, fellBack, escalated, tokens, avgLatencyMs, … }]`, one row per feature and tier)
 * or /admin/health's `aiCalls24h`. → [{ feature, calls, errors, tokens, avgMs, fallbacks,
 * escalations }], most calls first; a figure the source does not have is null.
 */
export function usageRows(data) {
  const list = Array.isArray(data) ? data : listOf(data, 'features').length ? data.features : listOf(data, 'usage').length ? data.usage : listOf(data, 'aiCalls24h');
  const num = (...v) => { for (const x of v) { if (x == null) continue; const n = Number(x); if (Number.isFinite(n)) return n; } return null; };
  const by = new Map();
  for (const r of list) {
    if (!r || !r.feature) continue;
    const calls = num(r.calls) ?? 0;
    const tokIn = num(r.tokensIn, r.prompt_tokens, r.tokens_in);
    const tokens = num(r.tokens, tokIn != null ? tokIn + (num(r.tokensOut, r.completion_tokens, r.tokens_out) ?? 0) : null);
    const avg = num(r.avgLatencyMs, r.avg_latency_ms, r.latencyMs);
    const f = by.get(r.feature) || { feature: String(r.feature), calls: 0, errors: 0, tokens: null, latSum: 0, latCalls: 0, fallbacks: null, escalations: null };
    const add = (k, v) => { if (v != null) f[k] = (f[k] ?? 0) + v; };
    f.calls += calls;
    f.errors += num(r.errors, r.failed) ?? 0;
    add('tokens', tokens);
    add('fallbacks', num(r.fellBack, r.fell_back, r.fallbacks));
    add('escalations', num(r.escalated, r.escalations));
    if (avg != null) { f.latSum += avg * (calls || 1); f.latCalls += calls || 1; }
    by.set(r.feature, f);
  }
  return [...by.values()]
    .map(({ latSum, latCalls, ...f }) => ({ ...f, avgMs: latCalls ? Math.round(latSum / latCalls) : null }))
    .sort((a, b) => b.calls - a.calls);
}

/** What is serving a tier, in words, from tierStatus's entry. */
export function servingLine(s) {
  if (!s || typeof s !== 'object') return null;
  const reason = s.reason ? ` (${s.reason})` : '';
  if (s.degraded) {
    return s.active && s.active !== s.model
      ? tv('hedwig.v2.routing.servingFallback', 'Not answering{{reason}}; {{model}} is standing in.', { reason, model: s.active })
      : tv('hedwig.v2.routing.servingDown', 'Not answering{{reason}}; no lighter model is set.', { reason });
  }
  const ms = typeof s.latencyMs === 'number' ? ` · ${(s.latencyMs / 1000).toFixed(1)} s` : '';
  return tv('hedwig.v2.routing.serving', 'Serving now: {{model}}', { model: `${s.active || s.model || ''}${ms}` });
}

const fmt = (n) => (n == null ? '' : Number(n).toLocaleString());
const pct = (part, whole) => (part == null || !whole ? '' : `${Math.round((part / whole) * 100)}%`);
const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px 16px', padding: '12px 0', borderTop: `1px solid ${V.line}`, alignItems: 'baseline' };
// A field: 28px, radius 8, the --hw-field fill with a hairline, 13px text.
const selectStyle = { font: 'inherit', fontSize: 13, color: V.ink, background: V.field, border: `1px solid ${V.line}`, borderRadius: 8, height: 28, boxSizing: 'border-box', padding: '0 8px', minWidth: 0, maxWidth: '100%' };

function Section({ title, sub, right, children }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <SectionLabel as="h2" style={{ padding: 0 }}>{title}</SectionLabel>
        <span style={{ flexGrow: 1 }} />
        {right}
      </div>
      {sub && <Why>{sub}</Why>}
      {children}
    </section>
  );
}

function ModelSelect({ value, models, onChange, label, allowNone = false }) {
  const known = models.some((m) => m.id === value);
  return (
    <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
      {allowNone && <option value="">{tv('hedwig.v2.routing.none', 'None')}</option>}
      {!allowNone && !value && <option value="" disabled>{tv('hedwig.v2.routing.pick', 'Pick a model')}</option>}
      {value && !known && <option value={value}>{tv('hedwig.v2.routing.notInCatalog', '{{model}} (not in the catalog)', { model: value })}</option>}
      {models.map((m) => {
        const name = m.displayName || m.display_name;
        return <option key={m.id} value={m.id}>{name && name !== m.id ? `${name} · ${m.id}` : m.id}{m.status && m.status !== 'ready' ? ` · ${m.status}` : ''}</option>;
      })}
    </select>
  );
}

/** One tier from GET /admin/runtime: the model, its effort, what is serving it, the last check. */
function TierRow({ tier, role, entry, models, serving, probed, onPut }) {
  const model = entry?.model || '';
  const effort = entry?.effort || 'off';
  const info = models.find((m) => m.id === model) || null;
  const listed = Array.isArray(entry?.efforts) && entry.efforts.length ? entry.efforts : null;
  const efforts = info ? effortOptions(info) : (listed ? (listed.includes('off') ? listed : ['off', ...listed]) : EFFORTS);
  const pickModel = (id) => {
    const next = models.find((m) => m.id === id) || null;
    const clamped = clampEffort(effort, next);
    onPut({ models: { [role]: id }, ...(clamped !== effort ? { effort: { [role]: clamped } } : {}) });
  };
  const wire = entry?.wireEffort;
  const sentAs = wire && wire !== effort && !(effort === 'off' && wire === 'none') ? wire : null;
  const help = tier === 'reflex'
    ? tv('hedwig.v2.routing.reflexHelp', 'Reads every message: sorting, screening, spam, cards, quick replies. JSON only, no tools.')
    : tier === 'reasoning'
      ? tv('hedwig.v2.routing.reasoningHelp', 'Thinks about a little: Ask, drafts, the story on long threads, the Brief’s prose, anything Tier 1 escalates.')
      : tv('hedwig.v2.routing.agentHelp', 'The agent and automations; needs tool calling.');
  const serve = servingLine(serving);
  return (
    <div data-tier-row={role} style={rowStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 200px' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{tierLabel(role)}</span>
        <span style={{ fontSize: 12, color: V.muted }}>{help}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '2 1 240px' }}>
        <ModelSelect value={model} models={models} label={tv('hedwig.v2.routing.modelFor', 'Model for {{tier}}', { tier: tierLabel(role) })} onChange={pickModel} />
        {entry && entry.inCatalog === false && <span style={{ fontSize: 12, color: V.accentInk }}>{tv('hedwig.v2.routing.missingModel', 'This model is not in the gateway catalog.')}</span>}
        {serve && <span data-serving="" style={{ fontSize: 12, color: serving?.degraded ? V.accentInk : V.muted }}>{serve}</span>}
        {probed && (
          <span role="status" style={{ fontSize: 12, color: probed.ok ? V.muted : V.red, overflowWrap: 'anywhere' }}>
            {probed.ok
              ? tv('hedwig.v2.routing.testOk', 'Answered in {{ms}} ms by {{model}}', { ms: probed.latencyMs ?? '?', model: probed.model || model })
              : tv('hedwig.v2.routing.testFailed', 'No answer: {{error}}', { error: probed.error || '' })}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', flex: '0 0 120px' }}>
        <select aria-label={tv('hedwig.v2.routing.effortFor', 'Reasoning effort for {{tier}}', { tier: tierLabel(role) })} value={efforts.includes(effort) ? effort : ''} onChange={(e) => onPut({ effort: { [role]: e.target.value } })} style={selectStyle}>
          {!efforts.includes(effort) && <option value="" disabled>{effortLabel(effort)}</option>}
          {efforts.map((e) => <option key={e} value={e}>{effortLabel(e)}</option>)}
        </select>
        {sentAs && <span style={{ fontSize: 11, color: V.muted }}>{tv('hedwig.v2.routing.sentAs', 'sent as {{effort}}', { effort: sentAs })}</span>}
      </div>
    </div>
  );
}

function TiersSection({ runtime, catalog, onPut, error, notes }) {
  const [probe, setProbe] = useState(null); // { pending } | POST /admin/tiers/probe's answer
  const models = chatModels(catalog.data);
  const rt = runtime.data;
  const status = probe && !probe.pending && !probe.error ? probe : rt?.status;
  const runProbe = async () => {
    setProbe({ pending: true });
    try {
      setProbe(await v2Api.post('/admin/tiers/probe', {}));
      useHedwig.getState().refreshStatus?.();
    } catch (e) { setProbe({ error: e }); }
  };
  const probedFor = (model) => (Array.isArray(probe?.probed) ? probe.probed.find((p) => p && p.model === model) : null);
  const fallback = rt?.fallback?.model || '';
  return (
    <Section
      title={tv('hedwig.v2.routing.tiers', 'The two tiers')}
      sub={tv('hedwig.v2.routing.tiersSub', 'A small model reads everything; a large model thinks about a little. Both come from the gateway catalog.')}
      right={(
        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'baseline' }}>
          <Mono size={12}>{catalog.loading && !catalog.data ? tv('hedwig.v2.loading', 'Loading…') : tv('hedwig.v2.routing.catalogCount', '{{n}} models in the catalog', { n: models.length })}</Mono>
          {rt && <Btn onClick={runProbe} disabled={probe?.pending}>{probe?.pending ? tv('hedwig.v2.routing.testing', 'Testing…') : tv('hedwig.v2.routing.testAll', 'Test the models')}</Btn>}
        </span>
      )}
    >
      {status?.notice?.text && (
        <span role="status" data-runtime-notice="" title={status.notice.detail || undefined}><Reason glyph="bolt" tone="attention">{status.notice.text}</Reason></span>
      )}
      {runtime.error && (isMissing(runtime.error)
        ? <Quiet><Why>{tv('hedwig.v2.routing.noRuntime', 'The model runtime settings are not available on this server yet.')}</Why></Quiet>
        : <ErrorLine error={runtime.error} onRetry={() => runtime.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />)}
      {catalog.error && !isMissing(catalog.error) && <ErrorLine error={catalog.error} onRetry={() => catalog.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {runtime.loading && !rt && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {rt?.tiers && TIERS.map(([tier, role]) => (
        <TierRow key={role} tier={tier} role={role} entry={rt.tiers[tier]} models={models} serving={status?.[tier]} probed={probedFor(rt.tiers[tier]?.model)} onPut={onPut} />
      ))}
      {rt && (
        <div style={rowStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 200px' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{tv('hedwig.v2.routing.fallback', 'Lighter model')}</span>
            <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.routing.fallbackHelp', 'Answers when a tier’s model does not respond in time. Its answers are labelled.')}</span>
          </div>
          <div style={{ minWidth: 0, flex: '2 1 240px' }}>
            <ModelSelect allowNone value={fallback} models={models} label={tv('hedwig.v2.routing.fallbackLabel', 'Lighter model for every tier')} onChange={(id) => onPut({ models: { fallback: id || '' } })} />
          </div>
          <span style={{ flex: '0 0 120px' }} />
        </div>
      )}
      {probe?.skipped && <Quiet><Why>{tv('hedwig.v2.routing.probeSkipped', 'Not tested: {{why}}', { why: probe.skipped })}</Why></Quiet>}
      {probe?.error && <ErrorLine error={probe.error} />}
      {notes.length > 0 && (
        <div role="status" data-runtime-notes="" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {notes.map((n) => <Why key={n} size={14}>{n}</Why>)}
        </div>
      )}
      <ErrorLine error={error} />
    </Section>
  );
}

function RoutingTableSection() {
  const res = useV2Resource('/admin/routing', { refreshOn: [] });
  const usage = useUsage();
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const features = listOf(res.data, 'features');
  const used = new Map(usageRows(usage.data).map((u) => [u.feature, u]));
  const put = async (feature, change) => {
    setError(null);
    setSaving(feature);
    try {
      const next = await v2Api.put('/admin/routing', { [feature]: change });
      if (next && Array.isArray(next.features)) res.setData(next); else await res.reload({ quiet: true });
    } catch (e) { setError(e); } finally { setSaving(null); }
  };
  if (isMissing(res.error)) return null;
  return (
    <Section title={tv('hedwig.v2.routing.table', 'Routing by feature')} sub={tv('hedwig.v2.routing.tableSub', 'Which tier handles each feature, when sorting escalates to Tier 2, and each person’s daily token budget.')}>
      {res.error && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {features.map((f) => {
        const u = used.get(f.feature);
        return (
          <div key={f.feature} data-feature={f.feature} style={{ ...rowStyle, padding: '12px 0', opacity: saving === f.feature ? 0.6 : 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 150px' }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{f.feature}</span>
              {f.cadence && <span style={{ fontSize: 12, color: V.muted }}>{f.cadence}</span>}
            </div>
            <div style={{ minWidth: 0, flex: '1 1 200px' }}>
              {f.tierKey
                ? (
                  <select aria-label={tv('hedwig.v2.routing.tierFor', 'Tier for {{feature}}', { feature: f.feature })} value={f.override || 'auto'} onChange={(e) => put(f.feature, { tier: e.target.value })} style={{ ...selectStyle, width: '100%' }}>
                    {['auto', 'reflex', 'reasoning'].map((c) => <option key={c} value={c}>{tierChoiceLabel(c, f.defaultTier)}</option>)}
                  </select>
                )
                : <span style={{ fontSize: 13 }}>{tierChoiceLabel(f.tier, f.defaultTier)}</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 180px' }}>
              {f.escalateKey && (
                <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: V.muted }}>
                  <span style={{ whiteSpace: 'nowrap', minWidth: 96 }}>{tv('hedwig.v2.routing.escalateBelow', 'To Tier 2 below')}</span>
                  <input
                    type="number" min={0} max={1} step={0.05} defaultValue={f.escalateBelow ?? ''} key={`e-${f.escalateBelow}`}
                    aria-label={tv('hedwig.v2.routing.escalateFor', 'Escalate {{feature}} to Tier 2 below this confidence', { feature: f.feature })}
                    onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== f.escalateBelow) put(f.feature, { escalateBelow: v }); }}
                    style={{ ...selectStyle, width: 64, fontVariantNumeric: 'tabular-nums' }}
                  />
                </label>
              )}
              {f.budgetKey && (
                <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: V.muted }}>
                  <span style={{ whiteSpace: 'nowrap', minWidth: 96 }}>{tv('hedwig.v2.routing.budget', 'Tokens a day')}</span>
                  <input
                    type="number" min={0} step={1000} defaultValue={f.budget ?? ''} key={`b-${f.budget}`}
                    aria-label={tv('hedwig.v2.routing.budgetFor', 'Daily token budget per person for {{feature}}', { feature: f.feature })}
                    onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== f.budget) put(f.feature, { budget: v }); }}
                    style={{ ...selectStyle, width: 110, fontVariantNumeric: 'tabular-nums' }}
                  />
                </label>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', textAlign: 'right', flex: '0 0 100px', marginLeft: 'auto' }}>
              {u
                ? (
                  <>
                    <Mono size={12} color={V.ink}>{tv('hedwig.v2.routing.calls', '{{n}} calls', { n: fmt(u.calls) })}</Mono>
                    {u.tokens != null && <Mono size={11}>{tv('hedwig.v2.routing.tokens', '{{n}} tokens', { n: fmt(u.tokens) })}</Mono>}
                    {u.errors > 0 && <Mono size={11} color={V.red}>{tv('hedwig.v2.routing.errors', '{{n}} failed', { n: fmt(u.errors) })}</Mono>}
                  </>
                )
                : <Mono size={11}>{tv('hedwig.v2.routing.noCalls', 'no calls')}</Mono>}
            </div>
          </div>
        );
      })}
      <ErrorLine error={error} />
    </Section>
  );
}

// GET /admin/usage?days=7, else (a server without it) the health view's last 24 hours.
function useUsage() {
  const usage = useV2Resource(`/admin/usage?days=${USAGE_DAYS}`, { refreshOn: [], pollMs: 60_000 });
  const fallback = useV2Resource(isMissing(usage.error) ? '/admin/health' : null, { refreshOn: [], pollMs: 60_000 });
  return isMissing(usage.error) ? { ...fallback, window: '24h' } : { ...usage, window: 'days' };
}

function UsageSection() {
  const usage = useUsage();
  const rows = usageRows(usage.data);
  if (usage.error && isMissing(usage.error)) return null;
  const hasTokens = rows.some((r) => r.tokens != null);
  const hasFb = rows.some((r) => r.fallbacks != null);
  const hasEsc = rows.some((r) => r.escalations != null);
  const esc = usage.data?.escalation;
  const sub = usage.window === '24h'
    ? tv('hedwig.v2.routing.usage24', 'Model calls in the last 24 hours, every person together.')
    : tv('hedwig.v2.routing.usageDays', 'Model calls in the last {{n}} days, every person together.', { n: usage.data?.days || USAGE_DAYS });
  return (
    <Section
      title={tv('hedwig.v2.routing.usage', 'Usage by feature')}
      sub={sub}
      right={esc && typeof esc.rate === 'number' ? <Mono size={12}>{tv('hedwig.v2.routing.escalationRate', '{{rate}} escalated to Tier 2', { rate: `${Math.round(esc.rate * 1000) / 10}%` })}</Mono> : null}
    >
      {usage.error && <ErrorLine error={usage.error} onRetry={() => usage.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {usage.loading && !usage.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {usage.data && !rows.length && <Quiet><Why>{tv('hedwig.v2.routing.noUsage', 'No model calls yet.')}</Why></Quiet>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: V.muted, textAlign: 'right', fontSize: 11 }}>
                <th scope="col" style={{ textAlign: 'left', fontWeight: 600, padding: '6px 0' }}>{tv('hedwig.v2.routing.colFeature', 'Feature')}</th>
                <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colCalls', 'Calls')}</th>
                <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colFailed', 'Failed')}</th>
                {hasTokens && <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colTokens', 'Tokens')}</th>}
                <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colLatency', 'Average ms')}</th>
                {hasFb && <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colFallback', 'Lighter model')}</th>}
                {hasEsc && <th scope="col" style={{ fontWeight: 600 }}>{tv('hedwig.v2.routing.colEscalated', 'To Tier 2')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feature} data-usage-row={r.feature} style={{ borderTop: `1px solid ${V.line}`, textAlign: 'right', fontFamily: V.sans, fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                  <td style={{ textAlign: 'left', fontSize: 13, padding: '8px 0' }}>{r.feature}</td>
                  <td>{fmt(r.calls)}</td>
                  <td style={{ color: r.errors ? V.red : undefined }}>{fmt(r.errors)}{r.errors ? ` · ${pct(r.errors, r.calls)}` : ''}</td>
                  {hasTokens && <td>{fmt(r.tokens)}</td>}
                  <td>{fmt(r.avgMs)}</td>
                  {hasFb && <td>{r.fallbacks ? pct(r.fallbacks, r.calls) : ''}</td>}
                  {hasEsc && <td>{r.escalations ? pct(r.escalations, r.calls) : ''}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function EnabledModelsSection({ runtime, catalog, onPut }) {
  if (!runtime.data) return null;
  const enabled = new Set(Array.isArray(runtime.data.enabledModels) ? runtime.data.enabledModels : []);
  const models = chatModels(catalog.data);
  const toggle = (id, on) => onPut({ enabledModels: on ? [...enabled, id] : [...enabled].filter((m) => m !== id) });
  return (
    <Section title={tv('hedwig.v2.routing.choices', 'Models people may pick')} sub={tv('hedwig.v2.routing.choicesSub', 'In Power mode each person may use one of these for their own tiers. None ticked: everyone uses the models above.')}>
      {models.map((m) => (
        <label key={m.id} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderTop: `1px solid ${V.line}`, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} style={{ accentColor: 'var(--hw-accent)', width: 16, height: 16, margin: 0 }} />
          <span style={{ fontSize: 13, flexGrow: 1, minWidth: 0 }}>{m.displayName || m.display_name || m.id}</span>
          <Code size={11} color={V.muted}>{m.id}</Code>
        </label>
      ))}
    </Section>
  );
}

function AdminPage() {
  const runtime = useV2Resource('/admin/runtime', { refreshOn: [], pollMs: 30_000 });
  const catalog = useV2Resource('/admin/models/catalog', { refreshOn: [] });
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState([]);
  // Every runtime change goes through PUT /admin/runtime; its answer is the new runtime, with
  // `notes` on what each model will actually get (a clamped effort, a disabled model).
  const onPut = async (body) => {
    setError(null);
    try {
      const next = await v2Api.put('/admin/runtime', body);
      if (next && typeof next === 'object' && next.tiers) runtime.setData(next); else await runtime.reload({ quiet: true });
      setNotes(Array.isArray(next?.notes) ? next.notes.filter((n) => typeof n === 'string') : []);
      useHedwig.getState().refreshStatus?.();
    } catch (e) {
      setNotes([]);
      setError(e);
    }
  };
  return (
    <div className="hw-v2" style={{ display: 'flex', flexDirection: 'column', gap: 30, fontFamily: V.sans, color: V.ink }}>
      <TiersSection runtime={runtime} catalog={catalog} onPut={onPut} error={error} notes={notes} />
      <RoutingTableSection />
      <UsageSection />
      <EnabledModelsSection runtime={runtime} catalog={catalog} onPut={onPut} />
    </div>
  );
}

export default function RoutingSettings() {
  const isAdmin = useIsAdmin();
  const title = tv('hedwig.v2.routing.title', 'Models and routing');
  if (!isAdmin) {
    return (
      <SettingsFrame active="hedwig.settings.routing" title={title}>
        <Quiet><Why>{tv('hedwig.v2.routing.adminsOnly', 'The household’s models and routing are set by an administrator. Power mode shows them, read-only, under Hedwig settings.')}</Why></Quiet>
      </SettingsFrame>
    );
  }
  return (
    <SettingsFrame active="hedwig.settings.routing" title={title} sub={tv('hedwig.v2.routing.sub', 'Admin · applies to everyone in the household')}>
      <AdminPage />
    </SettingsFrame>
  );
}
