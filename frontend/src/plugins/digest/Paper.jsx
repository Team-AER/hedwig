// The daily paper (view 'aer.digest.paper'): one row per newsletter issue with a one-line summary.
import { useState } from 'react';
import { pluginApi, SettingsForm } from '../runtimeLoader.js';
import { openMessage, useAction, useResource } from '../../hedwig/views/hooks.js';
import {
  ActionError, Button, Empty, Loading, Select, StateView, T, Title, ViewFrame,
} from '../../hedwig/views/ui.jsx';
import { tr } from '../../hedwig/views/i18n.js';

const ID = 'aer.digest';
const papi = pluginApi(ID);

function longDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date || '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export default function Paper() {
  const [date, setDate] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const paper = useResource(`/p/${ID}/paper${date ? `?date=${date}` : ''}`, { refreshOn: ['hedwig:paper-built'] });
  const dates = useResource(`/p/${ID}/papers`, { refreshOn: ['hedwig:paper-built'] });
  const build = useAction(async () => {
    const out = await papi.post('/paper/build', {});
    setDate('');
    window.dispatchEvent(new CustomEvent('hedwig:paper-built'));
    return out;
  });

  if (paper.error && !paper.data) return <ViewFrame label={tr('plugins.digest.title', 'The daily paper')}><StateView error={paper.error} onRetry={paper.reload} what={tr('plugins.digest.title', 'The daily paper')} /></ViewFrame>;
  const p = paper.data?.paper;
  const shownDate = paper.data?.date;

  return (
    <ViewFrame label={tr('plugins.digest.title', 'The daily paper')}>
      <Title sub={shownDate ? longDate(shownDate) : null} right={(
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {dates.data?.dates?.length > 0 && (
            <>
              <label htmlFor="digest-date" style={{ fontSize: 12, color: T.muted }}>{tr('plugins.digest.edition', 'Edition')}</label>
              <Select id="digest-date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 150 }}>
                <option value="">{tr('plugins.digest.today', 'Today')}</option>
                {dates.data.dates.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            </>
          )}
          <Button onClick={() => build.run()} busy={build.busy}>{tr('plugins.digest.build', 'Write today’s paper now')}</Button>
          <Button variant="ghost" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>{tr('plugins.digest.settings', 'Settings')}</Button>
        </div>
      )}>{tr('plugins.digest.title', 'The daily paper')}</Title>
      <ActionError error={build.error} />
      {showSettings && (
        <div style={{ margin: '12px 0', padding: '12px 16px', border: `1px solid ${T.border}`, borderRadius: 10 }}>
          <SettingsForm pluginId={ID} />
        </div>
      )}
      {paper.loading && !paper.data ? <Loading /> : !p ? (
        <Empty title={tr('plugins.digest.emptyTitle', 'No paper yet')}>
          {tr('plugins.digest.empty', 'The paper is written every morning from the newsletters that arrived since the last one. You can also write today’s now.')}
        </Empty>
      ) : !p.items.length ? (
        <Empty title={tr('plugins.digest.quietTitle', 'A quiet day')}>{tr('plugins.digest.quiet', 'No newsletters arrived since the last paper.')}</Empty>
      ) : (
        <ol style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {p.items.map((it) => (
            <li key={it.messageId}>
              <button type="button" className="hw-row" onClick={() => openMessage(it.messageId)} style={{
                width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: `1px solid ${T.raised}`,
                padding: '12px 4px', cursor: 'pointer', color: T.ink, font: 'inherit', display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 16,
              }}>
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.from_name || it.from_email}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontFamily: T.display, fontSize: 16 }}>{it.subject || tr('plugins.digest.noSubject', '(no subject)')}</span>
                  <span style={{ display: 'block', fontSize: 13, color: T.muted, marginTop: 2 }}>{it.summary}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {p && <div style={{ fontSize: 11, color: T.muted, marginTop: 12, fontFamily: T.mono }}>{tr('plugins.digest.written', 'Written {{when}}', { when: new Date(p.builtAt).toLocaleString() })}</div>}
    </ViewFrame>
  );
}
