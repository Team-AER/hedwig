// hedwig.ledger { kind }: purchases, subscriptions, travel or deliveries (GET /cards/ledger/:kind)
// as a sortable table, with the totals by currency as figures (subscriptions also per month).
// A row opens the message it came from. On a phone the table becomes a list with a sort picker.
import { useMemo, useState } from 'react';
import { useV2Resource, isMissing } from './hooks.js';
import { listOf } from './client.js';
import { openThread } from './nav.js';
import { cadenceLabel, statusLabel } from './cards.js';
import { ErrorLine, Figure, Hair, Mono, Quiet, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { money, shortDate, fullTime } from './format.js';
import { tv, tvn } from './i18n.js';

export const LEDGER_KINDS = ['purchases', 'subscriptions', 'travel', 'deliveries'];
// Simple mode keeps the rail short: the two ledgers with money in them.
export const SIMPLE_LEDGERS = ['purchases', 'subscriptions'];

export function ledgerTitle(kind) {
  if (kind === 'subscriptions') return tv('hedwig.v2.ledger.subscriptions', 'Subscriptions');
  if (kind === 'travel') return tv('hedwig.v2.ledger.travel', 'Travel');
  if (kind === 'deliveries') return tv('hedwig.v2.ledger.deliveries', 'Deliveries');
  return tv('hedwig.v2.ledger.purchases', 'Purchases');
}

const day = (v) => (v ? shortDate(v) : '');
const when = (v) => (v ? fullTime(v) : '');
const amount = (r) => money(r.amount, r.currency) || '';

/**
 * The columns of each ledger: `sort` is the row field the column sorts by (only the fields the
 * route offers as sort options), `render` what the cell shows.
 */
export function ledgerColumns(kind) {
  switch (kind) {
    case 'subscriptions':
      return [
        { id: 'merchant', sort: 'merchant', label: tv('hedwig.v2.card.field.merchant', 'Merchant'), render: (r) => r.merchant || '' },
        { id: 'amount', sort: 'amount', num: true, label: tv('hedwig.v2.card.field.amount', 'Amount'), render: amount },
        { id: 'cadence', sort: 'cadence', label: tv('hedwig.v2.card.field.cadence', 'Billed'), render: (r) => (r.cadence ? cadenceLabel(r.cadence) : '') },
        { id: 'lastCharged', sort: 'lastCharged', date: true, label: tv('hedwig.v2.ledger.lastCharged', 'Last charged'), render: (r) => day(r.lastCharged) },
        { id: 'nextRenewal', sort: 'nextRenewal', date: true, label: tv('hedwig.v2.card.field.nextRenewal', 'Next renewal'), render: (r) => day(r.nextRenewal) },
      ];
    case 'travel':
      return [
        { id: 'date', sort: 'date', date: true, label: tv('hedwig.v2.card.field.date', 'Date'), render: (r) => (r.departAt ? when(r.departAt) : day(r.date)) },
        { id: 'provider', sort: 'provider', label: tv('hedwig.v2.card.field.provider', 'Provider'), render: (r) => [r.provider, r.flightNumber].filter(Boolean).join(' ') },
        { id: 'route', label: tv('hedwig.v2.ledger.route', 'Route'), render: (r) => (r.from && r.to ? `${r.from} → ${r.to}` : (r.location || '')) },
        { id: 'reference', sort: 'reference', mono: true, label: tv('hedwig.v2.card.field.reference', 'Reference'), render: (r) => r.reference || '' },
      ];
    case 'deliveries':
      return [
        { id: 'updatedAt', sort: 'updatedAt', date: true, label: tv('hedwig.v2.ledger.updated', 'Updated'), render: (r) => day(r.updatedAt) },
        { id: 'item', label: tv('hedwig.v2.card.field.item', 'Item'), render: (r) => r.item || r.merchant || '' },
        { id: 'carrier', sort: 'carrier', label: tv('hedwig.v2.card.field.carrier', 'Carrier'), render: (r) => r.carrier || '' },
        { id: 'status', sort: 'status', label: tv('hedwig.v2.card.field.status', 'Status'), render: (r) => (r.status ? statusLabel(r.status) : '') },
        { id: 'expectedDate', sort: 'expectedDate', date: true, label: tv('hedwig.v2.card.field.expectedDate', 'Expected'), render: (r) => day(r.expectedDate) },
      ];
    default:
      return [
        { id: 'date', sort: 'date', date: true, label: tv('hedwig.v2.card.field.date', 'Date'), render: (r) => day(r.date) },
        { id: 'merchant', sort: 'merchant', label: tv('hedwig.v2.card.field.merchant', 'Merchant'), render: (r) => r.merchant || '' },
        { id: 'reference', mono: true, label: tv('hedwig.v2.card.field.reference', 'Reference'), render: (r) => r.reference || '' },
        { id: 'amount', sort: 'amount', num: true, label: tv('hedwig.v2.card.field.amount', 'Amount'), render: amount },
        { id: 'status', sort: 'status', label: tv('hedwig.v2.card.field.status', 'Status'), render: (r) => (r.status === 'paid' || !r.dueDate ? statusLabel(r.status) : `${statusLabel(r.status)} ${day(r.dueDate)}`) },
      ];
  }
}

/** Sort rows by a field, nulls last either way (as the route does). Pure. */
export function sortRows(rows, field, dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const x = a?.[field];
    const y = b?.[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/** The totals as figures: "NOK 1,589" / "3 purchases"; subscriptions per month. Pure. */
export function totalFigures(kind, totals) {
  return (totals || []).filter((t) => t && t.total != null).map((t) => {
    if (kind === 'subscriptions') {
      return {
        key: t.currency || '?',
        figure: money(t.monthly ?? 0, t.currency),
        caption: tv('hedwig.v2.ledger.perMonth', 'a month'),
        sub: tvn(t.count, ['hedwig.v2.card.sum.subscriptionOne', '1 subscription'], ['hedwig.v2.card.sum.subscriptionMany', '{{n}} subscriptions']),
      };
    }
    return {
      key: t.currency || '?',
      figure: money(t.total, t.currency),
      caption: tvn(t.count, ['hedwig.v2.ledger.purchasesOne', '1 purchase'], ['hedwig.v2.ledger.purchasesMany', '{{n}} purchases']),
      sub: null,
    };
  });
}

// On a phone each row is a title, one figure at the side, and the rest on a line below.
const PHONE_ROW = {
  purchases: { title: 'merchant', side: 'amount' },
  subscriptions: { title: 'merchant', side: 'amount' },
  travel: { title: 'provider', side: 'date' },
  deliveries: { title: 'item', side: 'expectedDate' },
};

export default function Ledger({ props }) {
  const kind = LEDGER_KINDS.includes(props?.kind) ? props.kind : 'purchases';
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource(`/cards/ledger/${kind}`);
  const data = res.data || {};
  const rows = listOf(data, 'rows');
  const columns = ledgerColumns(kind);
  const offered = Array.isArray(data.sort?.options) ? data.sort.options : columns.map((c) => c.sort).filter(Boolean);
  const [sort, setSort] = useState(null); // { kind, field, dir } once the user picks one
  const current = (sort?.kind === kind ? sort : null) || (data.sort?.field ? { field: data.sort.field, dir: data.sort.dir || 'desc' } : null);
  const sorted = useMemo(() => (current ? sortRows(rows, current.field, current.dir) : rows), [rows, current?.field, current?.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const figures = totalFigures(kind, data.totals);
  const title = ledgerTitle(kind);
  const sub = rows.length ? tvn(rows.length, ['hedwig.v2.ledger.rowsOne', '1 entry'], ['hedwig.v2.ledger.rowsMany', '{{n}} entries']) : null;

  const pick = (field) => {
    if (current?.field === field) { setSort({ kind, field, dir: current.dir === 'asc' ? 'desc' : 'asc' }); return; }
    setSort({ kind, field, dir: ['merchant', 'provider', 'carrier', 'cadence', 'status', 'nextRenewal', 'expectedDate'].includes(field) ? 'asc' : 'desc' });
  };

  const open = (r) => { if (r.messageId) openThread({ messageId: r.messageId, subject: r.merchant || r.provider || r.item || '' }); };

  const state = (
    <>
      {res.error && (isMissing(res.error)
        ? <Quiet><Why>{tv('hedwig.v2.ledger.unavailable', 'Ledgers are not available yet.')}</Why></Quiet>
        : <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />)}
      {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {res.data && !rows.length && <Quiet><Why>{tv('hedwig.v2.ledger.empty', 'Nothing here yet. Hedwig adds to this as the mail arrives.')}</Why></Quiet>}
    </>
  );

  const totals = figures.length > 0 && (
    <section aria-label={tv('hedwig.v2.ledger.totals', 'Totals')} style={{ display: 'grid', gridTemplateColumns: `repeat(${phone ? Math.min(2, figures.length) : Math.min(4, figures.length)}, minmax(0, 1fr))`, rowGap: 18, padding: phone ? '4px 0 18px' : '4px 12px 22px' }}>
      {figures.map((f, i) => (
        <div key={f.key} style={{ padding: i % (phone ? 2 : 4) === 0 ? '0 20px 0 0' : '0 20px', borderLeft: i % (phone ? 2 : 4) === 0 ? 0 : `1px solid ${V.line2}` }}>
          <Figure value={f.figure} caption={f.caption} sub={f.sub} size={phone ? 30 : 36} />
        </div>
      ))}
    </section>
  );

  if (phone) {
    const sortable = columns.filter((c) => c.sort && offered.includes(c.sort));
    return (
      <ViewBody phone label={title} padded={false}>
        <ViewHead phone title={title} sub={sub} />
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
          {state}
          {totals}
          {rows.length > 1 && sortable.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: V.muted, minHeight: 44 }}>
              {tv('hedwig.v2.ledger.sortBy', 'Sort by')}
              <select
                value={current ? `${current.field}:${current.dir}` : ''}
                onChange={(e) => { const [field, dir] = e.target.value.split(':'); setSort({ kind, field, dir }); }}
                style={{ height: 44, border: 0, borderBottom: `1px solid ${V.line2}`, background: 'transparent', color: V.ink, font: 'inherit', fontSize: 14, borderRadius: 0 }}
              >
                {sortable.flatMap((c) => [
                  <option key={`${c.sort}:desc`} value={`${c.sort}:desc`}>{`${c.label} ↓`}</option>,
                  <option key={`${c.sort}:asc`} value={`${c.sort}:asc`}>{`${c.label} ↑`}</option>,
                ])}
              </select>
            </label>
          )}
          {sorted.map((r, i) => {
            const lead = PHONE_ROW[kind] || PHONE_ROW.purchases;
            const titleCol = columns.find((c) => c.id === lead.title);
            const sideCol = columns.find((c) => c.id === lead.side);
            const rest = columns.filter((c) => c !== titleCol && c !== sideCol);
            return (
              <div key={r.id}>
                {i > 0 && <Hair />}
                <button
                  type="button"
                  onClick={() => open(r)}
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%', padding: '12px 0', minHeight: 44, border: 0, background: 'none', color: V.ink, font: 'inherit', textAlign: 'left', cursor: r.messageId ? 'pointer' : 'default' }}
                >
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%' }}>
                    <span style={{ fontSize: 15, fontWeight: 500, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleCol.render(r)}</span>
                    <Mono size={12} color={V.ink}>{sideCol.render(r)}</Mono>
                  </span>
                  <span style={{ fontSize: 13, color: V.muted, overflowWrap: 'anywhere' }}>{rest.map((c) => c.render(r)).filter(Boolean).join(' · ')}</span>
                </button>
              </div>
            );
          })}
        </div>
      </ViewBody>
    );
  }

  const th = { textAlign: 'left', fontWeight: 500, fontSize: 12, color: V.muted, padding: '0 12px 8px', borderBottom: `1px solid ${V.line2}`, whiteSpace: 'nowrap' };
  return (
    <ViewBody label={title} padded={false} style={{ padding: '26px 14px 16px' }}>
      <ViewHead title={title} sub={sub} />
      {state}
      {totals}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{title}</caption>
            <thead>
              <tr>
                {columns.map((c) => {
                  const can = c.sort && offered.includes(c.sort);
                  const on = can && current?.field === c.sort;
                  return (
                    <th key={c.id} scope="col" aria-sort={on ? (current.dir === 'asc' ? 'ascending' : 'descending') : undefined} style={{ ...th, textAlign: c.num ? 'right' : 'left' }}>
                      {can
                        ? (
                          <button type="button" onClick={() => pick(c.sort)} className="hw-link" style={{ padding: 0, border: 0, background: 'none', font: 'inherit', color: on ? V.ink : V.muted, cursor: 'pointer', textDecorationColor: on ? V.line2 : 'transparent' }}>
                            {c.label}{on ? (current.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                          </button>
                        )
                        : c.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="hw-row" onClick={() => open(r)} style={{ cursor: r.messageId ? 'pointer' : 'default' }}>
                  {columns.map((c, i) => (
                    <td key={c.id} style={{ padding: '12px', borderBottom: `1px solid ${V.line}`, textAlign: c.num ? 'right' : 'left', fontFamily: c.mono || c.num ? V.mono : 'inherit', fontSize: c.mono || c.num ? 13 : 14, whiteSpace: c.num || c.mono || c.date ? 'nowrap' : undefined }}>
                      {i === 1 && r.messageId
                        ? <button type="button" onClick={(e) => { e.stopPropagation(); open(r); }} className="hw-link" style={{ padding: 0, border: 0, background: 'none', font: 'inherit', color: V.ink, cursor: 'pointer', textAlign: 'left', textDecorationColor: 'transparent' }}>{c.render(r)}</button>
                        : c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ViewBody>
  );
}
