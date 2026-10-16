import { describe, it, expect } from 'vitest';
import { scrubQuery } from './scrub.js';

describe('scrubQuery', () => {
  it('removes email addresses, including the given ones', () => {
    expect(scrubQuery('invoice from jane.doe@example.com about pizza')).toBe('invoice from about pizza');
    expect(scrubQuery('mail <ops+alerts@corp.example.co.uk> outage')).toBe('mail outage');
    expect(scrubQuery('ask Owner@AER.example re offsite', { emails: ['owner@aer.example'] })).toBe('ask re offsite');
  });

  it('removes names, whole words and case-insensitively, plus the parts of multi-word names', () => {
    const names = ['Priya Raman'];
    expect(scrubQuery('Priya Raman flight to Berlin', { names })).toBe('flight to Berlin');
    expect(scrubQuery('RAMAN family trip, priya\'s visa', { names })).toBe('family trip \'s visa');
    expect(scrubQuery('Priyasomething stays', { names })).toBe('Priyasomething stays');
    expect(scrubQuery('Hi Priya, about (Priya) the offsite', { names })).toBe('Hi about the offsite');
    // Parts shorter than three letters are too common to remove on their own.
    expect(scrubQuery('Al Gore climate talk', { names: ['Al Li'] })).toBe('Al Gore climate talk');
    expect(scrubQuery('Müller GmbH Zoë quarterly report', { names: ['Zoë Müller'] })).toBe('GmbH quarterly report');
  });

  it('removes long digit runs, with spaces or dashes inside', () => {
    expect(scrubQuery('call +91 98765-43210 about order 1234 5678 9012 and ref 123456')).toBe('call about order and ref');
    expect(scrubQuery('card 4111-1111-1111-1111 declined')).toBe('card declined');
  });

  it('keeps short numbers, years and dates', () => {
    expect(scrubQuery('iPhone 15 2024 review')).toBe('iPhone 15 2024 review');
    expect(scrubQuery('rust 1.80 2024 release notes')).toBe('rust 1.80 2024 release notes');
    expect(scrubQuery('conference 2026-10-17 agenda')).toBe('conference 2026-10-17 agenda');
    expect(scrubQuery('error 12345 on login')).toBe('error 12345 on login');
  });

  it('removes IBAN-like tokens, spaced or not', () => {
    expect(scrubQuery('pay DE89370400440532013000 now')).toBe('pay now');
    expect(scrubQuery('IBAN DE89 3704 0044 0532 0130 00 transfer')).toBe('IBAN transfer');
    expect(scrubQuery('GB82WEST12345698765432 sort code')).toBe('sort code');
    expect(scrubQuery('US10 YEAR TREASURY yield')).toBe('US10 YEAR TREASURY yield');
  });

  it('keeps only scheme, host and path of URLs', () => {
    expect(scrubQuery('read https://news.example.com/a/b?token=abc&u=me#x please')).toBe('read https://news.example.com/a/b please');
    expect(scrubQuery('site https://example.com/?q=jane')).toBe('site https://example.com');
  });

  it('caps the length on a word boundary', () => {
    const q = scrubQuery('alpha beta gamma delta epsilon '.repeat(10), { maxChars: 40 });
    expect(q.length).toBeLessThanOrEqual(40);
    expect('alpha beta gamma delta epsilon '.repeat(10).startsWith(`${q} `)).toBe(true);
    expect(scrubQuery('x'.repeat(200), { maxChars: 50 })).toHaveLength(50);
  });

  it('returns empty when nothing meaningful is left', () => {
    expect(scrubQuery('jane@example.com')).toBe('');
    expect(scrubQuery('Priya Raman', { names: ['Priya Raman'] })).toBe('');
    expect(scrubQuery(' , ; () ')).toBe('');
    expect(scrubQuery('a')).toBe('');
    expect(scrubQuery(null)).toBe('');
  });
});
