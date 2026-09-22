import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { planEntities, entityDeltas } = await import('./entities.js');
const { registrableDomain, orgNameFromDomain, cleanName, isAutomatedAddress, isBulkMessage } = await import('./util.js');

const mine = new Set(['me@work.example', 'me.alias@gmail.com']);
const row = (over) => ({
  id: 'm1', user_id: 'u1', date: '2026-09-01T10:00:00Z', from_email: 'Priya@Vantage.example', from_name: 'Priya Nair',
  to_addresses: [{ address: 'me@work.example', name: 'Me' }], cc_addresses: [], user_addresses: mine, is_outgoing: false, ...over,
});

describe('planEntities', () => {
  it('merges an address seen in several messages into one record with every link', () => {
    const plan = planEntities([
      row({ id: 'm1' }),
      row({ id: 'm2', from_email: 'me@work.example', from_name: 'Me', is_outgoing: true, to_addresses: [{ address: 'priya@vantage.example', name: 'priya' }] }),
    ]);
    expect([...plan.addresses.keys()].sort()).toEqual(['me@work.example', 'priya@vantage.example']);
    expect(plan.links).toEqual([
      { messageId: 'm1', email: 'priya@vantage.example', role: 'from' },
      { messageId: 'm1', email: 'me@work.example', role: 'to' },
      { messageId: 'm2', email: 'me@work.example', role: 'from' },
      { messageId: 'm2', email: 'priya@vantage.example', role: 'to' },
    ]);
  });

  it("prefers the name people give themselves over the name in someone's To header", () => {
    const plan = planEntities([
      row({ id: 'm1', from_email: 'me@work.example', is_outgoing: true, to_addresses: [{ address: 'sam@x.example', name: 'sammy' }] }),
      row({ id: 'm2', from_email: 'sam@x.example', from_name: '"Sam Wilson"' }),
      row({ id: 'm3', from_email: 'me@work.example', is_outgoing: true, to_addresses: [{ address: 'sam@x.example', name: 'S' }] }),
    ]);
    expect(plan.addresses.get('sam@x.example')).toMatchObject({ name: 'Sam Wilson', nameFromHeader: true });
  });

  it("marks the user's own addresses, and a Sent-folder sender, as self with no org", () => {
    const plan = planEntities([
      row({ id: 'm1', from_email: 'unlisted@work.example', is_outgoing: true, to_addresses: ['a@vantage.example'] }),
      row({ id: 'm2', to_addresses: ['me.alias@gmail.com'] }),
    ]);
    expect(plan.addresses.get('unlisted@work.example')).toMatchObject({ self: true, orgDomain: null });
    expect(plan.addresses.get('me.alias@gmail.com')).toMatchObject({ self: true, orgDomain: null });
    expect(plan.addresses.get('a@vantage.example')).toMatchObject({ self: false, orgDomain: 'vantage.example' });
  });

  it('creates no organisation for personal mail domains', () => {
    const plan = planEntities([row({ from_email: 'amaan.q@gmail.com' }), row({ id: 'm2', from_email: 'x@mail.eu.acme.co.uk' })],
      { freemail: ['gmail.com'] });
    expect(plan.addresses.get('amaan.q@gmail.com').orgDomain).toBeNull();
    expect(plan.addresses.get('x@mail.eu.acme.co.uk').orgDomain).toBe('acme.co.uk');
  });

  it('dedupes an address repeated in one header and ignores junk entries', () => {
    const plan = planEntities([row({ to_addresses: ['me@work.example', 'ME@work.example', { name: 'no address' }, 'not-an-email'] })]);
    expect(plan.links.filter((l) => l.role === 'to')).toHaveLength(1);
  });

  it('flags automated senders and bulk messages', () => {
    const plan = planEntities([row({ from_email: 'notifications@github.com', is_bulk: false })]);
    expect(plan.addresses.get('notifications@github.com').automated).toBe(true);
    expect(plan.messages.get('m1').bulk).toBe(true);
  });
});

describe('entityDeltas', () => {
  const messages = new Map([
    ['in1', { date: new Date('2026-09-01'), outgoing: false, bulk: false }],
    ['in2', { date: new Date('2026-09-05'), outgoing: false, bulk: true }],
    ['out1', { date: new Date('2026-08-01'), outgoing: true, bulk: false }],
  ]);

  it('counts distinct messages, received, sent and bulk per entity', () => {
    const deltas = entityDeltas([
      { message_id: 'in1', entity_id: 'p', role: 'from' },
      { message_id: 'in2', entity_id: 'p', role: 'from' },
      { message_id: 'out1', entity_id: 'p', role: 'to' },
      { message_id: 'out1', entity_id: 'p', role: 'cc' },
      { message_id: 'in1', entity_id: 'other', role: 'cc' },
    ], messages);
    const p = deltas.find((d) => d.id === 'p');
    expect(p).toMatchObject({ n: 3, recv: 2, sent: 1, bulk: 1 });
    expect(p.first.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(p.last.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect(deltas.find((d) => d.id === 'other')).toMatchObject({ n: 1, recv: 0, sent: 0 });
  });

  it('adds nothing when a re-run inserted no new links', () => {
    expect(entityDeltas([], messages)).toEqual([]);
  });
});

describe('entity helpers', () => {
  it('derives registrable domains and org names', () => {
    expect(registrableDomain('mail.vantage.example')).toBe('vantage.example');
    expect(registrableDomain('eu.acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('github.com')).toBe('github.com');
    expect(orgNameFromDomain('kowalski-design.example')).toBe('Kowalski Design');
  });
  it('cleans display names', () => {
    expect(cleanName(' "Priya  Nair" ', 'p@x')).toBe('Priya Nair');
    expect(cleanName('p@x.com', 'p@x.com')).toBeNull();
    expect(cleanName('', 'p@x.com')).toBeNull();
  });
  it('recognises machine senders', () => {
    expect(isAutomatedAddress('no-reply@x.com')).toBe(true);
    expect(isAutomatedAddress('messages-noreply@linkedin.com')).toBe(true);
    expect(isAutomatedAddress('priya@x.com')).toBe(false);
    expect(isBulkMessage({ is_bulk: false, category: 'newsletter', from_email: 'a@b.c' })).toBe(true);
    expect(isBulkMessage({ is_bulk: null, category: 'primary', from_email: 'a@b.c' })).toBe(false);
  });
});
