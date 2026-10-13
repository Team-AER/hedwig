// hedwig.settings.connectors — Hedwig as a connector for Claude, ChatGPT and other MCP clients: the
// URL to add, how to add it in each app, the apps connected now (what they may do, when they last
// did something, disconnect), and the changes they made. The server side is backend/src/hedwig/mcp/.
import { useState } from 'react';
import { hedwigApi } from '../../api.js';
import { useAction, useResource } from '../hooks.js';
import SettingsFrame from './SettingsFrame.jsx';
import { ActionError, Button, Chip, Empty, Loading, RelativeTime, SectionLabel, StateView, T } from '../ui.jsx';
import { tv, tvn } from '../../v2/i18n.js';

// Product names, the same in every language.
const APPS = { claude: 'Claude', chatgpt: 'ChatGPT', claudeCode: 'Claude Code' };

function CopyField({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the field stays selectable */ }
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input readOnly value={value} aria-label={tv('hedwig.connectors.url', 'Connector URL')} onFocus={(e) => e.target.select()}
        style={{
          flex: '1 1 auto', minWidth: 0, boxSizing: 'border-box', height: 32, padding: '0 10px', borderRadius: 8,
          border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: T.mono, fontSize: 13,
        }} />
      <Button variant="primary" onClick={copy} style={{ minWidth: 72 }}>{copied ? tv('hedwig.connectors.copied', 'Copied') : tv('common.copy', 'Copy')}</Button>
    </div>
  );
}

function Step({ app, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 10, background: T.field, border: `1px solid ${T.line}`, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>{app}</span>
      <span style={{ fontSize: 13, color: T.muted, lineHeight: '18px' }}>{children}</span>
    </div>
  );
}

function ConnectionRow({ c, onDisconnect, busy }) {
  const [confirm, setConfirm] = useState(false);
  const organises = c.scopes.includes('mail.write');
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 10, background: T.field, border: `1px solid ${T.line}` }}>
      <span aria-hidden="true" style={{
        width: 36, height: 36, borderRadius: 9, background: T.raised, border: `1px solid ${T.line}`, color: T.ink, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 15,
      }}>{(c.name || '?').trim()[0]?.toUpperCase() || '?'}</span>
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: T.ink, overflowWrap: 'anywhere' }}>{c.name}</span>
          {c.host && <span style={{ fontSize: 12, color: T.muted }}>{c.host}</span>}
          <Chip tone={organises ? 'teal' : 'neutral'}>{organises ? tv('hedwig.connectors.canOrganize', 'Reads and organises') : tv('hedwig.connectors.canRead', 'Reads only')}</Chip>
        </div>
        <div style={{ fontSize: 12, color: T.muted, display: 'flex', gap: 6, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
          <span>{tv('hedwig.connectors.connectedAt', 'Connected')} <RelativeTime value={c.connectedAt} /></span>
          <span aria-hidden="true">·</span>
          {c.lastUsedAt
            ? <span>{tv('hedwig.connectors.lastUsed', 'Last used')} <RelativeTime value={c.lastUsedAt} mode="ago" /></span>
            : <span>{tv('hedwig.connectors.notUsed', 'Not used yet')}</span>}
          {c.calls > 0 && <><span aria-hidden="true">·</span><span>{tvn(c.calls, ['hedwig.connectors.callsOne', '1 request'], ['hedwig.connectors.callsMany', '{{n}} requests'])}</span></>}
        </div>
      </div>
      <Button size="sm" variant="danger" busy={busy} style={{ flexShrink: 0 }} onClick={() => (confirm ? onDisconnect(c) : setConfirm(true))} onBlur={() => setConfirm(false)}>
        {confirm ? tv('hedwig.connectors.confirmDisconnect', 'Disconnect now?') : tv('hedwig.connectors.disconnect', 'Disconnect')}
      </Button>
    </div>
  );
}

export default function ConnectorSettings() {
  const res = useResource('/mcp/connections');
  const disconnect = useAction(async (c) => {
    await hedwigApi.del(`/mcp/connections/${encodeURIComponent(c.id)}`);
    res.setData((d) => (d ? { ...d, connections: d.connections.filter((x) => x.id !== c.id) } : d));
  });
  const data = res.data;
  const url = data?.endpoint || `${window.location.origin}/mcp`;

  return (
    <SettingsFrame active="hedwig.settings.connectors" title={tv('hedwig.connectors.title', 'Connectors')}
      sub={tv('hedwig.connectors.sub', 'Use your mail from Claude, ChatGPT and other AI apps')}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-labelledby="connectors-add">
        <SectionLabel><span id="connectors-add">{tv('hedwig.connectors.addTitle', 'Add Hedwig to an app')}</span></SectionLabel>
        <CopyField value={url} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          <Step app={APPS.claude}>{tv('hedwig.connectors.stepsClaude', 'Settings → Connectors → Add custom connector. Paste the URL, then choose Connect and allow it here.')}</Step>
          <Step app={APPS.chatgpt}>{tv('hedwig.connectors.stepsChatgpt', 'Settings → Apps & Connectors → Advanced settings: turn on Developer mode. Then Create, paste the URL, choose OAuth and allow it here.')}</Step>
          <Step app={APPS.claudeCode}>
            {tv('hedwig.connectors.stepsCli', 'Run this, then /mcp to sign in:')}
            <code style={{ display: 'block', marginTop: 4, fontFamily: T.mono, fontSize: 12, color: T.ink, overflowWrap: 'anywhere' }}>claude mcp add --transport http hedwig {url}</code>
          </Step>
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="connectors-connected">
        <SectionLabel><span id="connectors-connected">{tv('hedwig.connectors.connected', 'Connected apps')}</span></SectionLabel>
        <ActionError error={disconnect.error} onDismiss={disconnect.clearError} />
        {res.loading && !data && <Loading />}
        {res.error && !data && <StateView error={res.error} onRetry={res.reload} what={tv('hedwig.connectors.connected', 'Connected apps')} />}
        {data && !data.connections.length && (
          <Empty title={tv('hedwig.connectors.none', 'No apps connected yet')}>
            {tv('hedwig.connectors.noneSub', 'Add the URL above in Claude or ChatGPT. You will approve the connection here in Hedwig.')}
          </Empty>
        )}
        {(data?.connections || []).map((c) => (
          <ConnectionRow key={c.id} c={c} busy={disconnect.busy} onDisconnect={(x) => disconnect.run(x)} />
        ))}
      </section>

      {data?.activity?.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-labelledby="connectors-activity">
          <SectionLabel><span id="connectors-activity">{tv('hedwig.connectors.activity', 'Recent changes by connected apps')}</span></SectionLabel>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {data.activity.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '7px 2px', borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
                <span style={{ color: T.muted, flexShrink: 0 }}>{a.app}</span>
                <span style={{ color: a.ok ? T.ink : T.red, flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{a.summary || a.tool}</span>
                {!a.ok && <Chip tone="red">{tv('hedwig.connectors.failed', 'Failed')}</Chip>}
                <span style={{ color: T.muted, fontSize: 12, flexShrink: 0 }}><RelativeTime value={a.at} mode="ago" /></span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p style={{ margin: 0, fontSize: 12, color: T.muted, lineHeight: '17px' }}>
        {tv('hedwig.connectors.safety', 'Connected apps can never send or delete mail; replies are saved as drafts for you to send. Emails are written by other people and an app may be misled by what one says, so disconnect apps you no longer use.')}
      </p>
    </SettingsFrame>
  );
}
