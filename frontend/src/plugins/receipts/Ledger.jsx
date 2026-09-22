// Receipts ledger (view 'aer.receipts.ledger'): totals by month and vendor, the receipts found in
// mail, CSV export and a look-back scan.
import { useState } from 'react';
import { pluginApi } from '../runtimeLoader.js';
import { openMessage, useAction, useResource } from '../../hedwig/views/hooks.js';
import {
  ActionError, Button, Card, Empty, Loading, SectionLabel, Select, StateView, T, Table, Title, ViewFrame,
} from '../../hedwig/views/ui.jsx';
import { tr } from '../../hedwig/views/i18n.js';
import { formatMoney, monthLabel, monthsOf } from './format.js';

const ID = 'aer.receipts';
const papi = pluginApi(ID);

export default function Ledger() {
  const [month, setMonth] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const q = month ? `?month=${encodeURIComponent(month)}` : '';
  const summaryAll = useResource(`/p/${ID}/summary`, { refreshOn: ['hedwig:receipts-changed'] });
  const summary = useResource(`/p/${ID}/summary${q}`, { refreshOn: ['hedwig:receipts-changed'] });
  const list = useResource(`/p/${ID}/receipts${q}`, { refreshOn: ['hedwig:receipts-changed'] });
  const changed = () => window.dispatchEvent(new CustomEvent('hedwig:receipts-changed'));
  const scan = useAction(async () => { setScanResult(await papi.post('/scan', { days: 30 })); changed(); });
  const dismiss = useAction(async (r) => { await papi.del(`/receipts/${encodeURIComponent(r.messageId)}`); changed(); });
  const months = monthsOf(summaryAll.data?.byMonth);

  if (list.error && !list.data) return <ViewFrame label={tr('plugins.receipts.title', 'Receipts')}><StateView error={list.error} onRetry={list.reload} what={tr('plugins.receipts.title', 'Receipts')} /></ViewFrame>;

  const columns = [
    { key: 'date', label: tr('plugins.receipts.date', 'Date'), width: '96px', mono: true },
    { key: 'vendor', label: tr('plugins.receipts.vendor', 'Vendor'), width: 'minmax(0, 1.2fr)' },
    { key: 'amount', label: tr('plugins.receipts.amount', 'Amount'), width: '120px', align: 'right', mono: true, render: (r) => formatMoney(r.amount, r.currency) },
    { key: 'category', label: tr('plugins.receipts.category', 'Category'), width: '110px', muted: true },
    { key: 'subject', label: tr('plugins.receipts.subject', 'Subject'), width: 'minmax(0, 1.6fr)', muted: true },
    {
      key: 'actions', label: '', width: '112px', align: 'right',
      render: (r) => (
        <Button size="sm" variant="ghost" aria-label={tr('plugins.receipts.dismissLabel', 'Not a receipt: {{what}}', { what: r.subject || r.vendor })}
          onClick={(e) => { e.stopPropagation(); dismiss.run(r); }}>{tr('plugins.receipts.dismiss', 'Not a receipt')}</Button>
      ),
    },
  ];

  return (
    <ViewFrame label={tr('plugins.receipts.title', 'Receipts')}>
      <Title sub={list.data ? tr('plugins.receipts.found', '{{count}} found', { count: list.data.count }) : null} right={(
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="receipts-month" style={{ fontSize: 12, color: T.muted }}>{tr('plugins.receipts.month', 'Month')}</label>
          <Select id="receipts-month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 170 }}>
            <option value="">{tr('plugins.receipts.allMonths', 'All months')}</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
          <a href={papi.url(`/export.csv${q}`)} download className="hw-btn" style={{
            padding: '7px 12px', borderRadius: 7, border: `1px solid ${T.border}`, color: T.ink, textDecoration: 'none', fontSize: 13,
          }}>{tr('plugins.receipts.export', 'Export CSV')}</a>
          <Button onClick={() => scan.run()} busy={scan.busy}>{tr('plugins.receipts.scan', 'Scan last 30 days')}</Button>
        </div>
      )}>{tr('plugins.receipts.title', 'Receipts')}</Title>
      <ActionError error={scan.error || dismiss.error} />
      {scanResult && <div role="status" style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>{tr('plugins.receipts.scanned', 'Checked {{scanned}} messages, found {{found}} new receipts.', scanResult)}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, margin: '16px 0' }}>
        <Card>
          <SectionLabel>{tr('plugins.receipts.byMonth', 'By month')}</SectionLabel>
          {(summary.data?.byMonth || []).slice(0, 8).map((m) => (
            <div key={`${m.month}|${m.currency}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{monthLabel(m.month)} <span style={{ color: T.muted }}>· {m.count}</span></span>
              <span style={{ fontFamily: T.mono }}>{formatMoney(m.total, m.currency)}</span>
            </div>
          ))}
          {!summary.data?.byMonth?.length && <span style={{ fontSize: 13, color: T.muted }}>{tr('plugins.receipts.noTotals', 'No totals yet.')}</span>}
        </Card>
        <Card>
          <SectionLabel>{tr('plugins.receipts.topVendors', 'Top vendors')}</SectionLabel>
          {(summary.data?.byVendor || []).slice(0, 8).map((v) => (
            <div key={`${v.vendor}|${v.currency}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{v.vendor} <span style={{ color: T.muted }}>· {v.count}</span></span>
              <span style={{ fontFamily: T.mono }}>{formatMoney(v.total, v.currency)}</span>
            </div>
          ))}
          {!summary.data?.byVendor?.length && <span style={{ fontSize: 13, color: T.muted }}>{tr('plugins.receipts.noVendors', 'No vendors yet.')}</span>}
        </Card>
      </div>

      {list.loading && !list.data ? <Loading /> : list.data?.receipts?.length ? (
        <Table label={tr('plugins.receipts.title', 'Receipts')} columns={columns} rows={list.data.receipts} rowKey={(r) => r.messageId}
          onRowClick={(r) => openMessage(r.messageId)} />
      ) : (
        <Empty title={tr('plugins.receipts.emptyTitle', 'No receipts yet')}>
          {tr('plugins.receipts.empty', 'Receipts, invoices and order confirmations appear here as they arrive. Scan the last 30 days to fill the ledger now.')}
        </Empty>
      )}
    </ViewFrame>
  );
}
