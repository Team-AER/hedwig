// hedwig.settings.triage — how triage is doing, recent decisions with corrections, the
// explainer, sender rules with a preview, the pipeline, and per-user thresholds.
import { useEffect, useId, useState } from 'react';
import { hedwigApi } from '../../api.js';
import { categoryLabel, categoryTone, formatAgo, formatCount, formatPercent, senderName, stageLabel, TRIAGE_CATEGORIES } from '../helpers.js';
import { useAction, useResource } from '../hooks.js';
import Explainer, { MoveMenu, overrideTriage } from '../Explainer.jsx';
import ConfigForm from './ConfigForm.jsx';
import SettingsFrame from './SettingsFrame.jsx';
import {
  ActionError, Button, Card, Checkbox, Dot, Loading, MessageLiteRow, SectionLabel, Select, StatTile, StateView, T, Table, TileGrid, TONES,
} from '../ui.jsx';
import { tr } from '../i18n.js';

export default function TriageSettings({ props = {} }) {
  const stats = useResource('/triage/stats');
  const decisions = useResource('/triage/decisions?limit=50', { refreshOn: ['hedwig:triage-changed'] });
  const settings = useResource('/settings');
  const usage = useResource('/usage');
  const [selected, setSelected] = useState(null);
  const [rule, setRule] = useState(props.senderRule || null);

  useEffect(() => { if (props.senderRule) setRule(props.senderRule); }, [props.senderRule]);
  useEffect(() => {
    if (!selected && decisions.data?.length) setSelected(decisions.data[0]);
  }, [decisions.data, selected]);

  const [retrainOut, setRetrainOut] = useState(null);
  const retrain = useAction(async () => {
    setRetrainOut(await hedwigApi.post('/triage/retrain'));
    stats.reload({ quiet: true });
  });
  const correct = useAction(async (d, category) => {
    const info = await overrideTriage(d.message.id, category);
    const next = { ...d, triage: info || { ...d.triage, category, overridden: true } };
    decisions.setData((rows) => (rows || []).map((r) => (r.message.id === d.message.id ? next : r)));
    setSelected(next);
  });

  const s = stats.data || {};
  const triageFields = (settings.data || []).filter((f) => f.key.startsWith('triage.'));
  const pushJunk = triageFields.find((f) => f.key === 'triage.pushJunkToProvider');
  const saveSettings = async (patch) => {
    const next = await hedwigApi.patch('/settings', patch);
    if (Array.isArray(next)) settings.setData(next);
    else await settings.reload({ quiet: true });
  };

  return (
    <SettingsFrame active="hedwig.settings.triage" title={tr('triageSettings.triage', 'Triage')}
      sub={stats.data ? `One model for all your accounts · retrained nightly${s.trainedAt ? ` · last run ${formatAgo(s.trainedAt)}` : ' · not trained yet'}${s.samples != null ? ` · ${formatCount(s.samples)} labelled samples` : ''}` : undefined}
      right={<Button size="sm" busy={retrain.busy} onClick={() => retrain.run()}>{tr('triageSettings.retrainNow', 'Retrain now')}</Button>}>
      <ActionError error={retrain.error} onDismiss={retrain.clearError} />
      {retrainOut && (
        <div role="status" style={{ fontSize: 13, color: T.teal }}>
          Retrained on {formatCount(retrainOut.samples)} samples
          {retrainOut.metrics && typeof retrainOut.metrics === 'object' && ` · ${Object.entries(retrainOut.metrics).slice(0, 4).map(([k, v]) => `${k} ${typeof v === 'number' && v <= 1 ? formatPercent(v, 1) : v}`).join(' · ')}`}
        </div>
      )}

      {stats.loading && !stats.data && <Loading />}
      {stats.error && !stats.data && <StateView error={stats.error} onRetry={stats.reload} what="Triage" />}
      {stats.data && (
        <TileGrid min={180}>
          <StatTile label="Needs-you precision · 7 d" value={s.needsYouPrecision7d != null ? formatPercent(s.needsYouPrecision7d, 1) : '–'} sub="target ≥ 95%" />
          <StatTile label="Spam beyond providers" value={s.spamBeyondProvider != null ? `+${formatCount(s.spamBeyondProvider)}` : '–'} sub={`caught ${formatCount(s.spamBeyondProvider ?? 0)} the providers missed`} />
          <StatTile label="Your corrections · 30 d" value={formatCount(s.corrections30d)} sub="all used in training" />
          <StatTile label="Model calls · today" value={formatCount(s.modelCallsToday)} sub="stage 3 only for low confidence" />
        </TileGrid>
      )}

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 460px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{tr('triageSettings.recentDecisions', 'Recent decisions')}</h2>
            <span style={{ fontSize: 12, color: T.muted }}>{tr('triageSettings.selectOneToSeeWhy', 'select one to see why, or correct it')}</span>
          </div>
          {decisions.loading && !decisions.data && <Loading />}
          {decisions.error && !decisions.data && <StateView error={decisions.error} onRetry={decisions.reload} what="Recent decisions" compact />}
          {decisions.data && (
            <Table label="Recent triage decisions" rows={decisions.data} rowKey={(r) => r.message.id} selectedKey={selected?.message.id}
              onRowClick={(r) => setSelected(r)} empty="No decisions yet."
              columns={[
                { key: 'from', label: 'From', width: 'minmax(120px, 180px)', render: (r) => senderName(r.message) },
                { key: 'reason', label: 'Reason', render: (r) => <span style={{ color: T.muted }}>{r.triage?.reason_label || r.triage?.reasons?.[0]?.label || r.message.subject}</span> },
                {
                  key: 'decision', label: 'Decision', width: '150px',
                  render: (r) => (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Dot color={TONES[categoryTone(r.triage?.category)].dot} />{categoryLabel(r.triage?.category)}
                      {r.triage?.overridden && <span style={{ fontSize: 11, color: T.muted }}>{tr('triageSettings.you', '· you')}</span>}
                    </span>
                  ),
                },
                { key: 'stage', label: 'Stage', width: '90px', mono: true, muted: true, render: (r) => stageLabel(r.triage) },
              ]} />
          )}
        </div>

        <div style={{ flex: '0 1 400px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {selected && (
            <>
              <Explainer key={selected.message.id} messageId={selected.message.id} message={selected.message}
                onChanged={(info) => { if (info) setSelected((x) => ({ ...x, triage: { ...x.triage, ...info } })); decisions.reload({ quiet: true }); }}
                onSenderRule={(m) => setRule({ sender: m.from_email, messageId: m.id })} />
              <Card style={{ gap: 8 }}>
                <SectionLabel>{tr('triageSettings.correctThisDecision', 'Correct this decision')}</SectionLabel>
                <MoveMenu current={selected.triage?.category} busy={correct.busy} onPick={(cat) => correct.run(selected, cat)} />
                <ActionError error={correct.error} onDismiss={correct.clearError} />
              </Card>
            </>
          )}
          <SenderRule rule={rule} onClear={() => setRule(null)} pushJunk={pushJunk} onPushJunk={(v) => saveSettings({ 'triage.pushJunkToProvider': v })} />
          <Pipeline stats={s} budget={usage.data?.budgets?.triage} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 820 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{tr('triageSettings.yourTriageSettings', 'Your triage settings')}</h2>
        {settings.loading && !settings.data && <Loading />}
        {settings.error && !settings.data && <StateView error={settings.error} onRetry={settings.reload} what="Settings" compact />}
        {triageFields.length > 0 && <ConfigForm fields={triageFields} onSave={saveSettings} resettable="user" grouped={false} />}
      </div>
    </SettingsFrame>
  );
}

function SenderRule({ rule, onClear, pushJunk, onPushJunk }) {
  const ids = { scope: useId(), cat: useId() };
  const [scope, setScope] = useState('sender');
  const [category, setCategory] = useState('everything');
  const [preview, setPreview] = useState(null);
  const [applied, setApplied] = useState(null);
  useEffect(() => { setPreview(null); setApplied(null); }, [rule?.sender, scope, category]);
  const domain = rule?.sender?.split('@')[1];
  const body = () => ({ ...(scope === 'domain' ? { domain } : { sender: rule.sender }), category });
  const doPreview = useAction(async () => setPreview(await hedwigApi.post('/triage/sender-rule', { ...body(), preview: true })));
  const doApply = useAction(async () => {
    const out = await hedwigApi.post('/triage/sender-rule', body());
    setApplied(out?.applied ?? 0);
    window.dispatchEvent(new CustomEvent('hedwig:triage-changed'));
  });

  if (!rule?.sender) {
    return (
      <Card style={{ gap: 6 }}>
        <SectionLabel>{tr('triageSettings.senderRules', 'Sender rules')}</SectionLabel>
        <span style={{ fontSize: 13, color: T.muted }}>{tr('triageSettings.pickNeverFromThisSender', 'Pick “Never from this sender” in an explanation to file everything from a sender or domain one way. You see what it would move before it applies.')}</span>
      </Card>
    );
  }
  return (
    <Card style={{ gap: 10 }}>
      <SectionLabel right={<Button size="sm" variant="ghost" onClick={onClear}>{tr('triageSettings.close', 'Close')}</Button>}>{tr('triageSettings.beforeItApplies', 'Before it applies')}</SectionLabel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <label htmlFor={ids.scope}>{tr('triageSettings.alwaysFile', 'Always file')}</label>
        <Select id={ids.scope} value={scope} onChange={(e) => setScope(e.target.value)} style={{ height: 30 }}>
          <option value="sender">{rule.sender}</option>
          {domain && <option value="domain">anything from {domain}</option>}
        </Select>
        <label htmlFor={ids.cat}>as</label>
        <Select id={ids.cat} value={category} onChange={(e) => setCategory(e.target.value)} style={{ height: 30 }}>
          {TRIAGE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.id === 'everything' ? 'Everything (never needs me)' : c.label}</option>)}
        </Select>
      </div>
      {preview && (
        <div style={{ fontSize: 13 }}>
          This would {preview.siblings?.length ? <>also cover <strong>{preview.siblings.length} sibling sender{preview.siblings.length === 1 ? '' : 's'}</strong> ({preview.siblings.slice(0, 3).join(', ')}{preview.siblings.length > 3 ? '…' : ''}) and </> : ''}
          refile <strong>{formatCount(preview.affected)}</strong> existing message{preview.affected === 1 ? '' : 's'} as {categoryLabel(category)}. Nothing is deleted.
          {preview.sample?.length > 0 && <div style={{ marginTop: 6 }}>{preview.sample.slice(0, 4).map((m) => <MessageLiteRow key={m.id} message={m} dense />)}</div>}
        </div>
      )}
      {category === 'spam' && pushJunk && (
        <Checkbox checked={pushJunk.value} onChange={onPushJunk} label="Also tell the provider (move spam to Junk)" sub="Applies to every spam verdict, not just this rule." />
      )}
      {applied != null && <span role="status" style={{ fontSize: 13, color: T.teal }}>Applied · {formatCount(applied)} message{applied === 1 ? '' : 's'} refiled.</span>}
      <ActionError error={doPreview.error || doApply.error} onDismiss={() => { doPreview.clearError(); doApply.clearError(); }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" busy={doPreview.busy} onClick={() => doPreview.run()}>{tr('triageSettings.preview', 'Preview')}</Button>
        <Button size="sm" variant="primary" busy={doApply.busy} disabled={!preview || applied != null} onClick={() => doApply.run()}>{tr('triageSettings.applyRule', 'Apply rule')}</Button>
      </div>
    </Card>
  );
}

function stageCount(counts, n) {
  if (!counts) return null;
  if (Array.isArray(counts)) return counts[n - 1] ?? counts.find((c) => c?.stage === n)?.count ?? null;
  return counts[n] ?? counts[String(n)] ?? counts[`stage${n}`] ?? null;
}

function Pipeline({ stats, budget }) {
  const stages = [
    { n: 1, label: 'rules', bg: T.raised },
    { n: 2, label: 'your classifier', bg: T.tealTint },
    { n: 3, label: 'model', bg: T.amberTint },
  ];
  return (
    <Card style={{ gap: 8 }}>
      <SectionLabel>{tr('triageSettings.pipeline', 'Pipeline')}</SectionLabel>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
        {stages.map((st, i) => (
          <span key={st.n} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {i > 0 && <span aria-hidden="true" style={{ color: T.muted }}>→</span>}
            <span style={{ padding: '4px 8px', borderRadius: 6, background: st.bg, color: T.ink }}>
              {st.n} {st.label}
              {stageCount(stats?.stageCounts, st.n) != null && <span style={{ fontFamily: T.mono, marginLeft: 6, color: T.muted }}>{formatCount(stageCount(stats.stageCounts, st.n))}</span>}
            </span>
          </span>
        ))}
      </div>
      <div style={{ fontSize: 12, color: T.muted }}>
        Stage 3 budget: {budget != null ? `${formatCount(budget)} calls/day` : 'see Models'} · used {formatCount(stats?.modelCallsToday ?? 0)}
      </div>
    </Card>
  );
}
