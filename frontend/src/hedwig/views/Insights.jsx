// hedwig.insights — volume, response times, top senders, what is owed, insight cards and the
// latest briefing.
import { useEffect, useRef, useState } from 'react';
import { hedwigApi } from '../api.js';
import { formatAgo, formatCount, formatDay, formatHours, formatPercent, sparkPoints } from './helpers.js';
import { openMessage, useAction, useResource } from './hooks.js';
import {
  AccountDot, ActionError, Button, Card, Chip, ColumnChart, IconButton, Loading, Markdown, Meter, SectionLabel,
  Sparkline, StatTile, StateView, T, Table, TileGrid, Title,
} from './ui.jsx';
import { tr } from './i18n.js';

const RANGES = [7, 30, 90];
const SEVERITY_TONE = { info: 'teal', warn: 'amber', alert: 'red' };

export default function Insights({ props = {} }) {
  const [days, setDays] = useState(props.days || 30);
  const overview = useResource(`/insights/overview?days=${days}`);
  const briefingRef = useRef(null);

  useEffect(() => {
    if (props.focus === 'briefing') briefingRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [props.focus]);

  return (
    <section aria-label={tr('insights.insights', 'Insights')} style={{
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 18,
      background: T.ground, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <Title sub={`last ${days} days`} right={(
        <div role="group" aria-label={tr('insights.range', 'Range')} style={{ display: 'flex', gap: 6 }}>
          {RANGES.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} style={{
              padding: '3px 10px', borderRadius: 999, border: `1px solid ${days === d ? T.ink : T.border}`, background: days === d ? T.ink : 'transparent',
              color: days === d ? T.surface : T.ink, font: 'inherit', fontSize: 12, cursor: 'pointer',
            }}>{d} d</button>
          ))}
        </div>
      )}>{tr('insights.insights', 'Insights')}</Title>

      {overview.loading && !overview.data && <Loading label="Counting…" />}
      {overview.error && !overview.data && <StateView error={overview.error} onRetry={overview.reload} what="Insights" />}
      {overview.data && <Overview data={overview.data} />}

      <InsightCards />
      <div ref={briefingRef}><Briefing /></div>
    </section>
  );
}

function Overview({ data }) {
  const volume = data.volume || [];
  const received = volume.reduce((a, v) => a + (Number(v.received) || 0), 0);
  const sent = volume.reduce((a, v) => a + (Number(v.sent) || 0), 0);
  const rt = data.responseTime || {};
  const weekly = rt.weekly || [];
  const owe = data.owe || {};
  const tri = data.triage || {};
  const ai = data.ai || {};
  return (
    <>
      <TileGrid min={140}>
        <StatTile label="Received" value={formatCount(received)} sub={`${formatCount(Math.round(received / Math.max(1, volume.length)))} a day`} />
        <StatTile label="Sent" value={formatCount(sent)} sub={received ? `${formatPercent(sent / received)} of received` : undefined} />
        <StatTile label="Median reply time" value={formatHours(rt.median_hours)} sub={rt.p90_hours != null ? `p90 ${formatHours(rt.p90_hours)}` : undefined} />
        <StatTile label="Needs you" value={formatCount(tri.needs_you)} tone="amber" sub={tri.waiting_on != null ? `${formatCount(tri.waiting_on)} waiting on others` : undefined} />
        <StatTile label="You owe" value={formatCount(owe.i_owe)} tone="amber" sub={owe.overdue ? `${formatCount(owe.overdue)} overdue` : 'nothing overdue'} />
        <StatTile label="They owe" value={formatCount(owe.they_owe)} tone="teal" />
        {ai.calls != null && (
          <StatTile label="Model calls" value={formatCount(ai.calls)} sub={`${formatCount((ai.prompt_tokens || 0) + (ai.completion_tokens || 0))} tokens`} />
        )}
      </TileGrid>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card>
          <SectionLabel>{tr('insights.mailPerDay', 'Mail per day')}</SectionLabel>
          {volume.length ? (
            <ColumnChart label="Received and sent per day" height={170}
              rows={volume.map((v) => ({ label: v.day, values: [v.received || 0, v.sent || 0] }))}
              series={[{ name: 'Received', color: T.teal }, { name: 'Sent', color: T.amber }]}
              formatLabel={(d) => formatDay(d)} />
          ) : <span style={{ fontSize: 13, color: T.muted }}>{tr('insights.noMailInThisRange', 'No mail in this range.')}</span>}
        </Card>
        <Card>
          <SectionLabel>{tr('insights.yourReplyTimeWeeklyMedian', 'Your reply time, weekly median')}</SectionLabel>
          {weekly.length > 1 ? (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
                <Sparkline points={sparkPoints(weekly.map((w) => w.median_hours), 220, 60, 5)} width={220} height={60} label="Weekly median reply time" />
                <span style={{ fontSize: 12, color: T.muted }}>
                  now <strong style={{ fontFamily: T.mono, fontWeight: 500, color: T.ink }}>{formatHours(weekly[weekly.length - 1].median_hours)}</strong>
                  <br />was {formatHours(weekly[0].median_hours)}
                </span>
              </div>
              <span style={{ fontSize: 11, color: T.muted }}>{formatDay(weekly[0].week)} – {formatDay(weekly[weekly.length - 1].week)}</span>
            </>
          ) : <span style={{ fontSize: 13, color: T.muted }}>{tr('insights.notEnoughRepliesYetTo', 'Not enough replies yet to show a trend.')}</span>}
          {data.byAccount?.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <SectionLabel>{tr('insights.byAccount', 'By account')}</SectionLabel>
              {data.byAccount.map((a, i) => (
                <div key={a.account?.id || i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <AccountDot account={a.account} />
                  <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.account?.name}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12 }}>{formatCount(a.received)} in · {formatCount(a.sent)} out</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>{tr('insights.topSenders', 'Top senders')}</SectionLabel>
        <Table label="Top senders" rowKey={(r) => r.email} rows={data.topSenders || []} empty="No senders in this range."
          columns={[
            { key: 'name', label: 'Sender', render: (r) => <span title={r.email}>{r.name || r.email}</span> },
            { key: 'count', label: 'Mails', width: '70px', mono: true, align: 'right', render: (r) => formatCount(r.count) },
            { key: 'opened', label: 'Opened', width: '130px', render: (r) => <RateCell value={r.opened_rate} color={T.teal} label="Opened" /> },
            { key: 'replied', label: 'Replied', width: '130px', render: (r) => <RateCell value={r.replied_rate} color={T.amber} label="Replied" /> },
          ]} />
      </div>
    </>
  );
}

function RateCell({ value, color, label }) {
  const v = Number(value) > 1 ? Number(value) / 100 : Number(value) || 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Meter value={v} color={color} width={60} label={label} />
      <span style={{ fontFamily: T.mono, fontSize: 12 }}>{formatPercent(v)}</span>
    </span>
  );
}

function InsightCards() {
  const res = useResource('/insights/cards');
  const dismiss = useAction(async (card) => {
    await hedwigApi.post(`/insights/cards/${encodeURIComponent(card.id)}/dismiss`);
    res.setData((d) => (d || []).filter((c) => c.id !== card.id));
  });
  if (res.loading && !res.data) return null;
  if (res.error && !res.data) return <StateView error={res.error} onRetry={res.reload} what="Insight cards" compact />;
  const cards = res.data || [];
  if (!cards.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>{tr('insights.worthALook', 'Worth a look')}</SectionLabel>
      <ActionError error={dismiss.error} onDismiss={dismiss.clearError} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <Card key={c.id} style={{ gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Chip tone={SEVERITY_TONE[c.severity] || 'neutral'}>{c.severity || 'info'}</Chip>
              <strong style={{ flexGrow: 1, fontSize: 14 }}>{c.title}</strong>
              <IconButton label={`Dismiss “${c.title}”`} icon="close" size={24} onClick={() => dismiss.run(c)} />
            </div>
            {c.body && <Markdown text={c.body} style={{ fontSize: 13 }} resolveCite={(n) => c.sources?.[n - 1]} />}
            <Sources ids={c.sources} />
          </Card>
        ))}
      </div>
    </div>
  );
}

function Sources({ ids }) {
  if (!ids?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: T.muted }}>
      <span>{tr('insights.sources', 'Sources')}</span>
      {ids.slice(0, 12).map((id, i) => (
        <button key={id} type="button" onClick={() => openMessage(id)} aria-label={`Open source ${i + 1}`} style={{
          border: 0, borderRadius: 4, padding: '1px 5px', background: T.tealTint, color: T.tealText, fontFamily: T.mono, fontSize: 10, cursor: 'pointer',
        }}>{i + 1}</button>
      ))}
    </div>
  );
}

function Briefing() {
  const res = useResource('/insights/briefing');
  const gen = useAction(async () => {
    const b = await hedwigApi.post('/insights/briefing/generate');
    if (b) res.setData(b);
    else await res.reload({ quiet: true });
  });
  const b = res.data;
  return (
    <Card style={{ gap: 10, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontFamily: T.display, fontSize: 18, fontWeight: 600 }}>{b?.title || 'Daily briefing'}</h2>
        {b?.created_at && <span style={{ fontSize: 12, color: T.muted }}>written {formatAgo(b.created_at)}</span>}
        <span style={{ flexGrow: 1 }} />
        <Button size="sm" busy={gen.busy} onClick={() => gen.run()}>{gen.busy ? 'Writing…' : 'Generate now'}</Button>
      </div>
      <ActionError error={gen.error} onDismiss={gen.clearError} />
      {res.loading && !res.data && <Loading />}
      {res.error && !res.data && <StateView error={res.error} onRetry={res.reload} what="Briefings" compact />}
      {!res.loading && !res.error && !b && (
        <span style={{ fontSize: 13, color: T.muted }}>{tr('insights.noBriefingYetOneIs', 'No briefing yet. One is written each morning at your briefing time, or generate one now.')}</span>
      )}
      {b?.body && <Markdown text={b.body} resolveCite={(n) => b.sources?.[n - 1]} />}
      {b && <Sources ids={b.sources} />}
    </Card>
  );
}
