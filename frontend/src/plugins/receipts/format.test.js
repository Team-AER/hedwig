// Run with: node --test src/plugins/receipts/format.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, monthsOf, monthLabel } from './format.js';

describe('receipts formatting', () => {
  it('formats amounts with and without a known currency', () => {
    assert.match(formatMoney(5.3, 'GBP'), /5\.30/);
    assert.equal(formatMoney(5.3, null), '5.30');
    assert.equal(formatMoney(null, 'EUR'), '–');
  });
  it('lists months newest first without duplicates', () => {
    assert.deepEqual(monthsOf([{ month: '2026-08' }, { month: '2026-09' }, { month: '2026-09' }, { month: 'unknown' }]), ['2026-09', '2026-08']);
  });
  it('labels months', () => {
    assert.match(monthLabel('2026-09'), /2026/);
    assert.equal(monthLabel(''), 'Unknown');
  });
});
