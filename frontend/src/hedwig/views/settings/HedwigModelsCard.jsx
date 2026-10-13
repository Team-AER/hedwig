// Mail settings → AI Assistant: the models behind Hedwig's own work (sorting, summaries, extraction,
// the agent), next to the assistant's model so the two are not confused. A compact copy of the
// tier pickers in Models and routing (RoutingSettings.jsx), saved the same way (PUT /admin/runtime,
// which checks the choice against the gateway catalog). Effort, fallback, routing and budgets stay
// on that page, one click away. Styled with the settings dialog's own variables.
import { useEffect, useState } from 'react';
import { useHedwig } from '../../store.js';
import { useStore } from '../../../store/index.js';
import { v2Api } from '../../v2/client.js';
import { tierLabel } from '../../v2/tiers.js';
import { tv } from '../../v2/i18n.js';
import { chatModels, clampEffort, servingLine } from './RoutingSettings.jsx';

// Runtime tiers → the role keys PUT /admin/runtime takes.
const TIERS = [['reflex', 'fast'], ['reasoning', 'long'], ['agent', 'agent']];

const selectStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box', cursor: 'pointer',
};

/** The models a tier may use: chat models, and for the agent only those that call tools. */
export function modelsForRole(models, role) {
  return role === 'agent' ? models.filter((m) => m.tools !== false && !(Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('tools'))) : models;
}

function helpFor(tier) {
  if (tier === 'reflex') return tv('hedwig.v2.routing.reflexHelp', 'Reads every message: sorting, screening, spam, cards, quick replies. JSON only, no tools.');
  if (tier === 'reasoning') return tv('hedwig.v2.routing.reasoningHelp', 'Thinks about a little: Ask, drafts, the story on long threads, the Brief’s prose, anything Tier 1 escalates.');
  return tv('hedwig.v2.routing.agentHelp', 'The agent and automations; needs tool calling.');
}

export default function HedwigModelsCard() {
  const [runtime, setRuntime] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | hidden
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    let alive = true;
    Promise.all([v2Api.get('/admin/runtime'), v2Api.get('/admin/models/catalog')])
      .then(([rt, cat]) => { if (alive) { setRuntime(rt); setCatalog(cat); setState('ready'); } })
      // Not an admin, Hedwig off, or an older server: the card simply is not shown.
      .catch(() => { if (alive) setState('hidden'); });
    return () => { alive = false; };
  }, []);

  if (state !== 'ready' || !runtime?.tiers) return null;
  const models = chatModels(catalog);

  const pick = async (tier, role, id) => {
    setSaving(role); setError(''); setNotes([]);
    const entry = runtime.tiers[tier];
    const effort = entry?.effort;
    const next = models.find((m) => m.id === id) || null;
    const clamped = effort ? clampEffort(effort, next) : effort;
    try {
      const out = await v2Api.put('/admin/runtime', { models: { [role]: id }, ...(clamped && clamped !== effort ? { effort: { [role]: clamped } } : {}) });
      if (out?.tiers) setRuntime(out);
      setNotes(Array.isArray(out?.notes) ? out.notes.filter((n) => typeof n === 'string') : []);
      useHedwig.getState().refreshStatus?.();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(null);
    }
  };

  // Models and routing is a page of this same dialog (settingsTabs.js).
  const openFull = () => useStore.getState().setAdminTab?.('hedwig-routing');

  return (
    <section data-hedwig-models="" style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{tv('hedwig.models.title', 'Hedwig’s models')}</div>
        <button type="button" onClick={openFull} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}>
          {tv('hedwig.models.more', 'Effort, fallback and routing…')}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 14px' }}>
        {tv('hedwig.models.sub', 'Sorting, summaries, extraction and the agent run on these, separately from the assistant model above.')}
      </p>
      {TIERS.map(([tier, role]) => {
        const entry = runtime.tiers[tier] || {};
        const value = entry.model || '';
        const options = modelsForRole(models, role);
        const known = options.some((m) => m.id === value);
        const serve = servingLine(runtime.status?.[tier]);
        return (
          <div key={role} data-tier={role} style={{ marginBottom: 14 }}>
            <label htmlFor={`hedwig-model-${role}`} style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{tierLabel(role)}</label>
            <select id={`hedwig-model-${role}`} value={value} disabled={saving === role} onChange={(e) => pick(tier, role, e.target.value)} style={{ ...selectStyle, opacity: saving === role ? 0.6 : 1 }}>
              {!value && <option value="" disabled>{tv('hedwig.v2.routing.pick', 'Pick a model')}</option>}
              {value && !known && <option value={value}>{tv('hedwig.v2.routing.notInCatalog', '{{model}} (not in the catalog)', { model: value })}</option>}
              {options.map((m) => {
                const name = m.displayName || m.display_name;
                const offline = m.status && m.status !== 'ready';
                return (
                  <option key={m.id} value={m.id} disabled={offline && m.id !== value}>
                    {name && name !== m.id && !name.includes(m.id) ? `${name} — ${m.id}` : (name || m.id)}{offline ? ` · ${m.status}` : ''}
                  </option>
                );
              })}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.45 }}>{helpFor(tier)}</div>
            {serve && <div style={{ fontSize: 11, color: runtime.status?.[tier]?.degraded ? 'var(--red)' : 'var(--text-tertiary)', marginTop: 2 }}>{serve}</div>}
          </div>
        );
      })}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      {notes.map((n) => <div key={n} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{n}</div>)}
    </section>
  );
}
