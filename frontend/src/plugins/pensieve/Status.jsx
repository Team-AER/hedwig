// Pensieve bridge (view 'aer.pensieve.status'): connection settings, sync status and recent sends.
import { useState } from 'react';
import { pluginApi, SettingsForm } from '../runtimeLoader.js';
import { openMessage, useAction, useResource } from '../../hedwig/views/hooks.js';
import {
  ActionError, Button, Card, Chip, Loading, SectionLabel, StateView, StatTile, T, Table, TileGrid, Title, ViewFrame,
} from '../../hedwig/views/ui.jsx';
import { tr } from '../../hedwig/views/i18n.js';

const ID = 'aer.pensieve';
const papi = pluginApi(ID);
const TONE = { saved: 'teal', no_link: 'neutral', waiting_body: 'neutral', rejected: 'amber', auth_error: 'red', not_permitted: 'red', error: 'red' };
const LABEL = () => ({
  saved: tr('plugins.pensieve.saved', 'Saved'), no_link: tr('plugins.pensieve.noLink', 'No web link'), waiting_body: tr('plugins.pensieve.waiting', 'Waiting'),
  rejected: tr('plugins.pensieve.rejected', 'Rejected'), auth_error: tr('plugins.pensieve.badToken', 'Bad token'),
  not_permitted: tr('plugins.pensieve.notAllowed', 'Not allowed'), error: tr('plugins.pensieve.failed', 'Failed'),
});

export default function Status() {
  const status = useResource(`/p/${ID}/status`, { refreshOn: ['hedwig:pensieve-changed'] });
  const [test, setTest] = useState(null);
  const [sync, setSync] = useState(null);
  const changed = () => window.dispatchEvent(new CustomEvent('hedwig:pensieve-changed'));
  const runTest = useAction(async () => setTest(await papi.post('/test', {})));
  const runSync = useAction(async () => { setSync(await papi.post('/sync', { days: 3 })); changed(); });

  if (status.error && !status.data) return <ViewFrame label={tr('plugins.pensieve.title', 'Pensieve bridge')}><StateView error={status.error} onRetry={status.reload} what={tr('plugins.pensieve.title', 'Pensieve bridge')} /></ViewFrame>;
  if (!status.data) return <ViewFrame label={tr('plugins.pensieve.title', 'Pensieve bridge')}><Loading /></ViewFrame>;
  const s = status.data;
  const labels = LABEL();

  const columns = [
    { key: 'at', label: tr('plugins.pensieve.when', 'When'), width: '150px', mono: true, render: (r) => (r.at ? new Date(r.at).toLocaleString() : '') },
    { key: 'subject', label: tr('plugins.pensieve.newsletter', 'Newsletter'), width: 'minmax(0, 2fr)', render: (r) => r.subject || r.from },
    { key: 'status', label: tr('plugins.pensieve.status', 'Status'), width: '120px', render: (r) => <Chip tone={TONE[r.status] || 'neutral'} title={r.error || undefined}>{labels[r.status] || r.status}</Chip> },
    {
      key: 'open', label: '', width: '130px', align: 'right',
      render: (r) => (r.open ? <a href={r.open} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: T.tealText, fontSize: 12 }}>{tr('plugins.pensieve.open', 'Open in Pensieve')}</a> : null),
    },
  ];

  return (
    <ViewFrame label={tr('plugins.pensieve.title', 'Pensieve bridge')}>
      <Title sub={s.configured ? s.baseUrl : tr('plugins.pensieve.notConnected', 'Not connected')} right={(
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => runTest.run()} busy={runTest.busy} disabled={!s.configured}>{tr('plugins.pensieve.test', 'Test connection')}</Button>
          <Button onClick={() => runSync.run()} busy={runSync.busy} disabled={!s.configured}>{tr('plugins.pensieve.sync', 'Send recent newsletters')}</Button>
        </div>
      )}>{tr('plugins.pensieve.title', 'Pensieve bridge')}</Title>
      <ActionError error={runTest.error || runSync.error} />
      {test && <div role="status" style={{ fontSize: 13, marginTop: 8, color: test.ok ? T.tealText : T.red }}>{test.ok ? tr('plugins.pensieve.connected', 'Connected: Pensieve accepted the token.') : test.error}</div>}
      {sync && <div role="status" style={{ fontSize: 13, marginTop: 8, color: T.muted }}>{tr('plugins.pensieve.synced', 'Checked {{checked}} messages, sent {{sent}}.', sync)}</div>}

      <div style={{ margin: '16px 0' }}>
        <TileGrid>
          <StatTile label={tr('plugins.pensieve.saved', 'Saved')} value={s.status.saved || 0} tone="teal" />
          <StatTile label={tr('plugins.pensieve.skipped', 'Skipped (no web link)')} value={s.status.skipped || 0} />
          <StatTile label={tr('plugins.pensieve.failed', 'Failed')} value={s.status.failed || 0} tone={s.status.failed ? 'red' : undefined} sub={s.status.lastError || undefined} />
        </TileGrid>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>{tr('plugins.pensieve.connection', 'Connection')}</SectionLabel>
        <p style={{ fontSize: 13, color: T.muted, margin: 0 }}>
          {tr('plugins.pensieve.help', 'Newsletters go to Pensieve as saved links through its API. Create a token in Pensieve under Manage > Saving and archive. Issues without a web version cannot be saved as links and are skipped.')}
        </p>
        <SettingsForm pluginId={ID} onSaved={changed} />
      </Card>

      <SectionLabel style={{ marginBottom: 8 }}>{tr('plugins.pensieve.recent', 'Recent')}</SectionLabel>
      <Table label={tr('plugins.pensieve.recent', 'Recent')} columns={columns} rows={s.recent} rowKey={(r) => r.messageId}
        onRowClick={(r) => openMessage(r.messageId)} empty={tr('plugins.pensieve.nothing', 'Nothing sent yet.')} />
    </ViewFrame>
  );
}
