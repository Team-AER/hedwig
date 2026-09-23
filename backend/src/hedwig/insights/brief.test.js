import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ routes: [], calls: [] }));
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ');
    db.calls.push(text);
    for (const [re, fn] of db.routes) if (re.test(text)) return fn(params);
    return { rows: [] };
  }),
}));
const chat = vi.hoisted(() => vi.fn(async () => { throw new Error('the Brief must not call a model'); }));
vi.mock('../llm.js', () => ({ chat }));
const triage = vi.hoisted(() => ({
  calls: [],
  listTriage: async (userId, { view }) => {
    triage.calls.push(view);
    return {
      items: view === 'needs_you'
        ? [{ message: { id: 'm1', from_name: 'Priya', from_email: 'p@x.com', subject: 'Sign the form', date: '2026-09-23T08:00:00Z', thread_key: 't1' }, triage: { reason_label: 'Asks you to sign' } }]
        : [{ message: { id: 'm2', from_name: 'Me', from_email: 'me@x.com', subject: 'Quote?', date: '2026-09-18T08:00:00Z', thread_key: 't2' }, triage: { reason_label: 'Waiting 5 d' } }],
    };
  },
}));
vi.mock('../triage/service.js', () => ({ listTriage: (...args) => triage.listTriage(...args) }));
vi.mock('../labels/questions.js', () => ({ listOpenQuestions: async () => [{ id: 'q1', kind: 'spam', question: 'Junk?', evidence: {}, options: [] }] }));
const sortToday = vi.hoisted(() => ({ entries: [] }));
vi.mock('../sort/service.js', () => ({ today: async () => ({ screened: 4, bundled: 9, rescued: 1, blocked: 2, entries: sortToday.entries }) }));
vi.mock('../hooks.js', () => ({ HEDWIG_HOOKS: {}, collectHedwigHook: async () => [] }));

const { briefHeadline, headlineFromBriefing, dueFigure, compileBrief } = await import('./briefing.js');

const NOW = Date.parse('2026-09-23T10:00:00Z');

describe('brief pieces', () => {
  it('headline template', () => {
    expect(briefHeadline({ needsYou: 3, deadlinesToday: 2 })).toBe('Three things need you. Two deadlines today.');
    expect(briefHeadline({ needsYou: 1, waitingOn: 1 })).toBe("One thing needs you. You're waiting on one reply.");
    expect(briefHeadline({ needsYou: 0 })).toBe('Nothing needs you.');
    expect(briefHeadline({ needsYou: 14, deadlinesToday: 1 })).toBe('14 things need you. One deadline today.');
  });
  it('cached headline is the model briefing opening line without markdown or citations', () => {
    expect(headlineFromBriefing('**A calm day** with one reply owed to Priya [1].\n\n### Needs you\n- x')).toBe('A calm day with one reply owed to Priya .');
    expect(headlineFromBriefing('### Needs you\n- Priya asks you to sign the visa form')).toBe('Priya asks you to sign the visa form');
    expect(headlineFromBriefing('')).toBeNull();
  });
  it('due figures in the user timezone', () => {
    expect(dueFigure('2026-09-23T18:00:00Z', 'UTC', NOW)).toBe('Today');
    expect(dueFigure('2026-09-24T09:00:00Z', 'UTC', NOW)).toBe('Tomorrow');
    expect(dueFigure('2026-09-26T09:00:00Z', 'UTC', NOW)).toBe('Sat 26');
    expect(dueFigure('2026-09-20T09:00:00Z', 'UTC', NOW)).toBe('Overdue');
  });
});

describe('compileBrief', () => {
  beforeEach(() => { db.calls.length = 0; chat.mockClear(); sortToday.entries = []; });

  it('"what Hedwig did" carries the newest undoable log entries, and the prose flag says where today\'s briefing came from', async () => {
    sortToday.entries = [
      { id: 7, action: 'screen', text: 'Screened deals@shop.example into Reading', messageId: 'm7', subject: 'Sale', undoable: true, createdAt: '2026-09-23T08:00:00Z' },
      { id: 6, action: 'correct', text: 'You moved a message', undoable: false },
    ];
    db.routes = [
      [/SELECT to_regclass/, ([name]) => ({ rows: [{ t: name === 'hedwig_sort_log' ? name : null }] })],
      [/FROM hedwig_insights WHERE user_id = \$1 AND kind = 'briefing'/, () => ({ rows: [{ id: 'i1', kind: 'briefing', body: 'x', data: { generated_by: 'deterministic', fallback_reason: 'tier2_degraded' }, created_at: new Date(NOW - 3600_000).toISOString() }] })],
    ];
    const brief = await compileBrief('u1', { now: NOW });
    expect(brief.today).toMatchObject({ undoable: 1, entries: [{ id: 7, action: 'screen', text: 'Screened deals@shop.example into Reading', messageId: 'm7' }] });
    expect(brief.prose).toMatchObject({ insightId: 'i1', source: 'template', fallback: true, reason: 'tier2_degraded' });
    expect(brief.headlineSource).toBe('template');
    expect(chat).not.toHaveBeenCalled();
  });

  it('assembles every section from stored data and never calls a model', async () => {
    db.routes = [
      [/SELECT to_regclass/, ([name]) => ({ rows: [{ t: name === 'hedwig_sort_log' ? name : null }] })],
      [/FROM hedwig_commitments WHERE user_id = \$1 AND status = 'open'/, () => ({ rows: [
        { id: 'c1', direction: 'i_owe', counterparty: 'Priya', what: 'Send the signed form', due_at: '2026-09-23T17:00:00Z', source_message_id: 'm1' },
        { id: 'c2', direction: 'they_owe', counterparty: null, what: 'Invoice', due_at: '2026-09-25T17:00:00Z', source_message_id: null },
      ] })],
      [/m\.to_addresses FROM messages m JOIN email_accounts/, () => ({ rows: [{ id: 'm2', to_addresses: [{ name: 'Ola', address: 'ola@y.com' }] }] })],
      [/open_rate/, () => ({ rows: [{ id: 'r1', subject: 'Weekly notes', snippet: 'This week we shipped the new search. Also other things.', open_rate: 0.8 }] })],
      [/kind = 'briefing' AND dismissed_at IS NULL/, () => ({ rows: [{ id: 'b1', kind: 'briefing', body: 'A quiet morning: Priya needs a signature [1].', data: { generated_by: 'model' }, created_at: new Date(NOW - 2 * 3600_000) }] })],
    ];
    const brief = await compileBrief('u1', { now: NOW });
    expect(chat).not.toHaveBeenCalled();
    expect(brief.headline).toBe('A quiet morning: Priya needs a signature .');
    expect(brief.headlineSource).toBe('briefing');
    expect(brief.needsYou).toEqual([{ threadId: 't1', messageId: 'm1', who: 'Priya', subject: 'Sign the form', reason: 'Asks you to sign', at: '2026-09-23T08:00:00Z' }]);
    expect(brief.waitingOn[0]).toMatchObject({ threadId: 't2', messageId: 'm2', who: 'Ola', askedAt: '2026-09-18T08:00:00Z' });
    expect(typeof brief.waitingOn[0].nudgeDraftAvailable).toBe('boolean');
    expect(brief.cards).toEqual([
      { kind: 'deadline', figure: 'Today', caption: 'Send the signed form · Priya', messageId: 'm1', dueAt: '2026-09-23T17:00:00Z' },
      { kind: 'deadline', figure: 'Fri 25', caption: 'Invoice', messageId: null, dueAt: '2026-09-25T17:00:00Z' },
    ]);
    expect(brief.reading).toEqual([{ title: 'Weekly notes', line: 'This week we shipped the new search.', messageId: 'r1' }]);
    expect(brief.questions).toHaveLength(1);
    expect(brief.today).toEqual({ screened: 4, bundled: 9, rescued: 1, blocked: 2, undoable: 0, entries: [] });
  });

  it('counts what needs you by conversation, as the People stream does', async () => {
    db.routes = [
      [/SELECT to_regclass/, ([name]) => ({ rows: [{ t: name === 'hedwig_sort' ? name : null }] })],
      [/FROM hedwig_sort s JOIN messages m ON m\.id = s\.message_id JOIN email_accounts a[\s\S]*hedwig_work_needs/, () => ({ rows: [
        { id: 'm5', thread_key: 'doc', from_name: 'Dr Anand', subject: 'Re: Follow-up', date: '2026-09-22T15:00:00Z', reason: 'Pick a slot' },
        { id: 'm6', thread_key: 'marta', from_name: 'Marta', subject: 'Invoice 2041', date: '2026-09-23T06:00:00Z', reason: 'Amount differs' },
      ] })],
    ];
    const brief = await compileBrief('u1', { now: NOW });
    const sql = db.calls.find((s) => /FROM hedwig_work_needs w/.test(s));
    expect(sql).toContain('DISTINCT ON (m.account_id, COALESCE(m.thread_key, m.id::text))');
    // One Needs you list: sorting's flag or a reason work derived (reply overdue, deadline near).
    expect(sql).toMatch(/s\.needs_you AND m\.date > NOW\(\) - INTERVAL '14 days'\) OR \(wn\.reason IS NOT NULL/);
    expect(brief.needsYou.map((n) => n.messageId)).toEqual(['m5', 'm6']);
    expect(brief.headline.startsWith('Two things need you.')).toBe(true);
  });

  it('falls back to the template headline when no fresh model briefing exists', async () => {
    db.routes = [
      [/SELECT to_regclass/, () => ({ rows: [{ t: null }] })],
      [/FROM hedwig_commitments WHERE user_id = \$1 AND status = 'open'/, () => ({ rows: [{ id: 'c1', what: 'Pay rent', due_at: '2026-09-23T17:00:00Z', source_message_id: 'm9' }] })],
    ];
    const brief = await compileBrief('u1', { now: NOW });
    expect(brief.headline).toBe('One thing needs you. One deadline today.');
    expect(brief.headlineSource).toBe('template');
    expect(brief.today).toEqual({ screened: 0, bundled: 0, rescued: 0, blocked: 0, undoable: null, entries: [] });
    expect(db.calls.some((s) => s.includes('hedwig_sort_log'))).toBe(false);
  });
});
