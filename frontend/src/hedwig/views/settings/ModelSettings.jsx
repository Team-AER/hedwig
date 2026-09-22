// hedwig.settings.models (admin) — every Hedwig knob from GET /admin/config, model tests, the
// model catalog, and the health of the pipeline, job queue and model calls.
import { useState } from 'react';
import { hedwigApi } from '../../api.js';
import { formatCount, formatPercent } from '../helpers.js';
import { useAction, useIsAdmin, useResource } from '../hooks.js';
import ConfigForm from './ConfigForm.jsx';
import SettingsFrame from './SettingsFrame.jsx';
import {
  ActionError, Button, Card, Chip, Empty, Loading, Meter, SectionLabel, StatTile, StateView, T, Table, TileGrid,
} from '../ui.jsx';
import { tr } from '../i18n.js';

export default function ModelSettings() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <SettingsFrame active="hedwig.settings.models" title={tr('modelSettings.models', 'Models')}>
        <Empty title={tr('modelSettings.adminsOnly', 'Admins only')}>{tr('modelSettings.modelGatewayEmbeddingsAndPipeline', 'Model gateway, embeddings and pipeline settings are managed by an administrator. Your own settings are under Personal.')}</Empty>
      </SettingsFrame>
    );
  }
  return <AdminModels />;
}

function AdminModels() {
  const config = useResource('/admin/config');
  const [refreshCatalog, setRefreshCatalog] = useState(0);
  const catalog = useResource(`/admin/catalog${refreshCatalog ? `?refresh=1&n=${refreshCatalog}` : ''}`);
  const save = async (patch) => {
    const next = await hedwigApi.patch('/admin/config', patch);
    if (Array.isArray(next)) config.setData(next);
    else await config.reload({ quiet: true });
  };
  const models = catalog.data?.models || [];

  return (
    <SettingsFrame active="hedwig.settings.models" title={tr('modelSettings.modelsAndPipeline', 'Models and pipeline')} sub="Server-wide · admin overrides beat environment variables, which beat defaults">
      <ModelTests />
      <Health />
      <Card style={{ gap: 12 }}>
        <SectionLabel right={(
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12, color: T.muted }}>
            {catalog.loading ? 'loading catalog…' : `${models.length} model${models.length === 1 ? '' : 's'} in catalog`}
            <Button size="sm" variant="ghost" onClick={() => setRefreshCatalog((n) => n + 1)}>{tr('modelSettings.refreshCatalog', 'Refresh catalog')}</Button>
          </span>
        )}>{tr('modelSettings.configuration', 'Configuration')}</SectionLabel>
        {catalog.error && <StateView error={catalog.error} onRetry={catalog.reload} what="The model catalog" compact />}
        {config.loading && !config.data && <Loading />}
        {config.error && !config.data && <StateView error={config.error} onRetry={config.reload} what="Hedwig configuration" />}
        {config.data && <ConfigForm fields={config.data} onSave={save} resettable="admin" catalog={models} showEnv keyLabel />}
      </Card>
    </SettingsFrame>
  );
}

function ModelTests() {
  const [results, setResults] = useState({});
  const test = useAction(async (kind) => {
    setResults((r) => ({ ...r, [kind]: { pending: true } }));
    const out = kind === 'embeddings'
      ? await hedwigApi.post('/admin/test-embeddings')
      : await hedwigApi.post('/admin/test-llm', { role: kind });
    setResults((r) => ({ ...r, [kind]: out }));
  });
  const rows = [['fast', 'Fast model'], ['long', 'Long model'], ['agent', 'Agent model'], ['embeddings', 'Embeddings']];
  return (
    <Card style={{ gap: 10 }}>
      <SectionLabel>{tr('modelSettings.testTheGateway', 'Test the gateway')}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {rows.map(([kind, label]) => {
          const r = results[kind];
          return (
            <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 8, background: T.ground }}>
              <Button size="sm" busy={r?.pending} onClick={() => test.run(kind)} style={{ alignSelf: 'flex-start' }}>
                {kind === 'embeddings' ? 'Test embeddings' : `Test ${label.toLowerCase()}`}
              </Button>
              {r && !r.pending && (
                <span role="status" style={{ fontSize: 12, color: r.ok ? T.teal : T.red, overflowWrap: 'anywhere' }}>
                  {r.ok ? '✓ ' : '✗ '}
                  {r.ok
                    ? [r.model, r.dims ? `${r.dims} dims` : null, r.reply ? `“${String(r.reply).trim().slice(0, 30)}”` : null, r.ms != null ? `${r.ms} ms` : null].filter(Boolean).join(' · ')
                    : `${r.error || 'failed'}${r.ms != null ? ` · ${r.ms} ms` : ''}`}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <ActionError error={test.error} onDismiss={test.clearError} />
    </Card>
  );
}

function Health() {
  const health = useResource('/admin/health', { pollMs: 15_000 });
  const [confirmAll, setConfirmAll] = useState(false);
  const reindex = useAction(async (scope) => {
    await hedwigApi.post('/admin/reindex', { scope });
    setConfirmAll(false);
    await health.reload({ quiet: true });
  });
  const retry = useAction(async () => {
    const out = await hedwigApi.post('/admin/jobs/retry-failed');
    await health.reload({ quiet: true });
    return out;
  });
  const [retried, setRetried] = useState(null);

  if (health.loading && !health.data) return <Card><Loading label="Checking health…" /></Card>;
  if (health.error && !health.data) return <Card><StateView error={health.error} onRetry={health.reload} what="Health" compact /></Card>;
  const h = health.data || {};
  const p = h.pipeline || {};
  const seen = Number(p.seen) || 0;
  const frac = (n) => (seen ? (Number(n) || 0) / seen : 0);
  const jobs = h.jobs || [];
  const failed = jobs.reduce((a, j) => a + (j.failed_24h || 0), 0);

  return (
    <Card style={{ gap: 12 }}>
      <SectionLabel right={(
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <Button size="sm" busy={retry.busy} disabled={!failed} onClick={async () => setRetried(await retry.run())}>{tr('modelSettings.retryFailedJobs', 'Retry failed jobs')}</Button>
          <Button size="sm" busy={reindex.busy && !confirmAll} onClick={() => reindex.run('backfill')}>{tr('modelSettings.restartBackfill', 'Restart backfill')}</Button>
          {confirmAll
            ? <Button size="sm" variant="danger" busy={reindex.busy} onClick={() => reindex.run('all')}>{tr('modelSettings.rebuildEverythingDerivedDataOnly', 'Rebuild everything? Derived data only')}</Button>
            : <Button size="sm" variant="danger" onClick={() => setConfirmAll(true)}>{tr('modelSettings.reindexAll', 'Reindex all…')}</Button>}
        </span>
      )}>{tr('modelSettings.health', 'Health')}</SectionLabel>
      <ActionError error={reindex.error || retry.error} onDismiss={() => { reindex.clearError(); retry.clearError(); }} />
      {retried && <span role="status" style={{ fontSize: 12, color: T.teal }}>Retrying {formatCount(retried.retried)} jobs.</span>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <Chip tone={h.status?.ready ? 'teal' : 'red'} size="md">{h.status?.ready ? 'Ready' : 'Not ready'}</Chip>
        {h.status?.error && <span role="alert" style={{ color: T.red }}>{h.status.error}</span>}
        {h.status?.startedAt && <span style={{ color: T.muted, fontSize: 12 }}>started {new Date(h.status.startedAt).toLocaleString()}</span>}
      </div>

      <TileGrid min={150}>
        <StatTile label="Messages seen" value={formatCount(p.seen)} sub={p.backfill ? (p.backfill.done ? 'backfill done' : 'backfilling…') : undefined} />
        {[['indexed', 'Indexed'], ['embedded', 'Embedded'], ['triaged', 'Triaged'], ['extracted', 'Extracted']].map(([k, label]) => (
          <StatTile key={k} label={label} value={formatCount(p[k])} sub={seen ? formatPercent(frac(p[k])) : undefined}>
            <Meter value={frac(p[k])} width="100%" label={`${label} progress`} />
          </StatTile>
        ))}
        <StatTile label="Pipeline errors" value={formatCount(p.errors)} tone={p.errors ? 'red' : undefined} />
      </TileGrid>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>{tr('modelSettings.jobQueue24H', 'Job queue · 24 h')}</SectionLabel>
          <Table label="Job queue" rows={jobs} rowKey={(r) => r.kind} empty="No jobs in the last week."
            columns={[
              { key: 'kind', label: 'Kind', mono: true },
              { key: 'pending', label: 'Queued', width: '60px', mono: true, align: 'right' },
              { key: 'running', label: 'Run', width: '44px', mono: true, align: 'right' },
              { key: 'done_24h', label: 'Done', width: '56px', mono: true, align: 'right' },
              { key: 'failed_24h', label: 'Failed', width: '56px', mono: true, align: 'right', render: (r) => <span style={{ color: r.failed_24h ? T.red : undefined }} title={r.last_error || undefined}>{r.failed_24h}</span> },
            ]} />
          {jobs.filter((j) => j.last_error).slice(0, 3).map((j) => (
            <div key={j.kind} style={{ fontSize: 12, color: T.red, overflowWrap: 'anywhere' }}><span style={{ fontFamily: T.mono }}>{j.kind}</span>: {j.last_error}</div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>{tr('modelSettings.modelCalls24H', 'Model calls · 24 h')}</SectionLabel>
          <Table label="Model calls in the last 24 hours" rows={h.aiCalls24h || []} rowKey={(r) => r.feature} empty="No model calls in the last day."
            columns={[
              { key: 'feature', label: 'Feature' },
              { key: 'calls', label: 'Calls', width: '64px', mono: true, align: 'right', render: (r) => formatCount(r.calls) },
              { key: 'errors', label: 'Errors', width: '60px', mono: true, align: 'right', render: (r) => <span style={{ color: r.errors ? T.red : undefined }}>{r.errors}</span> },
              { key: 'avg_latency_ms', label: 'Avg ms', width: '64px', mono: true, align: 'right', render: (r) => formatCount(r.avg_latency_ms) },
            ]} />
          {(h.steps?.length > 0 || h.schedules?.length > 0) && (
            <div style={{ fontSize: 12, color: T.muted }}>
              {h.steps?.length > 0 && <div>Steps: <span style={{ fontFamily: T.mono }}>{h.steps.map((s) => s.name).join(' → ')}</span></div>}
              {h.schedules?.length > 0 && <div>Schedules: <span style={{ fontFamily: T.mono }}>{h.schedules.map((s) => s.name).join(' · ')}</span></div>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
