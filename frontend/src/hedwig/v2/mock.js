// Local stand-in for the v2 backend routes, on when VITE_HEDWIG_MOCK=1. Every response follows
// the shapes in docs/hedwig/V2-BUILD.md (§APIs between streams); the data is the mockups' data
// (docs/hedwig/design). State is kept in memory so decisions, corrections and undo behave.
//
// The work routes (/work/lists, /work/thread, /work/draft, /work/snooze, /work/waiting,
// /work/sweep, /work/sendguard) answer with the shapes of backend/src/hedwig/work/routes.js.
// /mock/thread/:id stands in for upstream's /mail/thread (the messages); the admin prompt list
// has no owner in the contract yet. Stream lists page with ?limit and ?cursor like C's route.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function at(offsetMs) { return new Date(Date.now() - offsetMs).toISOString(); }
function todayAt(h, m) { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); }
function daysAgoAt(days, h, m) { const d = new Date(Date.now() - days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); }
function nextWeekday(dow) { const d = new Date(); d.setHours(17, 0, 0, 0); d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7 || 7)); return d.toISOString(); }

const ACCOUNT_WORK = 'acc-work';
const ACCOUNT_HOME = 'acc-home';

function item(id, from, subject, snippet, date, extra = {}) {
  return {
    threadId: `t-${id}`, messageId: `m-${id}`, from, subject, snippet, date,
    needsYou: false, reason: null, bundle: null, accountId: ACCOUNT_WORK, unread: false, ...extra,
  };
}

function seed() {
  return {
    streams: {
      people: [
        item('anna', { name: 'Anna Berg', email: 'anna.berg@northwind.example' }, 'Q3 report: can you send the final numbers?',
          'Hi, the board pack goes to print Friday morning.', todayAt(9, 40),
          { needsYou: true, reason: 'Asked for the report by Friday', unread: true }),
        item('marcus', { name: 'Marcus Oduya', email: 'marcus@oduya-lettings.example' }, 'Lease renewal, two options',
          'Attached are the two renewal options we discussed.', daysAgoAt(1, 16, 5),
          { needsYou: true, reason: 'Waiting four days · your landlord', unread: true, accountId: ACCOUNT_HOME }),
        item('kaur', { name: 'Dr. S. Kaur', email: 'reception@bergen-clinic.example' }, 'Confirm your appointment on 30 Sep',
          'Please confirm or rebook.', daysAgoAt(2, 10, 12),
          { needsYou: true, reason: 'A yes or no is all they need', unread: true, accountId: ACCOUNT_HOME }),
        item('lena', { name: 'Lena Park', email: 'lena.park@example.org' }, 'Photos from Saturday, and one question',
          'Here are the photos! Also, are you free on the 12th?', daysAgoAt(2, 8, 30),
          { needsYou: true, reason: 'Back from snooze', unread: true, accountId: ACCOUNT_HOME }),
        item('jonas', { name: 'Jonas Weber', email: 'jonas.weber@example.org' }, 'Re: Weekend plans',
          'sounds good, see you there', todayAt(11, 2), { accountId: ACCOUNT_HOME }),
        item('priya', { name: 'Priya Raman', email: 'priya@raman.example' }, "Thanks for the intro, I've reached out to Tom",
          'Tom and I are meeting next week.', todayAt(8, 15)),
        item('reminder', { name: 'Reminder', email: 'me@example.org' }, 'Call the dentist', '', todayAt(7, 0), { accountId: ACCOUNT_HOME }),
      ],
      reading: [
        item('ben', { name: "Benedict's Newsletter", email: 'ben@newsletter.example' }, 'Why on-device models change the browser',
          'This week: the browser becomes an inference runtime.', todayAt(6, 30), { unread: true, list: 'weekly.benedict.example' }),
        item('kommune', { name: 'Bergen Kommune', email: 'info@bergen.kommune.example' }, 'Road closures this weekend near Møhlenpris',
          'Planned works on Saturday and Sunday.', todayAt(8, 0), { unread: true, accountId: ACCOUNT_HOME }),
        item('hn', { name: 'Hacker Newsletter', email: 'kale@hackernewsletter.example' }, 'Four stories you usually open',
          '#712: compilers, keyboards and a very old modem.', daysAgoAt(1, 18, 0), { unread: true }),
        item('stratechery', { name: 'Stratechery', email: 'email@stratechery.example' }, 'The end of the beginning',
          'An update on the aggregation theory.', daysAgoAt(3, 7, 0)),
      ],
      records: [
        item('dhl', { name: 'DHL', email: 'noreply@dhl.example' }, 'Your parcel is out for delivery',
          'Running shoes, arriving today between 10:00 and 14:00.', todayAt(7, 12), { bundle: 'deliveries', unread: true }),
        item('posten', { name: 'Posten', email: 'varsel@posten.example' }, 'Two books arrive by 16:00',
          'Your parcel from Adlibris is on its way.', todayAt(6, 55), { bundle: 'deliveries', unread: true, accountId: ACCOUNT_HOME }),
        item('fjordkraft', { name: 'Fjordkraft', email: 'faktura@fjordkraft.example' }, 'Invoice for September: NOK 1,240',
          'Due Friday 26 September.', daysAgoAt(1, 9, 0), { bundle: 'bills', unread: true, accountId: ACCOUNT_HOME }),
        item('telia', { name: 'Telia', email: 'faktura@telia.example' }, 'Your mobile bill is ready', 'NOK 349, due 1 October.',
          daysAgoAt(2, 9, 0), { bundle: 'bills', accountId: ACCOUNT_HOME }),
        item('nordlys', { name: 'Nordlys Travel', email: 'booking@nordlystravel.example' }, 'Booking confirmed: Bergen, 3 nights',
          'Reference NT-44821.', daysAgoAt(3, 12, 0), { bundle: 'travel' }),
        item('sas', { name: 'SAS', email: 'noreply@flysas.example' }, 'Check-in opens for SK 1302', 'Oslo → Bergen, Thu 18:05.',
          daysAgoAt(1, 18, 5), { bundle: 'travel' }),
        item('github', { name: 'GitHub', email: 'noreply@github.example' }, '[team-aer/hedwig] CI passed on main', 'All checks have passed.',
          todayAt(5, 40), { bundle: 'notifications' }),
      ],
    },
    screener: [
      { key: 'nordlystravel.no', scope: 'domain', display: 'Nordlys Travel', address: 'booking@nordlystravel.no', count: 3,
        proposed: 'records', reason: 'Booking confirmations. You bought from this domain in June.', inSpam: false, lastMessageId: 'm-nordlys' },
      { key: 'list:benedict', scope: 'list', display: "Benedict's Newsletter", address: 'list · weekly', count: 1,
        proposed: 'reading', reason: 'A newsletter with an unsubscribe header.', inSpam: false, lastMessageId: 'm-ben' },
      { key: 'erik.haugen@proton.me', scope: 'address', display: 'Erik Haugen', address: 'erik.haugen@proton.me', count: 1,
        proposed: 'people', reason: 'He is replying to your mail from May, and the sender checks out.', inSpam: true, lastMessageId: 'm-erik' },
      { key: 'mail-secure-notice.top', scope: 'domain', display: 'Winner Selection Dept', address: 'prize@mail-secure-notice.top', count: 2,
        proposed: 'block', reason: 'Lookalike domain, fails sender checks, never written to.', inSpam: false, lastMessageId: 'm-prize' },
      { key: 'fjellsport.no', scope: 'domain', display: 'Fjellsport', address: 'kundeservice@fjellsport.no', count: 4,
        proposed: 'records', reason: 'Order and shipping updates for your June order.', inSpam: false, lastMessageId: 'm-fjell' },
      { key: 'maria.lopez@studio.example', scope: 'address', display: 'Maria López', address: 'maria.lopez@studio.example', count: 1,
        proposed: 'people', reason: 'Writes to you by name and Anna is in Cc.', inSpam: false, lastMessageId: 'm-maria' },
      { key: 'list:ruter', scope: 'list', display: 'Ruter', address: 'list · monthly', count: 2,
        proposed: 'reading', reason: 'Monthly service updates, you open about half.', inSpam: false, lastMessageId: 'm-ruter' },
    ],
    // C's /sort/today entry shape.
    log: [
      { id: 4, action: 'screen', messageId: 'm-nordlys', subject: 'Booking confirmed: Bergen, 3 nights', from: { name: 'Nordlys Travel', email: 'booking@nordlystravel.no' },
        before: { stream: 'screener' }, after: { stream: 'records', decision: 'records' }, by: 'auto', undone: false, undoable: true,
        text: 'Screened Nordlys Travel into Records', createdAt: at(2 * HOUR) },
      { id: 3, action: 'rescue', messageId: 'm-erik', subject: 'Re: the cabin in May', from: { name: 'Erik Haugen', email: 'erik.haugen@proton.me' },
        before: { spam: 'suspected' }, after: { spam: 'rescued', stream: 'people' }, by: 'auto', undone: false, undoable: true,
        text: 'Rescued Erik Haugen from spam', createdAt: at(3 * HOUR) },
      { id: 2, action: 'deliver', messageId: null, subject: null, from: null,
        before: null, after: { bundle: 'deliveries', name: 'Deliveries', count: 2 }, by: 'auto', undone: false, undoable: false,
        text: 'Delivered 2 in Deliveries', createdAt: at(4 * HOUR) },
      { id: 1, action: 'block', messageId: 'm-prize', subject: 'You have been selected!', from: { name: 'Winner Selection Dept', email: 'prize@mail-secure-notice.top' },
        before: { stream: 'screener' }, after: { decision: 'block' }, by: 'auto', undone: false, undoable: true,
        text: 'Blocked Winner Selection Dept', createdAt: at(5 * HOUR) },
    ],
    counts: { screened: 12, bundled: 40, rescued: 2, blocked: 9 },
    questions: [
      { id: 'q-anna', kind: 'sort', question: "You've replied to Anna Berg 14 times, usually within the hour. Keep her mail in People?",
        evidence: { replies: 14, medianReplyMinutes: 42 }, options: [{ id: 'yes', label: 'Yes', always: true }, { id: 'no', label: 'No' }] },
      { id: 'q-ruter', kind: 'needs_you', question: 'Ruter sends a monthly update. Should these ever need you?',
        evidence: { opened: 6, of: 12 }, options: [{ id: 'never', label: 'Never', always: true }, { id: 'sometimes', label: 'Sometimes' }] },
    ],
    rules: [
      { id: 'r-1', position: 1, name: 'Receipts to Records', enabled: true, conditions: { match: 'any', items: [{ field: 'subject', op: 'contains', value: 'receipt' }, { field: 'subject', op: 'contains', value: 'kvittering' }] },
        actions: [{ type: 'stream', value: 'records' }, { type: 'bundle', value: 'receipts' }], source: 'user', hits: 128, updated_at: at(20 * DAY) },
      { id: 'r-2', position: 2, name: 'Anna always in People', enabled: true, conditions: { match: 'all', items: [{ field: 'sender', op: 'is', value: 'anna.berg@northwind.example' }] },
        actions: [{ type: 'stream', value: 'people' }], source: 'correction', hits: 14, updated_at: at(3 * DAY) },
      { id: 'r-3', position: 3, name: 'GitHub CI to Notifications', enabled: false, conditions: { match: 'all', items: [{ field: 'sender', op: 'is', value: 'github.com' }, { field: 'subject', op: 'contains', value: 'CI' }] },
        actions: [{ type: 'stream', value: 'records' }, { type: 'bundle', value: 'notifications' }], source: 'user', hits: 402, updated_at: at(40 * DAY) },
    ],
    bundles: [
      { id: 'b-deliveries', key: 'deliveries', name: 'Deliveries', stream: 'records', schedule: { mode: 'instant' }, builtin: true, position: 1 },
      { id: 'b-bills', key: 'bills', name: 'Bills', stream: 'records', schedule: { mode: 'daily', at: '07:00' }, builtin: true, position: 2 },
      { id: 'b-travel', key: 'travel', name: 'Travel', stream: 'records', schedule: { mode: 'instant' }, builtin: true, position: 3 },
      { id: 'b-notifications', key: 'notifications', name: 'Notifications', stream: 'records', schedule: { mode: 'daily', at: '17:00' }, builtin: true, position: 4 },
      { id: 'b-receipts', key: 'receipts', name: 'Receipts', stream: 'records', schedule: { mode: 'weekly', day: 6, at: '09:00' }, builtin: true, position: 5 },
    ],
    // Work lists hold thread ids (t-…), as hedwig_work_items does.
    lists: { reply_later: ['t-priya', 't-jonas', 't-lena'], set_aside: ['t-stratechery', 't-hn'], snoozed: ['t-telia'] },
    reminders: [{ id: 7, note: 'Call the dentist about the crown', until: todayAt(8, 0) }],
    answers: [],
  };
}

let db = seed();
export function resetMock() { db = seed(); requestLog = []; }
/** Answers the mock received for the day's questions ({ id, optionId, always }), oldest first. */
export function mockAnswers() { return clone(db.answers); }

const ALL_ITEMS = () => [...db.streams.people, ...db.streams.reading, ...db.streams.records];
const findItem = (messageId) => ALL_ITEMS().find((i) => i.messageId === messageId) || null;
const findThread = (threadId) => ALL_ITEMS().find((i) => i.threadId === threadId) || null;

const LIST_ALIASES = { replyLater: 'reply_later', setAside: 'set_aside', snooze: 'snoozed' };
const listKind = (k) => LIST_ALIASES[k] || String(k || '').replace(/-/g, '_');
function listCounts() {
  const c = { reply_later: db.lists.reply_later.length, set_aside: db.lists.set_aside.length, pin: 0, reminder: db.reminders.length, done: 0, snoozed: db.lists.snoozed.length };
  return { ...c, replyLater: c.reply_later, setAside: c.set_aside };
}
function reminderRow(r) {
  return { threadId: `reminder:${r.id}`, messageId: null, from: { name: 'Reminder', email: null }, subject: r.note, snippet: '', date: r.until,
    needsYou: true, reason: 'You asked to be reminded', bundle: null, accountId: null, unread: true, synthetic: true, reminderId: r.id };
}

// Stream pages: ?limit (default 50) and an opaque ?cursor, like C's route.
function page(items, params) {
  const limit = Math.max(1, Math.min(200, Number.parseInt(params.get('limit'), 10) || 50));
  const from = params.get('cursor') ? Number.parseInt(atob(params.get('cursor')), 10) || 0 : 0;
  const slice = items.slice(from, from + limit);
  return { items: slice, next: from + limit < items.length ? btoa(String(from + limit)) : null };
}

const THREADS = {
  't-anna': {
    subject: 'Q3 report: can you send the final numbers?',
    label: 'Work',
    participants: 'Anna Berg and you',
    messages: [
      { id: 'm-anna-1', from: { name: 'Anna Berg', email: 'anna.berg@northwind.example' }, to: 'you', date: daysAgoAt(7, 10, 2),
        text: 'Here is the first draft of the Q3 report. Numbers are provisional.' },
      { id: 'm-anna-2', from: { name: 'You', email: 'me@example.org' }, to: 'Anna Berg', date: daysAgoAt(7, 15, 20),
        text: 'Thanks. Two revenue lines look off: services and licences are swapped on page 4.' },
      { id: 'm-anna-3', from: { name: 'Anna Berg', email: 'anna.berg@northwind.example' }, to: 'you', date: daysAgoAt(2, 9, 12),
        text: 'Corrected both lines, new version attached.' },
      { id: 'm-anna-4', from: { name: 'You', email: 'me@example.org' }, to: 'Anna Berg', date: daysAgoAt(2, 11, 0),
        text: 'Looks right now. I will send the final numbers this week.' },
      { id: 'm-anna', from: { name: 'Anna Berg', email: 'anna.berg@northwind.example' }, to: 'you', date: todayAt(9, 40),
        text: 'Hi, the board pack goes to print Friday morning. Could you send the final Q3 numbers by Thursday evening? The corrected revenue lines are already in.',
        trackersBlocked: 1 },
    ],
    // GET /work/thread's shape: citations numbered in order of first use, each naming a message.
    story: {
      text: "Anna sent a draft on 16 Sep and you flagged two revenue lines [1]. She corrected them on Monday [2] and now needs your final numbers before Friday's board pack [3].",
      citations: [{ n: 1, messageId: 'm-anna-2' }, { n: 2, messageId: 'm-anna-3' }, { n: 3, messageId: 'm-anna' }],
    },
    deadline: { figure: 'Fri', caption: 'Final Q3 numbers', messageId: 'm-anna', dueAt: nextWeekday(5), commitmentId: 'c-anna', direction: 'i_owe' },
    quickReplies: ['Yes, by Thursday evening.', 'Sending them now.', 'Can it wait until Friday 9am?'],
  },
};

function threadFor(threadId) {
  if (THREADS[threadId]) return THREADS[threadId];
  const it = ALL_ITEMS().find((i) => i.threadId === threadId || i.messageId === threadId);
  if (!it) return null;
  return {
    subject: it.subject,
    participants: `${it.from?.name || it.from?.email} and you`,
    messages: [{ id: it.messageId, from: it.from, to: 'you', date: it.date, text: it.snippet || it.subject }],
    story: null,
    deadline: null,
    quickReplies: [],
  };
}

const WHY = {
  'm-anna': { layer: 'classifier', reason: 'In People because you reply to Anna within an hour.', confidence: 0.94,
    signals: ['You replied to 14 of her last 15 messages', 'Median reply time 42 minutes', 'Addressed to you, not a list'],
    rule: null, promptId: null, promptVersion: null, model: null },
  'm-marcus': { layer: 'reflex', reason: 'He asked you to choose between two options four days ago.', confidence: 0.81,
    signals: ['Question addressed to you', 'No reply from you yet', 'Sender is in your contacts'],
    rule: null, promptId: 'sort.reflex', promptVersion: '2026-09-23.1', model: 'google/gemma-4-12B-it-qat-w4a16-ct' },
  'm-ben': { layer: 'rule', reason: 'A newsletter, so it waits in Reading.', confidence: 1,
    signals: [{ name: 'list', label: 'Mailing list weekly.benedict.example', weight: 0.6 }, { name: 'unsubscribe', label: 'Has an unsubscribe link', weight: 0.3 }],
    senderDecision: { key: 'weekly.benedict.example', scope: 'list', decision: 'reading', source: 'user' },
    rule: null, promptId: null, promptVersion: null, model: null },
  'm-dhl': { layer: 'rule', reason: 'A delivery notice, bundled with Deliveries.', confidence: 1,
    signals: ['From a carrier domain', 'Tracking number in the subject'], rule: { id: 'r-1', name: 'Deliveries' },
    promptId: null, promptVersion: null, model: null },
};

function whyFor(id) {
  if (WHY[id]) return WHY[id];
  const it = findItem(id);
  return {
    layer: 'reflex',
    reason: it?.reason || (it ? `In ${it.bundle ? 'Records' : 'this stream'} because of who it is from.` : 'Sorted by sender history.'),
    confidence: 0.72,
    signals: ['Sender history', 'Headers and list markers'],
    rule: null, promptId: 'sort.reflex', promptVersion: '2026-09-23.1', model: 'google/gemma-4-12B-it-qat-w4a16-ct',
  };
}

function notFound() { const e = new Error('Not found'); e.status = 404; return e; }
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

const clone = (v) => JSON.parse(JSON.stringify(v));

let logSeq = 100;
function logEntry(action, messageId, before, after, extra = {}) {
  const e = { id: ++logSeq, action, messageId, before, after, by: 'user', undone: false, undoable: true, createdAt: new Date().toISOString(), ...extra };
  db.log.unshift(e);
  return e;
}

// D's /insights/brief/today shape (insights/briefing.js compileBrief).
function brief() {
  const needs = db.streams.people.filter((i) => i.needsYou);
  const reasons = { 'm-anna': 'Due Friday, the board pack prints that morning', 'm-marcus': 'Two options on the table, waiting on you' };
  return {
    headline: 'Three things need you. Two parcels land today.',
    headlineSource: 'template',
    generatedAt: todayAt(7, 0),
    needsYou: needs.slice(0, 3).map((i) => ({ threadId: i.threadId, messageId: i.messageId, who: i.from?.name, subject: i.subject, reason: reasons[i.messageId] || i.reason, at: i.date })),
    waitingOn: [
      { threadId: 't-tom', messageId: 'm-tom', who: 'Tom Ellis', subject: 'the signed contract', reason: 'You asked on 17 Sep. Nothing back yet.', at: daysAgoAt(6, 10, 0), askedAt: daysAgoAt(6, 10, 0), nudgeDraftAvailable: true },
      { threadId: 't-nordlys', messageId: 'm-nordlys', who: 'Nordlys Travel', subject: 'Bergen invoice', reason: 'They promised it within 48 hours.', at: daysAgoAt(2, 10, 0), askedAt: daysAgoAt(2, 10, 0), nudgeDraftAvailable: true },
    ],
    cards: [
      { kind: 'deadline', figure: 'Today', caption: 'Running shoes · DHL, out for delivery', messageId: 'm-dhl', dueAt: todayAt(14, 0) },
      { kind: 'deadline', figure: 'Today', caption: 'Two books · Posten, by 16:00', messageId: 'm-posten', dueAt: todayAt(16, 0) },
      { kind: 'deadline', figure: 'Fri', caption: 'Electricity, NOK 1,240 · Fjordkraft', messageId: 'm-fjordkraft', dueAt: nextWeekday(5) },
      { kind: 'attachment', figure: 'contract.pdf', caption: 'Lease renewal, option B: 24 months', messageId: 'm-marcus' },
    ],
    reading: db.streams.reading.slice(0, 3).map((i) => ({ title: i.subject, line: i.snippet, messageId: i.messageId, threadId: i.threadId, source: i.from?.name })),
    questions: clone(db.questions),
    today: { ...db.counts },
  };
}

function route(method, path, body) {
  const [pathname, qs] = path.split('?');
  const params = new URLSearchParams(qs || '');
  const seg = pathname.split('/').filter(Boolean);

  // ── C: sorting ──────────────────────────────────────────────────────────
  if (seg[0] === 'sort') {
    if (method === 'GET' && seg[1] === 'stream' && seg[2]) {
      const list = db.streams[seg[2]];
      if (!list) throw notFound();
      let items = clone(list).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (seg[2] === 'people') {
        const snoozed = new Set(db.lists.snoozed);
        items = items.filter((i) => !snoozed.has(i.threadId));
        if (!params.get('cursor')) items = [...db.reminders.filter((r) => new Date(r.until) <= new Date()).map(reminderRow), ...items];
      }
      if (params.get('needsYou') === '1') items = items.filter((i) => i.needsYou);
      return page(items, params);
    }
    if (method === 'GET' && seg[1] === 'screener') return { senders: clone(db.screener) };
    if (method === 'POST' && seg[1] === 'screener' && seg[2] === 'decide') {
      if (body?.all && !body.key) {
        const n = db.screener.length;
        for (const s of db.screener) logEntry('screen', s.lastMessageId, { stream: 'screener' }, { stream: s.proposed }, { subject: null, from: { name: s.display, email: s.address }, text: `Screened ${s.display} into ${s.proposed}` });
        db.screener = [];
        return { ok: true, decided: n };
      }
      const s = db.screener.find((x) => x.key === body?.key && (!body.scope || x.scope === body.scope));
      if (!s) throw notFound();
      if (!['people', 'reading', 'records', 'block'].includes(body.decision)) throw bad('decision must be people, reading, records or block');
      db.screener = db.screener.filter((x) => x !== s);
      logEntry(body.decision === 'block' ? 'block' : 'screen', s.lastMessageId, { stream: 'screener' }, { stream: body.decision, decision: body.decision }, { from: { name: s.display, email: s.address }, text: `Screened ${s.display} into ${body.decision}` });
      return { ok: true };
    }
    if (method === 'POST' && seg[1] === 'correct') {
      if (!body?.messageId) throw bad('messageId is required');
      const it = findItem(body.messageId);
      if (body.always === 'list' && !it?.list) throw bad('This message did not come from a mailing list; pick the sender or the kind instead.');
      const before = it ? { stream: Object.keys(db.streams).find((k) => db.streams[k].includes(it)), needsYou: it.needsYou } : {};
      if (it && body.stream && before.stream !== body.stream && db.streams[body.stream]) {
        db.streams[before.stream] = db.streams[before.stream].filter((x) => x !== it);
        db.streams[body.stream].push(it);
        if (body.stream !== 'records') it.bundle = null;
      }
      if (it && typeof body.needsYou === 'boolean') { it.needsYou = body.needsYou; if (!body.needsYou) it.reason = null; }
      const entry = logEntry('correct', body.messageId, before, { stream: body.stream, needsYou: body.needsYou, always: body.always || null }, { subject: it?.subject, from: it?.from || null, text: `You moved it to ${body.stream || 'its stream'}` });
      return { ok: true, logId: entry.id, rule: body.always ? { id: `r-${Date.now()}`, name: `Always ${body.stream || 'sort'} (${body.always})` } : null };
    }
    if (method === 'GET' && seg[1] === 'today') {
      return { since: todayAt(0, 0), ...db.counts, entries: clone(db.log) };
    }
    if (method === 'POST' && seg[1] === 'undo') {
      const e = db.log.find((x) => x.id === Number(body?.logId));
      if (!e) throw notFound();
      if (e.undone) { const err = new Error('Already undone'); err.status = 409; throw err; }
      e.undone = true;
      e.undoable = false;
      return { ok: true };
    }
    if (method === 'GET' && seg[1] === 'bundles') return { bundles: clone(db.bundles) };
    if (method === 'POST' && seg[1] === 'bundles') {
      const b = { id: `b-${Date.now()}`, key: String(body?.name || 'custom').toLowerCase().replace(/\W+/g, '-'), name: body?.name || 'Custom', description: body?.description || '', schedule: body?.schedule || { times: ['07:00'] }, builtin: false, position: db.bundles.length + 1 };
      db.bundles.push(b);
      return b;
    }
    if (method === 'PATCH' && seg[1] === 'bundles' && seg[2]) {
      const b = db.bundles.find((x) => x.id === seg[2]);
      if (!b) throw notFound();
      if (body?.schedule) b.schedule = body.schedule;
      return { bundle: clone(b) };
    }
    if (method === 'GET' && seg[1] === 'rules') return { rules: clone(db.rules), max: 200 };
    if (method === 'POST' && seg[1] === 'rules' && seg[3] === 'dryrun') {
      const r = db.rules.find((x) => x.id === seg[2]);
      if (!r) throw notFound();
      const sample = ALL_ITEMS().slice(0, 3).map((i) => ({ messageId: i.messageId, from: i.from, subject: i.subject, date: i.date }));
      return { matched: r.hits, scanned: 2000, approximate: false, sample };
    }
    if (method === 'POST' && seg[1] === 'rules' && !seg[2]) {
      const r = { id: `r-${Date.now()}`, position: db.rules.length + 1, name: body?.name || 'New rule', enabled: body?.enabled !== false, conditions: body?.conditions || {}, actions: body?.actions || {}, source: 'user', hits: 0, updated_at: new Date().toISOString() };
      db.rules.push(r);
      return r;
    }
    if (method === 'GET' && seg[1] === 'message' && seg[3] === 'why') return clone(whyFor(seg[2]));
  }

  // ── D: labels ───────────────────────────────────────────────────────────
  if (seg[0] === 'labels' && seg[1] === 'questions') {
    if (method === 'GET' && !seg[2]) return { questions: clone(db.questions) };
    const q = db.questions.find((x) => x.id === seg[2]);
    if (!q) throw notFound();
    if (method === 'POST' && (seg[3] === 'answer' || seg[3] === 'skip')) {
      if (seg[3] === 'answer') {
        const option = (q.options || []).find((o) => o.id === body?.optionId);
        if (!option) throw bad('Unknown option');
        if (body.always && !option.always) throw bad('This option cannot be applied always');
        db.answers.push({ id: q.id, optionId: option.id, always: body.always ?? null });
      }
      db.questions = db.questions.filter((x) => x !== q);
      return { ok: true };
    }
  }

  // ── A: index ────────────────────────────────────────────────────────────
  if (method === 'GET' && seg[0] === 'index' && seg[1] === 'status') {
    const row = (accountId, account, folder, state, total, seen, bodies, chunked, embedded, error, ago) => ({
      accountId, account, folder, spam: false, state, total, seen, duplicates: 0, bodies, bodyFailed: 0, chunked, embedded, error, updatedAt: at(ago),
      pct: { seen: Math.round((seen / total) * 100), bodies: Math.round((bodies / total) * 100), chunked: Math.round((chunked / total) * 100), embedded: Math.round((embedded / total) * 100) },
    });
    const coverage = [
      row(ACCOUNT_WORK, 'Work', 'INBOX', 'done', 18432, 18432, 18432, 18432, 18410, null, HOUR),
      row(ACCOUNT_WORK, 'Work', 'Sent', 'running', 6120, 6120, 5200, 4980, 4100, null, 60_000),
      row(ACCOUNT_HOME, 'Home', 'INBOX', 'done', 9210, 9210, 9210, 9210, 9210, null, 2 * HOUR),
      row(ACCOUNT_HOME, 'Home', 'Archive', 'paused', 22000, 22000, 3100, 3000, 2900, 'Paused: token budget for today used', 5 * HOUR),
    ];
    return {
      coverage, total: 55762, chunked: 35622, embedded: 34620, pending: 21140,
      pct: { chunked: 64, embedded: 62 }, recipe: { active: 'v1:bge-m3', target: 'v1:bge-m3', vectors: true, note: null },
      chunks: 88410, vectors: 86120, attachments: 1204, embedError: null, done: false,
    };
  }

  // ── insights: the Daily Brief ─────────────────────────────────────────
  if (method === 'GET' && pathname === '/insights/brief/today') return brief();

  // ── F: working the inbox ──────────────────────────────────────────────
  if (seg[0] === 'work') {
    if (seg[1] === 'lists') {
      if (method === 'GET' && !seg[2]) return listCounts();
      const kind = listKind(seg[2]);
      if (kind === 'reminder' && method === 'GET') return { kind, items: db.reminders.map(reminderRow), next: null };
      if (!db.lists[kind]) throw bad('list must be one of reply_later, set_aside, pin, reminder, done, snoozed');
      if (method === 'GET') {
        const items = db.lists[kind].map((t, i) => {
          const it = findThread(t);
          return it ? { ...clone(it), itemId: i + 1, note: null, until: kind === 'snoozed' ? todayAt(18, 0) : null, position: i + 1, addedAt: at(DAY) } : null;
        }).filter(Boolean);
        return { kind, items, next: null };
      }
      if (method === 'POST') {
        if (kind === 'snoozed') throw bad('Snooze through POST /work/snooze');
        if (!body?.threadId) throw bad('threadId is required');
        if (!findThread(body.threadId)) throw notFound();
        db.lists[kind] = [...new Set([...db.lists[kind], body.threadId])];
        return { item: clone(findThread(body.threadId)), counts: listCounts() };
      }
      if (method === 'DELETE' && seg[3]) {
        if (kind === 'snoozed') throw bad('A snooze ends by itself; move the message back from Snoozed to cancel it');
        db.lists[kind] = db.lists[kind].filter((t) => t !== decodeURIComponent(seg[3]));
        return { ok: true, counts: listCounts() };
      }
    }
    if (method === 'POST' && seg[1] === 'snooze') {
      const it = body?.messageId ? findItem(body.messageId) : findThread(body?.threadId);
      if (!it) throw notFound();
      db.lists.snoozed = [...new Set([...db.lists.snoozed, it.threadId])];
      return { ok: true, threadId: it.threadId, messageId: it.messageId, until: body.until || todayAt(18, 0), moved: 1 };
    }
    if (method === 'GET' && seg[1] === 'thread' && seg[2]) {
      const t = threadFor(decodeURIComponent(seg[2]));
      if (!t) throw notFound();
      const last = t.messages[t.messages.length - 1];
      return {
        threadId: decodeURIComponent(seg[2]), upToMessageId: last?.id,
        story: t.story ? clone(t.story) : null,
        timeline: t.messages.map((m) => ({ messageId: m.id, at: m.date, who: m.from?.name || m.from?.email, kind: 'message', line: String(m.text || '').slice(0, 90) })),
        quickReplies: clone(t.quickReplies || []),
        ...(t.deadline ? { deadline: clone(t.deadline) } : {}),
        provenance: {}, cached: true,
      };
    }
    if (method === 'POST' && seg[1] === 'draft') {
      if (!body?.threadId && !(body?.text && body?.tone)) throw bad('threadId is required (or text with a tone to rewrite)');
      if (body.tone && body.text) return { mode: 'rewrite', draft: body.text, before: body.text, after: body.text, tone: body.tone, provenance: {} };
      return {
        mode: 'reply', provenance: {},
        draft: 'Hi Anna, yes, you will have the final Q3 numbers by Thursday evening. Thanks for fixing the revenue lines.',
        reply: { inReplyToMessageId: 'm-anna', to: [{ name: 'Anna Berg', email: 'anna.berg@northwind.example' }], subject: 'Re: Q3 report: can you send the final numbers?' },
      };
    }
    if (method === 'GET' && seg[1] === 'waiting' && !seg[2]) {
      return [
        { threadId: 't-tom', messageId: 'm-tom', who: 'Tom Ellis', subject: 'the signed contract', askedAt: daysAgoAt(6, 10, 0), days: 6, nudgeDraftAvailable: true },
        { threadId: 't-nordlys', messageId: 'm-nordlys', who: 'Nordlys Travel', subject: 'Bergen invoice', askedAt: daysAgoAt(2, 10, 0), days: 2, nudgeDraftAvailable: true },
      ];
    }
    if (method === 'POST' && seg[1] === 'waiting' && seg[3] === 'nudge') return { draft: 'Hi Tom, just checking in on the signed contract.', reply: null, provenance: {} };
    if (method === 'POST' && seg[1] === 'waiting' && seg[3] === 'resolve') return { ok: true };
    if (method === 'POST' && seg[1] === 'waiting' && !seg[2]) return { ok: true };
    if (method === 'POST' && seg[1] === 'sweep') return { marked: 0, before: body?.before || body?.day || null, after: null };
    if (method === 'POST' && seg[1] === 'sendguard') {
      const warnings = [];
      const m = /\b(attached|attachment|enclosed)\b/i.exec(String(body?.body || ''));
      if (m && !(body?.attachments || []).length) warnings.push({ kind: 'missing_attachment', text: `You mention “${m[1].toLowerCase()}” but nothing is attached.` });
      return { warnings };
    }
  }

  // Stands in for upstream's GET /mail/thread/:threadKey (the messages), under the mock only.
  if (method === 'GET' && seg[0] === 'mock' && seg[1] === 'thread' && seg[2]) {
    const t = threadFor(decodeURIComponent(seg[2]));
    if (!t) throw notFound();
    return { subject: t.subject, label: t.label || null, participants: t.participants || null, messages: clone(t.messages) };
  }

  // Not in the contract (B would own it): prompt versions, admin only.
  if (method === 'GET' && pathname === '/admin/prompts') {
    return { prompts: [
      { id: 'sort.reflex', version: '2026-09-23.1', tier: 'reflex', hash: 'a41f9c2', updated_at: at(2 * HOUR) },
      { id: 'sort.screener', version: '2026-09-23.1', tier: 'reflex', hash: '7be0d13', updated_at: at(2 * HOUR) },
      { id: 'spam.reflex', version: '2026-09-22.2', tier: 'reflex', hash: '19c4a70', updated_at: at(DAY) },
      { id: 'labels.judge', version: '2026-09-23.1', tier: 'reasoning', hash: 'e02d5b8', updated_at: at(3 * HOUR) },
    ] };
  }

  throw notFound();
}

let requestLog = [];
/** Every request the mock answered since the last reset ("GET /sort/screener"), for tests. */
export function mockRequests({ clear = false } = {}) { const out = requestLog; if (clear) requestLog = []; return out; }

/** Add rows to a stream (tests: long lists, new mail arriving). */
export function mockAddItems(stream, rows) {
  db.streams[stream].push(...rows.map((r, i) => item(r.id || `extra-${stream}-${db.streams[stream].length + i}`, r.from || { name: `Sender ${i}`, email: `s${i}@example.org` }, r.subject || `Message ${i}`, r.snippet || '', r.date || new Date().toISOString(), r)));
}

/** Answer one request like hedwigApi would: resolves with the JSON body or rejects with .status. */
export async function mockRequest(method, path, body) {
  requestLog.push(`${method} ${path}`);
  await new Promise((r) => setTimeout(r, 0));
  return route(method, path, body);
}
