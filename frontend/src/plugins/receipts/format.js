// Formatting helpers for the receipts ledger (pure, tested with node --test).

export function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return '–';
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch { /* unknown code: fall through */ }
  }
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

export function monthLabel(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return month || 'Unknown';
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Distinct months present in a summary, newest first. */
export function monthsOf(byMonth) {
  return [...new Set((byMonth || []).map((m) => m.month).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();
}
