// hedwig.settings.personal — Settings → Hedwig: the v2 Simple switches and look (plus the Power
// panels when Power is on), this user's Hedwig settings (scope 'user' keys) and today's model
// usage against the daily budgets. In Simple mode the full settings list is folded away.
import { useEffect } from 'react';
import { hedwigApi } from '../../api.js';
import { useHedwig } from '../../store.js';
import { formatCount } from '../helpers.js';
import { useResource } from '../hooks.js';
import ConfigForm from './ConfigForm.jsx';
import SettingsFrame from './SettingsFrame.jsx';
import { Card, Loading, Meter, SectionLabel, StateView, T } from '../ui.jsx';
import { tr } from '../i18n.js';
import HedwigSettingsV2 from '../../v2/HedwigSettings.jsx';
import { useV2 } from '../../v2/state.js';
import { tv } from '../../v2/i18n.js';

export default function PersonalSettings() {
  const settings = useResource('/settings');
  const usage = useResource('/usage', { pollMs: 60_000 });
  const loadStatus = useHedwig((s) => s.loadStatus);
  const power = useV2((s) => s.prefs.powerMode);
  useEffect(() => { if (Array.isArray(settings.data)) useV2.getState().setSettingsFields(settings.data); }, [settings.data]);
  const save = async (patch) => {
    const next = await hedwigApi.patch('/settings', patch);
    if (Array.isArray(next)) { settings.setData(next); useV2.getState().setSettingsFields(next); }
    else await settings.reload({ quiet: true });
    // Feature switches change which views and commands the shell offers.
    if (Object.keys(patch).some((k) => k.startsWith('features.'))) loadStatus?.();
  };

  const all = (
    <>
      <Usage res={usage} />
      <Card style={{ gap: 12, maxWidth: 900 }}>
        <SectionLabel>{tr('personalSettings.settings', 'Settings')}</SectionLabel>
        {settings.loading && !settings.data && <Loading />}
        {settings.error && !settings.data && <StateView error={settings.error} onRetry={settings.reload} what="Hedwig settings" />}
        {settings.data && <ConfigForm fields={settings.data} onSave={save} resettable="user" />}
      </Card>
    </>
  );

  return (
    <SettingsFrame active="hedwig.settings.personal" title={tr('personalSettings.yourHedwig', 'Your Hedwig')} sub="Only affects your account">
      <HedwigSettingsV2 />
      {power ? all : (
        <details style={{ maxWidth: 900 }}>
          <summary style={{ cursor: 'pointer', fontFamily: T.display, fontSize: 20, padding: '6px 0' }}>{tv('hedwig.v2.settings.all', 'All settings and usage')}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 12 }}>{all}</div>
        </details>
      )}
    </SettingsFrame>
  );
}

function Usage({ res }) {
  if (res.loading && !res.data) return <Card><Loading /></Card>;
  if (res.error && !res.data) return <Card><StateView error={res.error} onRetry={res.reload} what="Usage" compact /></Card>;
  const today = res.data?.today || [];
  const budgets = res.data?.budgets || {};
  const byFeature = new Map();
  for (const r of today) {
    const key = r.plugin_id ? 'plugins' : r.feature;
    const cur = byFeature.get(key) || { calls: 0, errors: 0, tokens: 0 };
    cur.calls += r.calls || 0;
    cur.errors += r.errors || 0;
    cur.tokens += (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    byFeature.set(key, cur);
  }
  const features = [...new Set([...Object.keys(budgets), ...byFeature.keys()])];
  return (
    <Card style={{ gap: 10, maxWidth: 900 }}>
      <SectionLabel>{tr('personalSettings.modelUsageToday', 'Model usage today')}</SectionLabel>
      {!features.length && <span style={{ fontSize: 13, color: T.muted }}>{tr('personalSettings.noModelCallsToday', 'No model calls today.')}</span>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 160px) 1fr auto', gap: '8px 14px', alignItems: 'center', fontSize: 13 }}>
        {features.map((f) => {
          const u = byFeature.get(f) || { calls: 0, errors: 0, tokens: 0 };
          const budget = budgets[f];
          const ratio = budget ? u.calls / budget : 0;
          const color = ratio >= 1 ? T.red : ratio >= 0.8 ? T.amber : T.teal;
          return (
            <div key={f} style={{ display: 'contents' }}>
              <span>{f}</span>
              {budget ? <Meter value={ratio} color={color} width="100%" label={`${f} budget used`} /> : <span style={{ fontSize: 12, color: T.muted }}>{tr('personalSettings.noBudget', 'no budget')}</span>}
              <span style={{ fontFamily: T.mono, fontSize: 12, whiteSpace: 'nowrap', color: ratio >= 1 ? T.red : T.ink }}>
                {formatCount(u.calls)}{budget ? ` / ${formatCount(budget)}` : ''}
                {u.errors ? <span style={{ color: T.red }}> · {u.errors} err</span> : null}
              </span>
            </div>
          );
        })}
      </div>
      <span style={{ fontSize: 12, color: T.muted }}>{tr('personalSettings.budgetsResetAtMidnightWhen', 'Budgets reset at midnight. When one runs out, that feature pauses; mail and everything already indexed keep working.')}</span>
    </Card>
  );
}
