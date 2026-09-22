// hedwig.settings.plugins — installed plugins with tier, permissions and surface; the enable
// dialog grants permissions one by one. Admins can also install, reload, uninstall and browse
// the plugin directory.
import { useId, useState } from 'react';
import { hedwigApi } from '../../api.js';
import { useStore } from '../../../store/index.js';
import { activationKey, disablePlugin, enablePlugin, SettingsForm } from '../../../plugins/runtimeLoader.js';
import { hashIndex, initialGrants, installSource, pluginMonogram } from '../helpers.js';
import { useAction, useIsAdmin, useResource } from '../hooks.js';
import SettingsFrame from './SettingsFrame.jsx';
import {
  ActionError, Button, Checkbox, Chip, Dialog, Empty, Loading, StateView, T, Tabs, TextInput,
} from '../ui.jsx';
import { tr } from '../i18n.js';

// Core capabilities a plugin can ask for; the dialog lists the ones a plugin did NOT request.
const CORE_PERMISSIONS = ['mail.read', 'mail.write', 'compose.draft', 'context.read', 'context.write', 'triage.hook', 'llm.summarize', 'llm.extract', 'llm.chat', 'agent.tools', 'views', 'storage', 'schedule'];
const TILE_COLORS = [T.teal, T.amber, T.ink, T.muted, T.red];

// Enable/disable go through the runtime loader, which keeps store.enabledPlugins (keyed by
// activationKey) in step and announces 'hedwig:plugins-changed'. Other changes (grants, reload,
// install, uninstall) are announced here so the loader re-syncs.
function announce(detail) {
  window.dispatchEvent(new CustomEvent('hedwig:plugins-changed', { detail }));
}

function deactivateLocally(pluginId) {
  const key = activationKey(pluginId);
  useStore.setState((s) => ({ enabledPlugins: (s.enabledPlugins || []).filter((k) => k !== key && k !== pluginId) }));
}

export default function PluginSettings() {
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState('installed');
  const [dialog, setDialog] = useState(null); // { plugin, mode: 'enable'|'grants' }
  const [confirmRemove, setConfirmRemove] = useState(null);
  const plugins = useResource('/plugins', { refreshOn: ['hedwig:plugins-changed'] });
  const directory = useResource(isAdmin && tab === 'directory' ? '/admin/plugins/directory' : null);

  const upsert = (p) => plugins.setData((list) => {
    const rows = list || [];
    return rows.some((x) => x.id === p.id) ? rows.map((x) => (x.id === p.id ? { ...x, ...p } : x)) : [...rows, p];
  });

  const disable = useAction(async (p) => {
    const out = await disablePlugin(p.id);
    upsert({ ...p, ...(out || {}), activated: out?.activated ?? false });
  });
  const reload = useAction(async (p) => {
    const out = await hedwigApi.post(`/admin/plugins/${encodeURIComponent(p.id)}/reload`);
    if (out) upsert(out);
    announce({ id: p.id, reloaded: true });
  });
  const remove = useAction(async (p) => {
    await hedwigApi.del(`/admin/plugins/${encodeURIComponent(p.id)}`);
    plugins.setData((list) => (list || []).filter((x) => x.id !== p.id));
    setConfirmRemove(null);
    deactivateLocally(p.id);
    announce({ id: p.id, activated: false, uninstalled: true });
  });
  const install = useAction(async (location) => {
    const out = await hedwigApi.post('/admin/plugins/install', { source: installSource(location), location });
    if (out) upsert(out);
    announce({ id: out?.id, installed: true });
    return out;
  });

  const list = plugins.data || [];
  const installedIds = new Set(list.map((p) => p.id));
  const opError = disable.error || reload.error || remove.error || install.error;

  return (
    <SettingsFrame active="hedwig.settings.plugins" title={tr('pluginSettings.plugins', 'Plugins')} sub="Enabled per user · permissions granted per user"
      right={isAdmin ? <InstallBox busy={install.busy} onInstall={(loc) => install.run(loc)} /> : null}>
      <Tabs label="Plugin lists" value={tab} onChange={setTab}
        tabs={[{ id: 'installed', label: 'Installed', count: plugins.data ? list.length : undefined }, ...(isAdmin ? [{ id: 'directory', label: 'Directory' }] : [])]} />
      <ActionError error={opError} onDismiss={() => { disable.clearError(); reload.clearError(); remove.clearError(); install.clearError(); }} />

      {tab === 'installed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plugins.loading && !plugins.data && <Loading />}
          {plugins.error && !plugins.data && <StateView error={plugins.error} onRetry={plugins.reload} what="Plugins" />}
          {plugins.data && !list.length && <Empty title={tr('pluginSettings.noPluginsInstalled', 'No plugins installed')}>{isAdmin ? 'Install one from a git URL or directory above, or browse the directory.' : 'Ask an admin to install plugins.'}</Empty>}
          {list.map((p) => (
            <PluginRow key={p.id} p={p} isAdmin={isAdmin}
              onEnable={() => setDialog({ plugin: p, mode: 'enable' })}
              onGrants={() => setDialog({ plugin: p, mode: 'grants' })}
              onDisable={() => disable.run(p)} disabling={disable.busy}
              onReload={() => reload.run(p)} reloading={reload.busy}
              removing={confirmRemove === p.id} onRemove={() => (confirmRemove === p.id ? remove.run(p) : setConfirmRemove(p.id))} />
          ))}
          <p style={{ margin: 0, fontSize: 12, color: T.muted }}>
            Plugins reach Hedwig only through the capability facade. A plugin cannot open the network unless its manifest lists the host and you granted it; revoking a grant stops its jobs and routes immediately.
          </p>
        </div>
      )}

      {tab === 'directory' && isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {directory.loading && !directory.data && <Loading />}
          {directory.error && !directory.data && <StateView error={directory.error} onRetry={directory.reload} what="The plugin directory" />}
          {directory.data && !directory.data.length && <Empty title={tr('pluginSettings.theDirectoryIsEmpty', 'The directory is empty')} />}
          {(directory.data || []).map((d) => (
            <div key={d.id} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 16px', borderRadius: 10, background: T.surface, border: `1px solid ${T.border}` }}>
              <Tile name={d.name} id={d.id} />
              <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{d.name}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{d.id} · {d.version}</span>
                </div>
                <div style={{ fontSize: 13, color: T.muted }}>{d.description}</div>
                <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.source} · {d.location}</div>
              </div>
              {installedIds.has(d.id)
                ? <Chip tone="teal" size="md">{tr('pluginSettings.installed', 'Installed')}</Chip>
                : <Button size="sm" busy={install.busy} onClick={() => install.run(d.location)}>{tr('pluginSettings.install', 'Install')}</Button>}
            </div>
          ))}
        </div>
      )}

      {dialog && (
        <GrantDialog plugin={dialog.plugin} mode={dialog.mode} onClose={() => setDialog(null)}
          onDone={(p) => { upsert(p); if (dialog.mode === 'grants') announce({ id: p.id, grants: true }); setDialog(null); }} />
      )}
    </SettingsFrame>
  );
}

function Tile({ name, id, size = 36 }) {
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: 9, background: TILE_COLORS[hashIndex(id, TILE_COLORS.length)], color: T.surface, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13,
    }}>{pluginMonogram(name, id)}</span>
  );
}

function surfaceOf(p) {
  const bits = [];
  if (p.views?.length) bits.push(p.views.length === 1 ? 'view' : `${p.views.length} views`);
  if (p.hooks?.length) bits.push(...p.hooks.slice(0, 2));
  if (p.tools?.length) bits.push(`${p.tools.length} tool${p.tools.length === 1 ? '' : 's'}`);
  if (p.commands?.length) bits.push('commands');
  if (!bits.length && p.hasFrontend) bits.push('frontend');
  return bits.join(' · ');
}

function PluginRow({ p, isAdmin, onEnable, onDisable, onGrants, onReload, onRemove, disabling, reloading, removing }) {
  const [showSettings, setShowSettings] = useState(false);
  const hasSettings = p.activated && p.settingsSchema && (Array.isArray(p.settingsSchema) ? p.settingsSchema.length : Object.keys(p.settingsSchema).length);
  const failed = p.status === 'error' || p.error;
  const state = failed ? { text: 'Error', tone: 'red' } : p.activated ? { text: 'Enabled', tone: 'ink' } : { text: 'Off', tone: 'neutral' };
  const perms = (p.permissions || []).map((x) => x.name).join(' · ') || 'none';
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 16px', borderRadius: 10, background: T.surface, border: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
      <Tile name={p.name} id={p.id} />
      <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{p.name}</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{p.id} · {p.version}</span>
          {p.tier != null && <Chip tone={String(p.tier) === '1' ? 'teal' : 'neutral'}>tier {p.tier}</Chip>}
        </div>
        {p.description && <div style={{ fontSize: 13, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description}</div>}
        <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>{perms}</div>
        {failed && <div role="alert" style={{ fontSize: 12, color: T.red }}>{p.error || 'The plugin failed to load.'}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: T.muted }}>{surfaceOf(p)}</span>
        <Chip tone={state.tone} size="md">{state.text}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
        {p.activated
          ? <>
            {hasSettings ? <Button size="sm" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>{tr('pluginSettings.settings', 'Settings')}</Button> : null}
            {p.permissions?.length > 0 && <Button size="sm" onClick={onGrants}>{tr('pluginSettings.permissions', 'Permissions')}</Button>}
            <Button size="sm" busy={disabling} onClick={onDisable}>{tr('pluginSettings.disable', 'Disable')}</Button>
          </>
          : <Button size="sm" variant="primary" onClick={onEnable} disabled={Boolean(failed)}>{tr('pluginSettings.enable', 'Enable…')}</Button>}
        {isAdmin && <Button size="sm" variant="ghost" busy={reloading} onClick={onReload}>{tr('pluginSettings.reload', 'Reload')}</Button>}
        {isAdmin && <Button size="sm" variant="danger" onClick={onRemove}>{removing ? 'Uninstall for everyone?' : 'Uninstall'}</Button>}
      </div>
      {showSettings && hasSettings ? (
        <div style={{ flexBasis: '100%', paddingTop: 10, borderTop: `1px solid ${T.raised}` }}>
          <SettingsForm pluginId={p.id} schema={p.settingsSchema} />
        </div>
      ) : null}
    </div>
  );
}

function GrantDialog({ plugin: p, mode, onClose, onDone }) {
  const perms = p.permissions || [];
  const [grants, setGrants] = useState(() => (mode === 'grants' ? perms.filter((x) => x.granted).map((x) => x.name) : initialGrants(perms)));
  const submit = useAction(async () => {
    const out = mode === 'enable'
      ? await enablePlugin(p.id, grants)
      : await hedwigApi.patch(`/plugins/${encodeURIComponent(p.id)}/grants`, { grants });
    onDone({ ...p, ...(out || {}), activated: out?.activated ?? (mode === 'enable' ? true : p.activated) });
  });
  const requested = new Set(perms.map((x) => x.name));
  const notRequested = CORE_PERMISSIONS.filter((x) => !requested.has(x));
  const toggle = (name, on) => setGrants((g) => (on ? [...new Set([...g, name])] : g.filter((x) => x !== name)));
  return (
    <Dialog open onClose={onClose} width={400}
      title={mode === 'enable' ? `Enable ${p.name}?` : `Permissions for ${p.name}`}
      subtitle={`${p.id} · ${p.version}${p.tier != null ? ` · tier ${p.tier}` : ''}`}
      icon={<Tile name={p.name} id={p.id} size={40} />}
      footer={<>
        <Button onClick={onClose}>{tr('pluginSettings.cancel', 'Cancel')}</Button>
        <Button variant="primary" busy={submit.busy} onClick={() => submit.run()}>
          {mode === 'enable' ? `Enable with ${grants.length} grant${grants.length === 1 ? '' : 's'}` : 'Save grants'}
        </Button>
      </>}>
      {p.description && <p style={{ margin: 0, fontSize: 13, color: T.muted }}>{p.description}{perms.length ? ' It asks for:' : ''}</p>}
      {perms.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {perms.map((x) => (
            <Checkbox key={x.name} mono checked={grants.includes(x.name)} onChange={(on) => toggle(x.name, on)} label={x.name}
              sub={`${x.optional ? 'Optional · ' : ''}${x.description || ''}${x.optional && !x.granted ? ' · off by default' : ''}`} />
          ))}
        </div>
      ) : <p style={{ margin: 0, fontSize: 13 }}>{tr('pluginSettings.itAsksForNoPermissions', 'It asks for no permissions.')}</p>}
      {notRequested.length > 0 && (
        <div style={{ fontSize: 12, color: T.muted, padding: '10px 12px', borderRadius: 8, background: T.ground }}>
          Not requested: <span style={{ fontFamily: T.mono }}>{notRequested.join(' · ')}</span>. You can revoke any grant later; revoking stops its jobs and routes immediately.
        </div>
      )}
      <ActionError error={submit.error} onDismiss={submit.clearError} />
    </Dialog>
  );
}

function InstallBox({ onInstall, busy }) {
  const id = useId();
  const [loc, setLoc] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (loc.trim()) onInstall(loc.trim())?.then?.((out) => { if (out) setLoc(''); }); }}
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label htmlFor={id} style={{ fontSize: 12, color: T.muted }}>{tr('pluginSettings.addFrom', 'Add from')}</label>
      <TextInput id={id} value={loc} onChange={(e) => setLoc(e.target.value)} placeholder={tr('pluginSettings.gitUrlOrPluginDirectory', 'git URL or plugin directory')} style={{ width: 280, height: 32 }} />
      <Button variant="primary" type="submit" busy={busy} disabled={!loc.trim()}>{tr('pluginSettings.install', 'Install')}</Button>
    </form>
  );
}
