// hedwig.bills: what the owner pays again and again, and what is due (GET /cards/bills). Sections:
// Due soon (overdue invoices, renewals late or due within the week), Upcoming, No date yet, "Might be
// bills" (payees Hedwig is not sure about: Track or Not a bill, at once with Undo), Ended. A row opens
// its payee beside the list (PayeePanel, GET /cards/bills/:payee): the bill, the subscription card to
// correct, and every payment, each opening the mail it came from. Purchases opens the same panel.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useV2Resource, isMissing } from './hooks.js';
import { v2Api, listOf } from './client.js';
import { openThread } from './nav.js';
import { performAction } from './actions.js';
import { cadenceLabel } from './cards.js';
import { CardSlip } from './Cards.jsx';
import { Avatar, Btn, ErrorLine, Figure, Hair, IconButton, LinkBtn, Num, Quiet, SectionLabel, Slip, V, ViewBody, ViewHead, Why, usePhone } from './primitives.jsx';
import { money, shortDate } from './format.js';
import { tv, tvn } from './i18n.js';
import { CoverageNote } from './CoverageNote.jsx';
import { Icon } from '../icons.jsx';

export const CADENCE_CHOICES = ['monthly', 'yearly', 'quarterly', 'weekly'];
export const billPath = (payee) => `/cards/bills/${encodeURIComponent(payee)}`;

function notify(type, title) {
  useStore.getState().addNotification?.({ type, title });
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Where a bill stands, as a line and a tone ('attention' for what wants paying or checking). Pure. */
export function billStatusLine(bill, now = new Date()) {
  const date = bill?.nextDue ? shortDate(bill.nextDue, now) : '';
  const n = bill?.daysUntil;
  switch (bill?.status) {
    case 'overdue': return { text: tv('hedwig.v2.bills.overdue', 'Overdue since {{date}}', { date }), tone: 'attention' };
    case 'late': return { text: tv('hedwig.v2.bills.late', 'Due {{date}}, no payment seen yet', { date }), tone: 'attention' };
    case 'due_soon':
      if (n === 0) return { text: tv('hedwig.v2.bills.dueToday', 'Due today'), tone: 'attention' };
      if (n === 1) return { text: tv('hedwig.v2.bills.dueTomorrow', 'Due tomorrow'), tone: 'attention' };
      return { text: tv('hedwig.v2.bills.dueIn', 'Due {{date}}, in {{n}} days', { date, n }), tone: 'ink' };
    case 'due': return { text: tv('hedwig.v2.bills.dueNoDate', 'Due, no date given'), tone: 'attention' };
    case 'upcoming': return { text: tv('hedwig.v2.bills.next', 'Next {{date}}', { date }), tone: 'muted' };
    case 'ended': return { text: bill.lastPaid ? tv('hedwig.v2.bills.ended', 'Ended, last paid {{date}}', { date: shortDate(bill.lastPaid, now) }) : tv('hedwig.v2.bills.endedNoDate', 'Ended'), tone: 'muted' };
    default: return { text: tv('hedwig.v2.bills.noDate', 'No date yet'), tone: 'muted' };
  }
}

/** "Monthly · last paid 28 Sep" / "Invoice INV-12". Pure. */
export function billSubline(bill, now = new Date()) {
  const parts = [];
  if (bill?.invoice) parts.push(bill.invoice.reference ? tv('hedwig.v2.bills.invoiceRef', 'Invoice {{ref}}', { ref: bill.invoice.reference }) : tv('hedwig.v2.bills.invoice', 'Invoice'));
  if (bill?.cadence) parts.push(cap(cadenceLabel(bill.cadence)));
  if (bill?.lastPaid) parts.push(tv('hedwig.v2.bills.lastPaid', 'last paid {{date}}', { date: shortDate(bill.lastPaid, now) }));
  return parts.join(' · ');
}

/** Why Hedwig asks about a payee. Pure. */
export function candidateReason(c) {
  if (c?.reason === 'cadence_unknown') {
    return c.charges > 1
      ? tv('hedwig.v2.bills.whyIrregular', '{{n}} payments, not at a steady interval yet.', { n: c.charges })
      : tv('hedwig.v2.bills.whyOne', 'One payment so far; Hedwig cannot tell how often yet.');
  }
  if (c?.reason === 'no_evidence') return tv('hedwig.v2.bills.whyTwo', 'Paid {{cadence}} so far, but nothing in the mail says it repeats.', { cadence: cadenceLabel(c.cadence) });
  return tv('hedwig.v2.bills.whyUnsure', 'Hedwig is not sure this repeats.');
}

/** The view's sections, in order, without empty ones. Pure. */
export function billSections(bills, candidates) {
  const of = (statuses) => (bills || []).filter((b) => statuses.includes(b.status));
  return [
    { id: 'due', label: tv('hedwig.v2.bills.sectionDue', 'Due soon'), rows: of(['overdue', 'late', 'due_soon', 'due']) },
    { id: 'upcoming', label: tv('hedwig.v2.bills.sectionUpcoming', 'Upcoming'), rows: of(['upcoming']) },
    { id: 'unknown', label: tv('hedwig.v2.bills.sectionUnknown', 'No date yet'), rows: of(['unknown']) },
    { id: 'candidates', label: tv('hedwig.v2.bills.sectionMaybe', 'Might be bills'), rows: candidates || [], candidates: true },
    { id: 'ended', label: tv('hedwig.v2.bills.sectionEnded', 'Ended'), rows: of(['ended']) },
  ].filter((s) => s.rows.length);
}

/** The figures over the list: per currency, a month of the running bills and what is due soon. Pure. */
export function billFigures(totals) {
  return (totals || []).filter((t) => t && (t.monthly > 0 || t.due > 0)).map((t) => ({
    key: t.currency || '?',
    figure: money(t.monthly > 0 ? t.monthly : t.due, t.currency),
    caption: t.monthly > 0 ? tv('hedwig.v2.ledger.perMonth', 'a month') : tv('hedwig.v2.bills.dueSoon', 'due soon'),
    sub: [
      tvn(t.count, ['hedwig.v2.bills.countOne', '1 bill'], ['hedwig.v2.bills.countMany', '{{n}} bills']),
      t.monthly > 0 && t.due > 0 ? tv('hedwig.v2.bills.dueAmount', '{{amount}} due soon', { amount: money(t.due, t.currency) }) : null,
    ].filter(Boolean).join(' · '),
  }));
}

// ── The owner's answers, at once with Undo ───────────────────────────────────

/** Track a payee as a bill: the row moves at once; Undo is untrack (onDone / onUndone follow the server). */
export function trackPayee({ payee, name, cadence = 'monthly', onApply, onRevert, onDone, onUndone }) {
  const path = billPath(payee);
  return performAction({
    kind: 'custom',
    items: [{ payee }],
    title: tv('hedwig.v2.bills.tracked', 'Tracking {{name}} as a {{cadence}} bill.', { name, cadence: cadenceLabel(cadence) }),
    failTitle: tv('hedwig.v2.bills.trackFailed', 'Could not track {{name}}.', { name }),
    run: async () => { const out = await v2Api.post(`${path}/track`, { cadence }); onDone?.(out); return out; },
    undo: async () => { await v2Api.post(`${path}/untrack`); onUndone?.(); },
    onApply,
    onRevert,
  });
}

/** Not a bill: the payee leaves the list at once and is never proposed again; Undo restores it. */
export function notBillPayee({ payee, name, onApply, onRevert }) {
  const path = billPath(payee);
  return performAction({
    kind: 'custom',
    items: [{ payee }],
    title: tv('hedwig.v2.bills.notBillDone', 'Not a bill. Hedwig will not list {{name}} as one again.', { name }),
    failTitle: tv('hedwig.v2.bills.notBillFailed', 'Could not tell Hedwig. {{name}} is back.', { name }),
    run: () => v2Api.post(`${path}/not-bill`),
    undo: () => v2Api.post(`${path}/restore`),
    onApply,
    onRevert,
  });
}

// ── Rows ───────────────────────────────────────────────────────────────────

function BillRow({ bill, candidate = false, on, onOpen, phone, children }) {
  const status = candidate ? { text: candidateReason(bill), tone: 'muted' } : billStatusLine(bill);
  const sub = candidate ? [bill.cadence ? cap(cadenceLabel(bill.cadence)) : null, bill.lastPaid ? tv('hedwig.v2.bills.lastPaid', 'last paid {{date}}', { date: shortDate(bill.lastPaid) }) : null].filter(Boolean).join(' · ') : billSubline(bill);
  const tone = status.tone === 'attention' ? V.attentionInk : status.tone === 'ink' ? V.ink : V.muted;
  return (
    <div
      role="button"
      tabIndex={0}
      data-bill={bill.payee}
      aria-current={on ? 'true' : undefined}
      className="hw-row"
      onClick={() => onOpen(bill)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(bill); } }}
      style={{
        display: 'grid', gridTemplateColumns: `${phone ? 40 : 32}px minmax(0, 1fr) auto`, columnGap: 12, alignItems: 'center',
        padding: phone ? '12px 0' : '9px 12px', borderRadius: 8, cursor: 'pointer', background: on ? V.select : undefined, outline: 'none',
      }}
    >
      <Avatar name={bill.name} size={phone ? 40 : 32} dashed={candidate} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: phone ? 15 : 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bill.name}</span>
        {sub && <span style={{ fontSize: 12, color: V.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
        {children}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, minWidth: 0 }}>
        <Num size={phone ? 15 : 13} color={V.ink} style={{ fontWeight: 600 }}>{money(bill.amount, bill.currency) || '—'}</Num>
        {!candidate && <span style={{ fontSize: 12, color: tone, whiteSpace: 'nowrap' }}>{status.text}</span>}
      </span>
    </div>
  );
}

function CandidateActions({ c, phone, onTrack, onNotBill }) {
  const [cadence, setCadence] = useState(c.cadence || 'monthly');
  const stop = (e) => e.stopPropagation();
  return (
    <span onClick={stop} onKeyDown={stop} role="group" aria-label={tv('hedwig.v2.bills.decide', 'Is {{name}} a bill?', { name: c.name })} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: V.muted }}>{candidateReason(c)}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <CadencePick value={cadence} onChange={setCadence} phone={phone} />
        <Btn size={phone ? 'phone' : 'md'} accent data-bill-track="" onClick={() => onTrack(c, cadence)}>{tv('hedwig.v2.bills.track', 'Track')}</Btn>
        <LinkBtn muted hit={phone} data-bill-not="" onClick={() => onNotBill(c)} style={{ fontSize: 12 }}>{tv('hedwig.v2.bills.notBill', 'Not a bill')}</LinkBtn>
      </span>
    </span>
  );
}

// ── The view ───────────────────────────────────────────────────────────────

export default function Bills({ props }) {
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource('/cards/bills');
  const [open, setOpen] = useState(props?.payee || null);
  const [hidden, setHidden] = useState(() => new Set());
  const [moved, setMoved] = useState(() => new Map()); // payee → cadence the owner tracked it with
  const [showEnded, setShowEnded] = useState(false);
  const [rev, setRev] = useState(0); // the panel reads its payee again after Track
  const data = res.data || {};
  const all = listOf(data, 'bills');
  const allCandidates = listOf(data, 'candidates');

  // A tracked candidate shows as a bill at once (its date follows when the server answers).
  const bills = useMemo(() => {
    const out = all.filter((b) => !hidden.has(b.payee));
    for (const c of allCandidates) {
      if (!moved.has(c.payee) || hidden.has(c.payee) || out.some((b) => b.payee === c.payee)) continue;
      out.push({ ...c, cadence: moved.get(c.payee), status: 'unknown', nextDue: null, daysUntil: null, invoice: null });
    }
    return out;
  }, [all, allCandidates, hidden, moved]);
  const candidates = allCandidates.filter((c) => !hidden.has(c.payee) && !moved.has(c.payee));
  const sections = billSections(bills, candidates);
  const figures = billFigures(data.totals);
  const count = all.length;

  useEffect(() => { if (props?.payee) setOpen(props.payee); }, [props?.payee]);
  useEffect(() => {
    if (!open || phone) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phone]);

  const hide = (payee, on) => setHidden((s) => { const n = new Set(s); if (on) n.add(payee); else n.delete(payee); return n; });
  const track = (c, cadence) => trackPayee({
    payee: c.payee, name: c.name, cadence,
    onApply: () => setMoved((m) => new Map(m).set(c.payee, cadence)),
    onRevert: () => setMoved((m) => { const n = new Map(m); n.delete(c.payee); return n; }),
    onDone: () => { res.reload({ quiet: true }); setRev((r) => r + 1); },
    onUndone: () => { res.reload({ quiet: true }); setRev((r) => r + 1); },
  });
  const notBill = (b) => notBillPayee({
    payee: b.payee, name: b.name,
    onApply: () => { hide(b.payee, true); if (open === b.payee) setOpen(null); },
    onRevert: () => hide(b.payee, false),
  });

  const title = tv('hedwig.v2.bills.title', 'Bills');
  const sub = count ? tvn(count, ['hedwig.v2.bills.countOne', '1 bill'], ['hedwig.v2.bills.countMany', '{{n}} bills']) : null;

  const panel = open && (
    <PayeePanel
      key={`${open}:${rev}`}
      payee={open}
      phone={phone}
      onClose={() => setOpen(null)}
      onTrack={(c, cadence) => track({ payee: open, name: c.name }, cadence)}
      onNotBill={(b) => notBill({ payee: open, name: b.name })}
      onChanged={() => res.reload({ quiet: true })}
    />
  );
  if (phone && open) return panel;

  const list = (
    <ViewBody phone={phone} label={title} padded={false} style={phone ? undefined : { padding: '14px 6px 16px' }}>
      <ViewHead phone={phone} title={title} sub={sub} />
      <div style={{ padding: phone ? '0 16px' : 0, display: 'flex', flexDirection: 'column' }}>
        {res.error && (isMissing(res.error)
          ? <Quiet><Why>{tv('hedwig.v2.bills.unavailable', 'Bills are not available yet.')}</Why></Quiet>
          : <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />)}
        {res.loading && !res.data && <Quiet>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
        {res.data && <CoverageNote what="cards" style={{ padding: phone ? '0 0 10px' : '0 12px 12px' }} />}
        {figures.length > 0 && (
          <section aria-label={tv('hedwig.v2.ledger.totals', 'Totals')} style={{ display: 'grid', gridTemplateColumns: `repeat(${phone ? Math.min(2, figures.length) : Math.min(4, figures.length)}, minmax(0, 1fr))`, rowGap: 14, padding: phone ? '4px 0 10px' : '4px 12px 10px' }}>
            {figures.map((f, i) => (
              <div key={f.key} style={{ padding: i % (phone ? 2 : 4) === 0 ? '0 14px 0 0' : '0 14px', borderLeft: i % (phone ? 2 : 4) === 0 ? 0 : `1px solid ${V.line}` }}>
                <Figure value={f.figure} caption={f.caption} sub={f.sub} size={20} />
              </div>
            ))}
          </section>
        )}
        {res.data && !sections.length && (
          <Quiet><Why>{tv('hedwig.v2.bills.empty', 'No bills yet. Hedwig finds them in receipts, invoices and card alerts as the mail arrives.')}</Why></Quiet>
        )}
        {sections.map((s) => {
          const folded = s.id === 'ended' && !showEnded;
          return (
            <section key={s.id} aria-label={s.label} data-bills-section={s.id}>
              <SectionLabel style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: phone ? '14px 0 4px' : '14px 12px 4px' }}>
                <span>{s.label}</span>
                <span style={{ fontWeight: 400 }}>{s.rows.length}</span>
                {s.id === 'ended' && (
                  <LinkBtn muted onClick={() => setShowEnded((v) => !v)} style={{ fontSize: 11, marginLeft: 'auto' }}>
                    {showEnded ? tv('hedwig.v2.action.hide', 'Hide') : tv('hedwig.v2.action.show', 'Show')}
                  </LinkBtn>
                )}
              </SectionLabel>
              {s.candidates && <Why style={{ display: 'block', padding: phone ? '0 0 6px' : '0 12px 6px', fontSize: 12 }}>{tv('hedwig.v2.bills.maybeNote', 'Hedwig is not sure these repeat. Track one and it shows with your bills; say no and it is not suggested again.')}</Why>}
              {!folded && s.rows.map((b, i) => (
                <div key={b.id || b.payee}>
                  {i > 0 && <Hair style={{ margin: phone ? '0 0 0 52px' : '0 12px 0 56px' }} />}
                  <BillRow bill={b} candidate={s.candidates} on={open === b.payee} onOpen={(x) => setOpen(x.payee)} phone={phone}>
                    {s.candidates && <CandidateActions c={b} phone={phone} onTrack={track} onNotBill={notBill} />}
                  </BillRow>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </ViewBody>
  );

  if (phone || !open) return list;
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, minWidth: 0 }}>
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>{list}</div>
      <aside aria-label={tv('hedwig.v2.bills.panel', 'Payee')} style={{ width: 400, flexShrink: 0, borderLeft: `1px solid ${V.line}`, display: 'flex', minHeight: 0 }}>{panel}</aside>
    </div>
  );
}

// ── The payee panel (Bills and Purchases) ───────────────────────────────────

/** "Card alert" / the subject / the merchant: where a payment's figure came from. Pure. */
export function paymentSource(c) {
  if (c?.subject) return c.subject;
  if (c?.quote) return `“${c.quote}”`;
  return c?.merchant || '';
}

function PaymentRow({ c, focused, phone }) {
  const [openQuote, setOpenQuote] = useState(false);
  const canOpen = Boolean(c.messageId);
  const go = () => { if (canOpen) openThread({ messageId: c.messageId, subject: c.subject || c.merchant || '' }); else setOpenQuote((v) => !v); };
  const amount = money(c.amount, c.currency);
  return (
    <div data-payment={c.cardId} style={{ display: 'flex', flexDirection: 'column', background: focused ? V.accentTint : undefined, borderRadius: 8 }}>
      <button
        type="button"
        onClick={go}
        className="hw-row"
        title={canOpen ? tv('hedwig.v2.bills.openMail', 'Open the mail') : tv('hedwig.v2.bills.mailGoneHint', 'The mail was deleted or moved; show what Hedwig kept')}
        style={{ display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr) auto 20px', columnGap: 10, alignItems: 'baseline', width: '100%', padding: phone ? '12px 8px' : '8px 8px', border: 0, borderRadius: 8, background: 'none', color: V.ink, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}
      >
        <span style={{ color: V.muted, fontSize: 12, whiteSpace: 'nowrap' }}>{c.date ? shortDate(c.date) : '—'}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: c.messageId ? V.ink : V.muted }}>
          {c.direction === 'in' && <span style={{ color: V.muted }}>{tv('hedwig.v2.bills.received', 'Received')} · </span>}
          {c.kind === 'invoice' && c.status !== 'paid' && <span style={{ color: V.attentionInk }}>{tv('hedwig.v2.bills.unpaid', 'Unpaid')} · </span>}
          {paymentSource(c)}
        </span>
        <Num size={13} color={V.ink} style={{ fontWeight: 600 }} title={c.currencyGuessed ? tv('hedwig.v2.bills.currencyGuessed', 'Currency read from the sentence, not stated as a field') : undefined}>{amount || '—'}</Num>
        <span aria-hidden="true" style={{ color: V.muted, alignSelf: 'center', display: 'inline-flex' }}>
          <Icon name={canOpen ? 'mail' : 'info'} size={14} />
        </span>
      </button>
      {openQuote && !canOpen && (
        <div style={{ padding: '0 8px 10px 74px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Why>{tv('hedwig.v2.bills.mailGone', 'The mail this came from was deleted or moved, and Hedwig has not found it again. This is what it kept:')}</Why>
          {c.quote && <Why tone="ink">“{c.quote}”</Why>}
        </div>
      )}
    </div>
  );
}

/**
 * One payee: its bill (or Hedwig's question), the subscription card to correct, and every payment.
 * `focusCardId` (from Purchases) shows that charge's own card first.
 */
export function PayeePanel({ payee, focusCardId = null, phone = false, onClose, onTrack, onNotBill, onChanged }) {
  const res = useV2Resource(payee ? billPath(payee) : null);
  const focus = useV2Resource(focusCardId ? `/cards/${encodeURIComponent(focusCardId)}` : null, { refreshOn: [] });
  const [cadence, setCadence] = useState('monthly');
  const [gone, setGone] = useState(false);
  const d = res.data || null;
  const bill = d?.bills?.[0] || null;
  const candidate = d?.candidate || null;
  const charges = listOf(d, 'charges');
  const name = d?.name || focus.data?.fields?.merchant || payee || '';
  const focusCard = focus.data && focus.data.id ? focus.data : null;

  useEffect(() => { setGone(false); if (candidate?.cadence) setCadence(candidate.cadence); }, [payee, candidate?.cadence]);

  const track = () => {
    if (onTrack) { onTrack({ name }, cadence); return; }
    const again = () => { res.reload({ quiet: true }); onChanged?.(); };
    trackPayee({ payee, name, cadence, onDone: again, onUndone: again });
  };
  const notBill = () => {
    if (onNotBill) { onNotBill({ name }); return; }
    notBillPayee({ payee, name, onApply: () => setGone(true), onRevert: () => setGone(false) });
  };
  const markPaid = async (inv) => {
    try {
      await v2Api.patch(`/cards/${encodeURIComponent(inv.cardId)}`, { fields: { status: 'paid' } });
      notify('success', tv('hedwig.v2.bills.markedPaid', 'Marked as paid.'));
      res.reload({ quiet: true });
      onChanged?.();
    } catch (err) {
      notify('error', err?.message || tv('hedwig.v2.act.customFailed', 'That did not work.'));
    }
  };

  const status = bill ? billStatusLine(bill) : null;
  const latestMail = charges.find((c) => c.messageId)?.messageId || null;
  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 0 4px' }}>
      {phone && <IconButton icon="arrow-left" label={tv('hedwig.v2.thread.back', 'Back')} size={44} onClick={onClose} />}
      <Avatar name={name} size={40} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <h2 style={{ margin: 0, fontSize: 17, lineHeight: '22px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</h2>
        <span style={{ fontSize: 12, color: V.muted }}>
          {charges.length ? tvn(charges.length, ['hedwig.v2.bills.paymentsOne', '1 payment'], ['hedwig.v2.bills.paymentsMany', '{{n}} payments']) : ''}
        </span>
      </div>
      {latestMail && <IconButton icon="mail" label={tv('hedwig.v2.bills.openLatest', 'Open the latest mail')} onClick={() => openThread({ messageId: latestMail, subject: name })} />}
      {!phone && onClose && <IconButton icon="x" label={tv('hedwig.v2.action.close', 'Close') + ' (Esc)'} onClick={onClose} />}
    </div>
  );

  const verdict = gone || d?.notBill
    ? (
      <Slip style={{ gap: 6 }}>
        <span style={{ fontSize: 13 }}>{tv('hedwig.v2.bills.saidNo', 'You said {{name}} is not a bill.', { name })}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <CadencePick value={cadence} onChange={setCadence} phone={phone} />
          <Btn size={phone ? 'phone' : 'md'} onClick={() => { setGone(false); track(); }}>{tv('hedwig.v2.bills.trackAnyway', 'Track it after all')}</Btn>
        </span>
      </Slip>
    )
    : bill
      ? (
        <Slip style={{ gap: 6 }} data-bill-summary="">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>{money(bill.amount, bill.currency) || '—'}</span>
            <span style={{ fontSize: 13, color: V.muted }}>{bill.invoice ? tv('hedwig.v2.bills.invoice', 'Invoice') : cap(cadenceLabel(bill.cadence))}</span>
          </div>
          <span style={{ fontSize: 13, color: status.tone === 'attention' ? V.attentionInk : V.ink }}>{status.text}</span>
          {bill.monthly != null && bill.cadence !== 'monthly' && <span style={{ fontSize: 12, color: V.muted }}>{tv('hedwig.v2.bills.perMonthEq', 'About {{amount}} a month', { amount: money(bill.monthly, bill.currency) })}</span>}
          <span style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {bill.invoice && bill.invoice.status !== 'paid' && <Btn size={phone ? 'phone' : 'md'} accent onClick={() => markPaid(bill.invoice)}>{tv('hedwig.v2.bills.markPaid', 'Mark as paid')}</Btn>}
            {!bill.invoice && <LinkBtn muted hit={phone} data-bill-not="" onClick={notBill} style={{ fontSize: 12 }}>{tv('hedwig.v2.bills.notBill', 'Not a bill')}</LinkBtn>}
            {bill.layer === 'derived' && !bill.cardId && <Why style={{ fontSize: 12 }}>{tv('hedwig.v2.bills.foundNote', 'Hedwig found this from the payments below.')}</Why>}
          </span>
        </Slip>
      )
      : (
        <Slip style={{ gap: 6 }}>
          <span style={{ fontSize: 13 }}>
            {candidate ? candidateReason(candidate) : tv('hedwig.v2.bills.notTracked', 'Hedwig does not list {{name}} as a bill.', { name })}
          </span>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <CadencePick value={cadence} onChange={setCadence} phone={phone} />
            <Btn size={phone ? 'phone' : 'md'} accent={Boolean(candidate)} data-bill-track="" onClick={track}>{tv('hedwig.v2.bills.trackAsBill', 'Track as a bill')}</Btn>
            {candidate && <LinkBtn muted hit={phone} data-bill-not="" onClick={notBill} style={{ fontSize: 12 }}>{tv('hedwig.v2.bills.notBill', 'Not a bill')}</LinkBtn>}
          </span>
        </Slip>
      );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: phone ? '12px 16px 24px' : '16px 16px 24px' }}>
      {head}
      {focusCard && (
        <section aria-label={tv('hedwig.v2.bills.thisPurchase', 'This purchase')} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel style={{ padding: '0 0 2px' }}>{tv('hedwig.v2.bills.thisPurchase', 'This purchase')}</SectionLabel>
          {focusCard.messageId
            ? <LinkBtn style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => openThread({ messageId: focusCard.messageId, subject: focusCard.message?.subject || name })}>{tv('hedwig.v2.bills.openMail', 'Open the mail')}</LinkBtn>
            : <Why>{tv('hedwig.v2.bills.mailGoneShort', 'The mail was deleted or moved. Tap a field to see the sentence Hedwig kept.')}</Why>}
          <CardSlip card={focusCard} messageId={focusCard.messageId} phone={phone} onChange={(c) => { focus.setData(c); onChanged?.(); }} />
        </section>
      )}
      {res.error && !isMissing(res.error) && <ErrorLine error={res.error} onRetry={() => res.reload()} retryLabel={tv('hedwig.v2.action.retry', 'Try again')} />}
      {res.loading && !d && <Quiet style={{ padding: '4px 0' }}>{tv('hedwig.v2.loading', 'Loading…')}</Quiet>}
      {d && (
        <section aria-label={tv('hedwig.v2.bills.billLabel', 'Bill')} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {focusCard && <SectionLabel style={{ padding: '6px 0 2px' }}>{tv('hedwig.v2.bills.billLabel', 'Bill')}</SectionLabel>}
          {verdict}
          {d.card && !gone && !d.notBill && (
            <CardSlip card={d.card} messageId={d.card.messageId} phone={phone} onChange={() => { res.reload({ quiet: true }); onChanged?.(); }} />
          )}
        </section>
      )}
      {charges.length > 0 && (
        <section aria-label={tv('hedwig.v2.bills.payments', 'Payments')} style={{ display: 'flex', flexDirection: 'column' }}>
          <SectionLabel style={{ padding: '6px 0 4px' }}>{tv('hedwig.v2.bills.payments', 'Payments')}</SectionLabel>
          {charges.map((c, i) => (
            <div key={c.cardId}>
              {i > 0 && <Hair style={{ margin: '0 8px 0 74px' }} />}
              <PaymentRow c={c} focused={c.cardId === focusCardId} phone={phone} />
            </div>
          ))}
        </section>
      )}
    </div>
  );

  return (
    <ViewBody phone={phone} label={name || tv('hedwig.v2.bills.panel', 'Payee')} padded={false} style={phone ? undefined : { padding: 0 }}>
      {body}
    </ViewBody>
  );
}

function CadencePick({ value, onChange, phone }) {
  return (
    <select
      aria-label={tv('hedwig.v2.bills.howOften', 'How often')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ height: phone ? 36 : 26, border: 0, borderRadius: 6, padding: '0 6px', background: V.field, color: V.ink, font: 'inherit', fontSize: 12 }}
    >
      {CADENCE_CHOICES.map((k) => <option key={k} value={k}>{cap(cadenceLabel(k))}</option>)}
    </select>
  );
}
