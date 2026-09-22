import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const {
  normaliseExtraction, parseDue, matchResolution, findReplyResolutions, pickCounterparty, sameObligation, buildExtractionMessages,
} = await import('./extract.js');
const { nearDuplicate, endOfDayInZone } = await import('./util.js');

const messageDate = new Date('2026-09-21T09:00:00Z');

describe('normaliseExtraction', () => {
  it('keeps well-formed items and tidies them', () => {
    const out = normaliseExtraction({
      commitments: [{ direction: 'I owe', counterparty: ' Priya Nair ', what: '  Send the signed   sponsorship form ', due: '2026-09-30', confidence: 0.9 }],
      facts: [{ key: 'Visa Reference #', value: 'VNT-2026-0448', confidence: '0.95' }],
      resolves: [{ what: 'Send passport scan', evidence: 'attached' }, 'Send degree certificate'],
    }, { messageDate });
    expect(out.commitments).toEqual([{
      direction: 'i_owe', counterparty: 'Priya Nair', what: 'Send the signed sponsorship form',
      due: new Date('2026-09-30T23:59:59Z'), confidence: 0.9,
    }]);
    expect(out.facts).toEqual([{ key: 'visa_reference', value: 'VNT-2026-0448', confidence: 0.95 }]);
    expect(out.resolves.map((r) => r.what)).toEqual(['Send passport scan', 'Send degree certificate']);
  });

  it('drops malformed, low-confidence and duplicate items', () => {
    const out = normaliseExtraction({
      commitments: [
        { direction: 'maybe', what: 'Do a thing', confidence: 1 },
        { direction: 'they_owe', what: 'Send slots', confidence: 0.3 },
        { direction: 'they_owe', what: 'x', confidence: 1 },
        { direction: 'they_owe', what: 'Send biometrics appointment slots', confidence: 0.9 },
        { direction: 'they_owe', what: 'Send the biometrics appointment slots', confidence: 0.8 },
        { direction: 'i_owe', what: 'Send the biometrics appointment slots', confidence: 0.8 },
        null,
      ],
      facts: [{ key: 'amount', value: '€1,600', confidence: 0.7 }, { key: 'amount', value: '€1,840', confidence: 0.9 }, { key: '', value: 'x', confidence: 1 }],
    }, { messageDate, minConfidence: 0.6 });
    expect(out.commitments.map((c) => [c.direction, c.what])).toEqual([
      ['they_owe', 'Send biometrics appointment slots'],
      ['i_owe', 'Send the biometrics appointment slots'],
    ]);
    expect(out.facts).toEqual([{ key: 'amount', value: '€1,840', confidence: 0.9 }]);
  });

  it('treats a missing confidence as 0.5 and percentages as fractions', () => {
    const out = normaliseExtraction({ commitments: [
      { direction: 'i_owe', what: 'Pay invoice 2041' },
      { direction: 'they_owe', what: 'Deliver the redesign', confidence: 85 },
    ] }, { messageDate, minConfidence: 0.6 });
    expect(out.commitments.map((c) => [c.what, c.confidence])).toEqual([['Deliver the redesign', 0.85]]);
  });

  it('returns empty lists for garbage', () => {
    for (const bad of [null, 'text', 42, { commitments: 'nope', facts: {} }]) {
      expect(normaliseExtraction(bad)).toEqual({ commitments: [], facts: [], resolves: [] });
    }
  });
});

describe('parseDue', () => {
  it('reads dates as the end of that day in the user zone', () => {
    expect(parseDue('2026-09-30', { messageDate }).toISOString()).toBe('2026-09-30T23:59:59.000Z');
    expect(parseDue('2026-09-30T00:00:00Z', { messageDate }).toISOString()).toBe('2026-09-30T23:59:59.000Z');
    expect(parseDue('2026-09-30', { messageDate, timeZone: 'Asia/Kolkata' }).toISOString()).toBe('2026-09-30T18:29:59.000Z');
    expect(parseDue('2026-09-30T15:00:00Z', { messageDate }).toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });
  it('rejects nonsense and implausible dates', () => {
    for (const v of [null, '', 'null', 'next week', '2026-02-31', '1999-01-01', '2040-01-01']) {
      expect(parseDue(v, { messageDate })).toBeNull();
    }
  });
  it('handles zones across DST', () => {
    expect(endOfDayInZone('2026-07-01', 'Europe/London').toISOString()).toBe('2026-07-01T22:59:59.000Z');
    expect(endOfDayInZone('2026-12-01', 'Europe/London').toISOString()).toBe('2026-12-01T23:59:59.000Z');
    expect(endOfDayInZone('2026-12-01', 'Not/AZone').toISOString()).toBe('2026-12-01T23:59:59.000Z');
  });
});

describe('dedupe and resolution', () => {
  it('recognises rewordings of one obligation', () => {
    expect(nearDuplicate('Send last three payslips to the solicitor', 'send the last 3 payslips to solicitor')).toBe(true);
    expect(nearDuplicate('Send payslips', 'Send the signed sponsorship form')).toBe(false);
  });

  it('treats two reply-style obligations to the same person in a thread as one', () => {
    const tracked = { direction: 'i_owe', what: 'Choose between Tuesday 10:30 or Thursday 16:00', counterparty_entity_id: 'dr' };
    expect(sameObligation(tracked, { direction: 'i_owe', what: 'Confirm follow-up appointment slot' }, 'dr')).toBe(true);
    expect(sameObligation(tracked, { direction: 'i_owe', what: 'Confirm follow-up appointment slot' }, 'other')).toBe(false);
    expect(sameObligation(tracked, { direction: 'they_owe', what: 'Confirm follow-up appointment slot' }, 'dr')).toBe(false);
  });

  it('matches a resolution to the best tracked commitment', () => {
    const open = [
      { id: 'form', what: 'Send the signed sponsorship form to the solicitor' },
      { id: 'docs', what: 'Send passport scan and degree certificate to Thomas Reed' },
    ];
    expect(matchResolution({ what: 'Passport scan and degree certificate' }, open).id).toBe('docs');
    expect(matchResolution({ what: 'Pay the cabin share' }, open)).toBeNull();
  });

  it("settles reply-style commitments with the owner's later reply or the other side's later message", () => {
    const commitments = [
      { id: 'c1', direction: 'i_owe', what: 'Confirm which slot works', source_date: '2026-09-01' },
      { id: 'c2', direction: 'i_owe', what: 'Send payslips', source_date: '2026-09-01' },
      { id: 'c3', direction: 'they_owe', what: 'Get back to me about the quote', counterparty_entity_id: 'marta', source_date: '2026-09-01' },
      { id: 'c4', direction: 'i_owe', what: 'Reply to Sam', source_date: '2026-09-10' },
    ];
    const messages = [
      { id: 'early-out', date: '2026-08-30', outgoing: true },
      { id: 'reply', date: '2026-09-02', outgoing: true },
      { id: 'other', date: '2026-09-03', outgoing: false, from_entity_id: 'someone' },
      { id: 'marta', date: '2026-09-04', outgoing: false, from_entity_id: 'marta' },
    ];
    expect(findReplyResolutions(commitments, messages)).toEqual([
      { commitmentId: 'c1', messageId: 'reply' },
      { commitmentId: 'c3', messageId: 'marta' },
    ]);
  });
});

describe('pickCounterparty', () => {
  const people = [
    { role: 'from', kind: 'self', name: 'Prakhar', email: 'me@x.example', entity_id: 'me' },
    { role: 'to', kind: 'person', name: 'Priya Nair', email: 'priya@vantage.example', entity_id: 'priya' },
    { role: 'cc', kind: 'person', name: 'Thomas Reed', email: 'thomas@reedlaw.example', entity_id: 'tom' },
  ];
  it('uses the named participant', () => {
    expect(pickCounterparty({ counterparty: 'Thomas Reed' }, people, true).entity_id).toBe('tom');
    expect(pickCounterparty({ counterparty: 'priya@vantage.example' }, people, true).entity_id).toBe('priya');
  });
  it('defaults to the other side of the message, and ignores a hint naming the owner', () => {
    expect(pickCounterparty({}, people, true).entity_id).toBe('priya');
    expect(pickCounterparty({ counterparty: 'Prakhar' }, people, true).entity_id).toBe('priya');
    expect(pickCounterparty({}, [{ role: 'from', kind: 'person', entity_id: 'p' }], false).entity_id).toBe('p');
  });
  it('returns null for a named third party who is not on the message', () => {
    expect(pickCounterparty({ counterparty: 'the landlord' }, people, false)).toBeNull();
  });
});

describe('extraction prompt', () => {
  it('carries the dates, owner, thread context and tracked items', () => {
    const msgs = buildExtractionMessages({
      row: { date: messageDate, is_outgoing: false, from_email: 'p@v.example', subject: 'Docs', to_addresses: [] },
      text: 'Please send the payslips by the 30th.',
      owner: { name: 'Prakhar', emails: ['me@v.example'] },
      thread: [{ from_email: 'me@v.example', subject: 'Re: Docs', date: '2026-09-10', body_text: 'Attached.' }],
      tracked: [{ direction: 'i_owe', what: 'Send the signed form' }],
      timeZone: 'UTC',
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('The email is dated 2026-09-21');
    expect(msgs[1].content).toContain('Prakhar <me@v.example>');
    expect(msgs[1].content).toContain('Attached.');
    expect(msgs[1].content).toContain('- [i_owe] Send the signed form');
  });
});
