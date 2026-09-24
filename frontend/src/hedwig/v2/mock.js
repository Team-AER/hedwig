// Local stand-in for the v2 backend routes, on when VITE_HEDWIG_MOCK=1. Every response follows
// the shapes in docs/hedwig/V2-BUILD.md (§APIs between streams); the data is the mockups' data
// (docs/hedwig/design). State is kept in memory so decisions, corrections and undo behave.
//
// The work routes (/work/lists, /work/thread, /work/draft, /work/snooze, /work/waiting,
// /work/sweep, /work/sendguard) answer with the shapes of backend/src/hedwig/work/routes.js.
// /mock/thread/:id stands in for upstream's /mail/thread (the messages); the admin prompt list
// has no owner in the contract yet. Stream lists page with ?limit and ?cursor like C's route.
// The cards routes (/cards, /cards/message/:id, /cards/:id/actions, PATCH /cards/:id, dismiss,
// not-recurring, not-kind, restore, /cards/feedback,
// /cards/ledger/:kind) follow backend/src/hedwig/cards; Ask (/context/ask as a stream through
// mockStream, /context/ask/history, /context/ask/:id, feedback) follows backend/src/hedwig/ask2.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function at(offsetMs) { return new Date(Date.now() - offsetMs).toISOString(); }
function todayAt(h, m) { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); }
function daysAgoAt(days, h, m) { const d = new Date(Date.now() - days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); }
function localDay(v) { const d = new Date(v); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dayOffset(days) { return localDay(Date.now() + days * DAY); }
function daysAheadAt(days, h, m) { const d = new Date(Date.now() + days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); }
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
          { needsYou: true, reason: 'Asked for the report by Friday', unread: true, tldr: { text: 'Wants the final Q3 numbers by Thursday evening for Friday’s board pack.', lighter: false, model: 'google/gemma-4-12B-it-qat-w4a16-ct' } }),
        item('marcus', { name: 'Marcus Oduya', email: 'marcus@oduya-lettings.example' }, 'Lease renewal, two options',
          'Attached are the two renewal options we discussed.', daysAgoAt(1, 16, 5),
          { needsYou: true, reason: 'Waiting four days · your landlord', unread: true, accountId: ACCOUNT_HOME, tldr: { text: 'Two renewal options: 12 months at the same rent, or 24 months with a 3% rise.', lighter: false, model: 'google/gemma-4-12B-it-qat-w4a16-ct' } }),
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
        item('vipps', { name: 'Vipps', email: 'no-reply@vipps.example' }, 'Your Vipps code', 'Use 482913 to confirm. It expires in 10 minutes.',
          at(3 * 60_000), { bundle: 'notifications', unread: true, accountId: ACCOUNT_HOME }),
        item('spotify', { name: 'Spotify', email: 'no-reply@spotify.example' }, 'Your Spotify Premium receipt', 'NOK 129 charged for Premium Individual.',
          daysAgoAt(6, 4, 10), { bundle: 'receipts', accountId: ACCOUNT_HOME }),
        item('fjell', { name: 'Fjellsport', email: 'kundeservice@fjellsport.example' }, 'Order FS-20931 confirmed', 'Running shoes, NOK 1,299.',
          daysAgoAt(4, 12, 30), { bundle: 'receipts', accountId: ACCOUNT_HOME }),
      ],
    },
    screener: [
      { key: 'nordlystravel.no', scope: 'domain', display: 'Nordlys Travel', address: 'booking@nordlystravel.no', count: 3,
        proposed: 'records', reason: 'Booking confirmations. You bought from this domain in June.', inSpam: false, lastMessageId: 'm-nordlys',
        subjects: ['Booking confirmed: Bergen, 3 nights'] },
      { key: 'list:benedict', scope: 'list', display: "Benedict's Newsletter", address: 'list · weekly', count: 1,
        proposed: 'reading', reason: 'A newsletter with an unsubscribe header.', inSpam: false, lastMessageId: 'm-ben' },
      { key: 'erik.haugen@proton.me', scope: 'address', display: 'Erik Haugen', address: 'erik.haugen@proton.me', count: 1,
        proposed: 'people', reason: 'He is replying to your mail from May, and the sender checks out.', inSpam: true, lastMessageId: 'm-erik' },
      { key: 'mail-secure-notice.top', scope: 'domain', display: 'Winner Selection Dept', address: 'prize@mail-secure-notice.top', count: 2,
        proposed: 'block', reason: 'Lookalike domain, fails sender checks, never written to.', inSpam: false, lastMessageId: 'm-prize' },
      { key: 'fjellsport.no', scope: 'domain', display: 'Fjellsport', address: 'kundeservice@fjellsport.no', count: 4,
        proposed: 'records', reason: 'Order and shipping updates for your June order.', inSpam: false, lastMessageId: 'm-fjell' },
      { key: 'maria.lopez@studio.example', scope: 'address', display: 'Maria López', address: 'maria.lopez@studio.example', count: 1,
        proposed: 'people', reason: 'Writes to you by name and Anna is in Cc.', inSpam: false, lastMessageId: 'm-maria', subjects: ['Studio visit next week?'] },
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
      { id: 'q-anna', kind: 'sort', messageId: 'm-anna', question: "You've replied to Anna Berg 14 times, usually within the hour. Keep her mail in People?",
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
    // Already due whatever the time of day (08:00 today is still ahead just after midnight).
    reminders: [{ id: 7, note: 'Call the dentist about the crown', until: at(HOUR) }],
    answers: [],
    cards: seedCards(),
    cardFeedback: [],
    // F's /work/waiting rows; watches are the "remind me if no reply" requests.
    waiting: [
      { threadId: 't-tom', messageId: 'm-tom', who: 'Tom Ellis', whoEmail: 'tom@ellis.example', subject: 'the signed contract', askedAt: daysAgoAt(6, 10, 0), days: 6, nudgeDraftAvailable: true,
        reason: 'You asked for the signed contract', source: 'triage', accountId: ACCOUNT_WORK },
      { threadId: 't-nordlys', messageId: 'm-nordlys', who: 'Nordlys Travel', whoEmail: 'booking@nordlystravel.example', subject: 'Bergen invoice', askedAt: daysAgoAt(2, 10, 0), days: 2, nudgeDraftAvailable: true,
        reason: 'They promised it within 48 hours', source: 'triage', accountId: ACCOUNT_WORK },
      { threadId: 't-lena', messageId: 'm-lena', who: 'Lena Park', whoEmail: 'lena.park@example.org', subject: 'Photos from Saturday, and one question', askedAt: daysAgoAt(3, 18, 0), days: 3, nudgeDraftAvailable: true,
        reason: 'No reply in 3 days, as you asked to be reminded', source: 'watch', remindAfterDays: 3, accountId: ACCOUNT_HOME },
    ],
    watches: [],
    asks: seedAsks(),
    // Per-thread overrides of the work route's answer (tests: a story from the lighter model, a failed story).
    threadExtras: {},
    // "Regenerate summary" (POST …/story/regenerate, …/tldr/regenerate): how many so far, and
    // what the next ones do (tests: mockRegenerate({ fail, delayMs })).
    regen: { count: 0, fail: false, delayMs: 0 },
    admin: seedAdmin(),
    // GET /work/tldr: TL;DRs for rows that do not carry their own (Screener, Reading, Records).
    tldrs: {
      'm-nordlys': { text: 'Your Bergen booking is confirmed: 3 nights, reference NT-44821.', model: 'google/gemma-4-12B-it-qat-w4a16-ct', tier: 'reflex', lighter: false },
      'm-ben': { text: 'On-device models turn the browser into an inference runtime.', model: 'google/gemma-4-12B-it-qat-w4a16-ct', tier: 'reflex', lighter: false },
      'm-fjordkraft': { text: 'September electricity: NOK 1,240, due Friday.', model: 'google/gemma-4-12B-it-qat-w4a16-ct', tier: 'reflex', lighter: false },
    },
    // indexer/truth.js coverageShare: how much of the mail Ask, search and cards can see.
    coverage: { share: 0.62, indexed: 34620, total: 55762, complete: false },
  };
}

// The admin routes (backend/src/hedwig/core adminRoutes, onboarding/routing.js): config fields,
// the gateway catalog, the routing table, the models people may pick, and the health view.
function seedAdmin() {
  const field = (key, value, extra = {}) => ({ key, value, scope: 'system', ...extra });
  return {
    config: [
      field('llm.models.fast', 'google/gemma-4-12B-it-qat-w4a16-ct', { type: 'string', group: 'models' }),
      field('llm.models.long', 'Qwen/Qwen3.8-Flash-Next', { type: 'string', group: 'models' }),
      field('llm.models.agent', 'Qwen/Qwen3.8-Flash-Next', { type: 'string', group: 'models' }),
      field('llm.fallbackModel', 'google/gemma-4-12B-it-qat-w4a16-ct', { type: 'string', group: 'models' }),
      field('llm.reasoning.fast', 'off', { type: 'enum', options: ['off', 'low', 'medium', 'high', 'xhigh'] }),
      field('llm.reasoning.long', 'low', { type: 'enum', options: ['off', 'low', 'medium', 'high', 'xhigh'] }),
      field('llm.reasoning.agent', 'low', { type: 'enum', options: ['off', 'low', 'medium', 'high', 'xhigh'] }),
    ],
    catalog: { models: [
      { id: 'bge-m3', display_name: 'BGE M3', capabilities: ['embeddings'], reasoning_efforts: [], status: 'ready' },
      { id: 'google/gemma-4-12B-it-qat-w4a16-ct', display_name: 'Gemma 4 12B QAT', capabilities: ['chat', 'reasoning', 'streaming'], reasoning_efforts: ['none', 'high'], max_output_tokens: 32768, status: 'ready' },
      { id: 'Qwen/Qwen3.8-Flash-Next', display_name: 'Qwen 3.8 Flash Next', capabilities: ['chat', 'tools', 'reasoning', 'streaming'], reasoning_efforts: ['off', 'low', 'medium', 'xhigh'], max_output_tokens: 65536, status: 'ready' },
    ] },
    routing: {
      sort: { override: 'auto', defaultTier: 'reflex', escalateBelow: 0.6, budget: 2000000, cadence: 'Each new message; history 200 messages a minute' },
      work: { override: 'auto', defaultTier: 'reflex', escalateBelow: null, budget: 1000000, cadence: 'When you open a thread or ask for a draft' },
      ask: { override: 'auto', defaultTier: 'mixed', escalateBelow: null, budget: 1000000, cadence: 'When you ask' },
    },
    enabled: [],
    degraded: false,
  };
}

function routingTable(a) {
  const tierOf = (r) => (r.override === 'reflex' || r.override === 'reasoning' ? r.override : r.defaultTier);
  const features = Object.entries(a.routing).map(([feature, r]) => ({
    feature, tier: tierOf(r), override: r.override, defaultTier: r.defaultTier, tierKey: `routing.${feature}.tier`,
    escalateBelow: r.escalateBelow, escalateKey: feature === 'sort' ? 'sort.escalateBelow' : null, escalate: [],
    cadence: r.cadence, budget: r.budget, budgetKey: `llm.tokenBudget.${feature}`, prompts: [],
  }));
  const val = (k) => a.config.find((f) => f.key === k)?.value;
  return { models: { reflex: val('llm.models.fast'), reasoning: val('llm.models.long') }, features };
}

// llm.js tierStatus: what serves each tier, and the notice.
function tierStatusOf(a) {
  const val = (k) => a.config.find((f) => f.key === k)?.value;
  const fbAll = val('llm.fallbackModel') || null;
  const entry = (tier, role, label) => {
    const model = val(`llm.models.${role}`) || null;
    const fallback = fbAll && fbAll !== model ? fbAll : null;
    const degraded = Boolean(a.degraded && role !== 'fast');
    const active = degraded && fallback ? fallback : model;
    return { tier, label, role, model, fallback, active, degraded, lighterModel: tier === 'reasoning' && active !== model,
      reason: degraded ? 'no response within 45000 ms' : null, source: degraded ? 'probe' : null, since: null, checkedAt: at(60_000), latencyMs: degraded ? null : (role === 'fast' ? 1900 : 4200) };
  };
  const reflex = entry('reflex', 'fast', 'Tier 1 Reflex');
  const reasoning = entry('reasoning', 'long', 'Tier 2 Reasoning');
  const agent = entry('reasoning', 'agent', 'Agent (Tier 2, tool calling)');
  const notice = reasoning.degraded && reasoning.active !== reasoning.model
    ? { level: 'warning', tier: 'reasoning', text: 'Tier 2 is slow; using the lighter model', detail: `${reasoning.model}: ${reasoning.reason}. ${reasoning.active} answers Tier 2 work until it recovers.` }
    : null;
  return { reflex, reasoning, agent, notice, probe: { enabled: true, everySec: 60, timeoutMs: 10000, lastRunAt: at(60_000) } };
}

const RUNTIME_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
function runtimeOf(a) {
  const val = (k) => a.config.find((f) => f.key === k)?.value;
  const info = (id) => a.catalog.models.find((m) => m.id === id) || null;
  const tiers = {};
  for (const [tier, role, label] of [['reflex', 'fast', 'Tier 1 Reflex'], ['reasoning', 'long', 'Tier 2 Reasoning'], ['agent', 'agent', 'Agent (Tier 2, tool calling)']]) {
    const model = val(`llm.models.${role}`);
    const m = info(model);
    const efforts = m ? [...new Set(m.reasoning_efforts.map((e) => (e === 'none' ? 'off' : e)))].filter((e) => RUNTIME_EFFORTS.includes(e)) : RUNTIME_EFFORTS;
    const effort = val(`llm.reasoning.${role}`);
    tiers[tier] = { label, role, modelKey: `llm.models.${role}`, model, modelSource: 'default', effortKey: `llm.reasoning.${role}`, effort, effortSource: 'default',
      efforts, wireEffort: efforts.includes(effort) ? (effort === 'off' ? 'none' : effort) : (efforts.includes('off') ? 'none' : efforts[0]), inCatalog: Boolean(m) };
  }
  return { tiers, fallback: { model: val('llm.fallbackModel') || null, modelKey: 'llm.fallbackModel' }, enabledModels: clone(a.enabled), budgets: {}, status: tierStatusOf(a) };
}

function activeModelsOf(a) {
  const val = (k) => a.config.find((f) => f.key === k)?.value;
  const fb = val('llm.fallbackModel') || null;
  return Object.fromEntries(['fast', 'long', 'agent'].map((role) => {
    const primary = val(`llm.models.${role}`);
    const degraded = Boolean(a.degraded && role !== 'fast' && fb && fb !== primary);
    return [role, { primary, fallback: fb, active: degraded ? fb : primary, degraded }];
  }));
}

// ── G: cards ─────────────────────────────────────────────────────────────────
function card(id, kind, messageId, fields, sources = {}, extra = {}) {
  return {
    id, kind, fields, sources, confidence: 0.92, layer: 'pattern', messageId, messageIds: messageId ? [messageId] : [],
    eventAt: null, createdAt: at(DAY), updatedAt: at(HOUR), dismissedAt: null, userEdited: false,
    provenance: { promptId: null, promptVersion: null, model: null, aiCallId: null }, ...extra,
  };
}
const src = (messageId, quote, extra = {}) => ({ messageId, quote, via: 'pattern', ...extra });

function seedCards() {
  return [
    card('c-dhl', 'delivery', 'm-dhl',
      { carrier: 'DHL', trackingNumber: 'JD014600006251', trackingUrl: 'https://www.dhl.example/track?id=JD014600006251', status: 'out_for_delivery', expectedDate: dayOffset(0), expectedBy: '14:00', merchant: 'Fjellsport', item: 'Running shoes',
        history: [{ status: 'shipped', at: at(2 * DAY), messageId: 'm-dhl' }, { status: 'out_for_delivery', at: at(2 * HOUR), messageId: 'm-dhl' }] },
      { carrier: src('m-dhl', 'DHL Express: your parcel is on its way.'), status: src('m-dhl', 'Your parcel is out for delivery and arrives today between 10:00 and 14:00.'),
        expectedDate: src('m-dhl', 'arrives today between 10:00 and 14:00'), trackingNumber: src('m-dhl', 'Tracking number JD014600006251'), item: src('m-dhl', 'Running shoes, size 43, from Fjellsport'),
        trackingUrl: src('m-dhl', 'https://www.dhl.example/track?id=JD014600006251') }),
    card('c-posten', 'delivery', 'm-posten',
      { carrier: 'Posten', status: 'in_transit', expectedDate: dayOffset(0), expectedBy: '16:00', merchant: 'Adlibris', item: 'Two books' },
      { carrier: src('m-posten', 'Posten: your parcel from Adlibris is on its way.'), expectedDate: src('m-posten', 'It arrives today by 16:00.'), item: src('m-posten', 'Two books: Kristin Lavransdatter and Sult') }),
    card('c-fjordkraft', 'invoice', 'm-fjordkraft',
      { issuer: 'Fjordkraft', amount: 1240, currency: 'NOK', dueDate: localDay(nextWeekday(5)), invoiceNumber: '2026-0914', status: 'due' },
      { amount: src('m-fjordkraft', 'Amount due: NOK 1,240.00'), dueDate: src('m-fjordkraft', 'Please pay by Friday 26 September.'), invoiceNumber: src('m-fjordkraft', 'Invoice number 2026-0914'), issuer: src('m-fjordkraft', 'Fjordkraft AS, customer 88120') }),
    card('c-telia', 'invoice', 'm-telia',
      { issuer: 'Telia', amount: 349, currency: 'NOK', dueDate: dayOffset(8), status: 'due' },
      { amount: src('m-telia', 'NOK 349, due 1 October.'), dueDate: src('m-telia', 'NOK 349, due 1 October.') }),
    card('c-nordlys', 'travel', 'm-nordlys',
      { type: 'hotel', provider: 'Nordlys Travel', reference: 'NT-44821', checkIn: dayOffset(9), checkOut: dayOffset(12), location: 'Bergen' },
      { reference: src('m-nordlys', 'Reference NT-44821.'), checkIn: src('m-nordlys', 'Check-in Thursday, three nights.') }),
    card('c-sas', 'travel', 'm-sas',
      { type: 'flight', provider: 'SAS', flightNumber: 'SK 1302', from: 'Oslo', to: 'Bergen', departAt: daysAheadAt(2, 18, 5), reference: 'K7Q2LM' },
      { flightNumber: src('m-sas', 'Check-in opens for SK 1302'), departAt: src('m-sas', 'Oslo → Bergen, Thu 18:05.'), reference: src('m-sas', 'Booking reference K7Q2LM') }),
    card('c-kaur', 'event', 'm-kaur',
      { title: 'Appointment with Dr. Kaur', start: daysAheadAt(7, 10, 30), end: daysAheadAt(7, 11, 0), location: 'Bergen Clinic, Strandgaten 18' },
      { start: src('m-kaur', 'Your appointment is on 30 Sep at 10:30.', { via: 'ics', attachment: 'invite.ics' }), location: src('m-kaur', 'Bergen Clinic, Strandgaten 18') }, { layer: 'ics' }),
    card('c-vipps', 'code', 'm-vipps',
      { code: '482913', service: 'Vipps', purpose: 'confirm a payment', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      { code: src('m-vipps', 'Use 482913 to confirm. It expires in 10 minutes.'), service: src('m-vipps', 'From: Vipps <no-reply@vipps.example>', { via: 'header' }) }),
    card('c-spotify', 'subscription', 'm-spotify',
      { merchant: 'Spotify', amount: 129, currency: 'NOK', cadence: 'monthly', lastCharged: dayOffset(-6), nextRenewal: dayOffset(24), charges: 14 },
      { amount: src('m-spotify', 'NOK 129 charged for Premium Individual.'), cadence: src('m-spotify', '14 charges from Spotify, the last one this month', { via: 'derived' }) }, { layer: 'derived' }),
    card('c-netflix', 'subscription', 'm-netflix',
      { merchant: 'Netflix', amount: 179, currency: 'NOK', cadence: 'monthly', lastCharged: dayOffset(-12), nextRenewal: dayOffset(18), charges: 30 }, {}, { layer: 'derived' }),
    card('c-fastmail', 'subscription', 'm-fastmail',
      { merchant: 'Fastmail', amount: 60, currency: 'USD', cadence: 'yearly', lastCharged: dayOffset(-200), nextRenewal: dayOffset(165), charges: 3 }, {}, { layer: 'derived' }),
    card('c-fjell', 'receipt', 'm-fjell',
      { merchant: 'Fjellsport', orderNumber: 'FS-20931', total: 1299, currency: 'NOK', date: dayOffset(-4) },
      { total: src('m-fjell', 'Total NOK 1,299.00'), orderNumber: src('m-fjell', 'Order FS-20931 confirmed') }),
    card('c-adlibris', 'receipt', 'm-adlibris',
      { merchant: 'Adlibris', orderNumber: 'AB-99812', total: 398, currency: 'NOK', date: dayOffset(-3) }, { total: src('m-adlibris', 'Totalt: 398,00 kr') }),
    card('c-amazon', 'receipt', 'm-amazon',
      { merchant: 'Amazon', orderNumber: '026-5512209', total: 34.99, currency: 'GBP', date: dayOffset(-21) }, { total: src('m-amazon', 'Order Total: £34.99') }),
  ];
}

const CARD_KEYS = {
  receipt: ['merchant', 'orderNumber', 'total', 'currency', 'date', 'items', 'paymentMethod'],
  invoice: ['issuer', 'invoiceNumber', 'amount', 'currency', 'issuedDate', 'dueDate', 'status'],
  subscription: ['merchant', 'amount', 'currency', 'cadence', 'lastCharged', 'nextRenewal', 'charges'],
  delivery: ['carrier', 'trackingNumber', 'trackingUrl', 'status', 'expectedDate', 'expectedBy', 'merchant', 'item'],
  travel: ['type', 'provider', 'reference', 'from', 'to', 'departAt', 'arriveAt', 'flightNumber', 'checkIn', 'checkOut', 'location', 'passenger'],
  event: ['title', 'start', 'end', 'allDay', 'location', 'organizer', 'uid', 'method', 'status'],
  code: ['code', 'service', 'purpose', 'expiresAt'],
  deadline: ['what', 'dueAt', 'direction', 'counterparty'],
};

function withMessage(c) {
  const it = c.messageId ? findItem(c.messageId) : null;
  return { ...clone(c), message: it ? { id: it.messageId, subject: it.subject, from_name: it.from?.name, from_email: it.from?.email, date: it.date, thread_key: it.threadId } : null };
}

// G's cardActions, in short: an .ics for dated cards, a reminder, tracking, copy.
function mockActions(c) {
  const f = c.fields;
  const out = [];
  const start = { event: f.start, travel: f.departAt || f.checkIn, delivery: f.expectedDate, invoice: f.dueDate, subscription: f.nextRenewal }[c.kind];
  const summary = {
    event: f.title, travel: [f.flightNumber || f.provider, f.from && f.to ? `${f.from} → ${f.to}` : null].filter(Boolean).join(' '),
    delivery: `Delivery: ${f.item || 'parcel'}`, invoice: `Pay ${f.issuer || 'bill'}`, subscription: `${f.merchant} renews`,
  }[c.kind];
  if (start) {
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    out.push({
      id: 'calendar', label: 'Add to calendar', filename: `${String(summary).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}.ics`, mime: 'text/calendar',
      ics: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Team-AER//Hedwig cards//EN', 'BEGIN:VEVENT', `UID:${c.id}@hedwig`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
    });
    const it = findItem(c.messageId);
    out.push({
      id: 'reminder', label: 'Set a reminder', reminder: {
        title: c.kind === 'invoice' ? `Pay ${f.issuer || 'bill'}` : c.kind === 'delivery' ? `Parcel: ${f.item || 'parcel'} arrives today` : summary,
        remindAt: new Date(Math.max(Date.now() + HOUR, new Date(start).getTime() - DAY)).toISOString(),
        note: it ? `From "${it.subject}"` : null, messageId: c.messageId || null, threadId: it?.threadId || null, source: { kind: 'card', cardId: c.id, cardKind: c.kind },
      },
    });
  }
  if (c.kind === 'delivery' && f.trackingUrl) out.push({ id: 'track', label: 'Track parcel', url: f.trackingUrl });
  if (c.kind === 'code' && f.code) out.push({ id: 'copy', label: 'Copy code', text: f.code });
  return out;
}

const LEDGER_ROWS = {
  purchases: {
    kinds: ['receipt', 'invoice'], sorts: ['date', 'merchant', 'amount', 'dueDate', 'status'], def: ['date', 'desc'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, date: c.fields.date || c.fields.issuedDate || (findItem(c.messageId) ? localDay(findItem(c.messageId).date) : null), merchant: c.fields.merchant || c.fields.issuer || null,
      reference: c.fields.orderNumber || c.fields.invoiceNumber || null, amount: c.fields.total ?? c.fields.amount ?? null, currency: c.fields.currency || null,
      status: c.kind === 'invoice' ? (c.fields.status || 'due') : 'paid', dueDate: c.fields.dueDate || null, items: [],
    }),
  },
  subscriptions: {
    kinds: ['subscription'], sorts: ['nextRenewal', 'merchant', 'amount', 'lastCharged', 'cadence'], def: ['nextRenewal', 'asc'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, merchant: c.fields.merchant, amount: c.fields.amount ?? null, currency: c.fields.currency || null,
      cadence: c.fields.cadence || null, lastCharged: c.fields.lastCharged || null, nextRenewal: c.fields.nextRenewal || null, charges: c.fields.charges ?? null, messageIds: c.messageIds,
    }),
  },
  travel: {
    kinds: ['travel'], sorts: ['date', 'provider', 'type', 'reference'], def: ['date', 'desc'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, type: c.fields.type || null, provider: c.fields.provider || null, reference: c.fields.reference || null,
      flightNumber: c.fields.flightNumber || null, from: c.fields.from || null, to: c.fields.to || null, departAt: c.fields.departAt || null, arriveAt: c.fields.arriveAt || null,
      checkIn: c.fields.checkIn || null, checkOut: c.fields.checkOut || null, location: c.fields.location || null, date: c.fields.departAt || c.fields.checkIn || null,
    }),
  },
  deliveries: {
    kinds: ['delivery'], sorts: ['updatedAt', 'expectedDate', 'status', 'carrier'], def: ['updatedAt', 'desc'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, carrier: c.fields.carrier || null, trackingNumber: c.fields.trackingNumber || null, trackingUrl: c.fields.trackingUrl || null,
      status: c.fields.status || null, expectedDate: c.fields.expectedDate || null, expectedBy: c.fields.expectedBy || null, merchant: c.fields.merchant || null, item: c.fields.item || null,
      updatedAt: c.updatedAt, history: c.fields.history || [],
    }),
  },
};
const MONTHLY = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const round2 = (n) => Math.round(n * 100) / 100;
function sortLedger(rows, field, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[field];
    const y = b[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}
function mockLedger(kind, params) {
  const def = LEDGER_ROWS[kind];
  const all = db.cards.filter((c) => !c.dismissedAt && def.kinds.includes(c.kind)).map(def.row);
  const field = def.sorts.includes(params.get('sort')) ? params.get('sort') : def.def[0];
  const dir = ['asc', 'desc'].includes(params.get('dir')) ? params.get('dir') : (field === def.def[0] ? def.def[1] : 'desc');
  const rows = sortLedger(all, field, dir);
  const by = new Map();
  if (kind === 'purchases' || kind === 'subscriptions') {
    for (const r of rows) {
      if (r.amount == null) continue;
      const t = by.get(r.currency || '?') || { currency: r.currency || null, total: 0, count: 0, ...(kind === 'subscriptions' ? { monthly: 0, unknownCadence: 0 } : {}) };
      t.total += Number(r.amount);
      t.count++;
      if (kind === 'subscriptions' && MONTHLY[r.cadence]) t.monthly += Number(r.amount) * MONTHLY[r.cadence];
      else if (kind === 'subscriptions') t.unknownCadence++;
      by.set(r.currency || '?', t);
    }
  }
  const totals = [...by.values()].map((t) => ({ ...t, total: round2(t.total), ...(t.monthly != null ? { monthly: round2(t.monthly) } : {}) })).sort((a, b) => b.count - a.count);
  return { kind, sort: { field, dir, options: def.sorts }, count: rows.length, totals, rows };
}

// ── G: Ask ───────────────────────────────────────────────────────────────────
function lite(id, fromName, fromEmail, subject, date, threadKey, accountId = ACCOUNT_HOME) {
  return {
    id, account_id: accountId, account: { id: accountId, name: accountId === ACCOUNT_HOME ? 'Home' : 'Work', color: null }, folder: 'INBOX', subject, from_name: fromName, from_email: fromEmail,
    date, snippet: '', is_read: true, is_starred: false, has_attachments: false, thread_key: threadKey,
  };
}
const DEPOSIT_SOURCES = () => [
  { n: 1, message: lite('m-marcus', 'Marcus Oduya', 'marcus@oduya-lettings.example', 'Lease renewal, two options', daysAgoAt(1, 16, 5), 't-marcus') },
  { n: 2, message: lite('m-marcus-0', 'Marcus Oduya', 'marcus@oduya-lettings.example', 'Move-in checklist and deposit', daysAgoAt(340, 9, 0), 't-marcus-0') },
];
const DEPOSIT_ANSWER = 'Marcus said the deposit stays with the deposit scheme and carries over if you renew [1]. When you moved in he confirmed it was NOK 24,000, three months of rent [2].';
const NOTHING = "I couldn't find anything relevant in your mail about that.";
function seedAsks() {
  return [
    { id: 'a-deposit', question: 'What did the landlord say about the deposit?', created_at: daysAgoAt(2, 20, 14), completed_at: daysAgoAt(2, 20, 14), status: 'done',
      answer: DEPOSIT_ANSWER, citations: [1, 2], sources: DEPOSIT_SOURCES(), unsupported: false, notFound: false, followUpOf: null, entityId: null, topicId: null, feedback: null, plan: null },
    { id: 'a-passport', question: 'When does my passport expire?', created_at: daysAgoAt(5, 8, 2), completed_at: daysAgoAt(5, 8, 2), status: 'done',
      answer: NOTHING, citations: [], sources: [], unsupported: false, notFound: true, followUpOf: null, entityId: null, topicId: null, feedback: null, plan: null },
    { id: 'a-power', question: 'How much was the electricity bill in August?', created_at: daysAgoAt(8, 19, 40), completed_at: daysAgoAt(8, 19, 40), status: 'done',
      answer: 'Probably around NOK 1,100, like most summer months.', citations: [],
      sources: [{ n: 1, message: lite('m-fjordkraft', 'Fjordkraft', 'faktura@fjordkraft.example', 'Invoice for September: NOK 1,240', daysAgoAt(1, 9, 0), 't-fjordkraft') }],
      unsupported: true, notFound: false, followUpOf: null, entityId: null, topicId: null, feedback: { wrong: true, note: 'August was NOK 980', at: daysAgoAt(8, 19, 45) }, plan: null },
  ];
}
let askSeq = 0;

/**
 * Answer a streaming POST like hedwigStream would: the events through onEvent, then resolve.
 * /context/ask: "passport", "lottery" or "nothing" finds nothing (no sources, no model call);
 * "guess" gives an answer that cites nothing (unsupported); "cite" adds a citation to a source
 * that is not there, which the check removes; anything else answers about the deposit.
 */
export async function mockStream(path, body, { onEvent, signal } = {}) {
  requestLog.push(`STREAM ${path}`);
  if (path !== '/context/ask') throw notFound();
  const q = String(body?.question || '').trim();
  if (!q) throw bad('question is required');
  const tick = async () => {
    await new Promise((r) => setTimeout(r, 0));
    if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  };
  const id = `a-new-${++askSeq}`;
  const entry = {
    id, question: q, created_at: new Date().toISOString(), completed_at: null, status: 'running', answer: null, citations: [], sources: [], unsupported: null, notFound: null,
    followUpOf: body.followUpOf || null, entityId: body.entityId || null, topicId: body.topicId || null, feedback: null, plan: null,
  };
  db.asks.unshift(entry);
  const emit = (ev) => onEvent?.(clone(ev));
  let answer;
  let sources = [];
  const flags = { unsupported: false, notFound: false, invalidCitations: [] };
  if (/passport|lottery|nothing/i.test(q)) {
    answer = NOTHING;
    flags.notFound = true;
  } else if (/guess/i.test(q)) {
    sources = DEPOSIT_SOURCES();
    answer = 'It is probably about three months of rent.';
    flags.unsupported = true;
  } else {
    sources = DEPOSIT_SOURCES();
    answer = body.followUpOf ? 'Yes. Renewing keeps the same deposit, so there is nothing to pay again [1].' : DEPOSIT_ANSWER;
    if (/cite/i.test(q)) { answer += ' The scheme also sent a certificate [4].'; flags.invalidCitations = [4]; }
  }
  emit({ type: 'sources', sources, askLogId: id, plan: { text: q }, coverage: clone(db.coverage) });
  await tick();
  for (const word of answer.split(/(?<= )/)) { emit({ type: 'delta', text: word }); await tick(); }
  const checked = flags.invalidCitations.length ? answer.replace(/\s?\[4\]/, '') : answer;
  const citations = [...new Set([...checked.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  // While Tier 2 is degraded (mockSetDegraded) the answer comes from the lighter model, as llm.js reports it.
  const who = db.admin.degraded ? { model: 'google/gemma-4-12B-it-qat-w4a16-ct', lighterModel: true } : { model: 'Qwen/Qwen3.8-Flash-Next', lighterModel: false };
  emit({ type: 'done', answer: checked, citations, ...flags, askLogId: id, coverage: clone(db.coverage), ...who });
  Object.assign(entry, { status: 'done', completed_at: new Date().toISOString(), answer: checked, citations, sources, unsupported: flags.unsupported, notFound: flags.notFound, ...who });
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
    tldr: 'Anna needs your final Q3 numbers by Thursday evening.',
    messageTldrs: { 'm-anna': 'Wants the final Q3 numbers by Thursday evening; the revenue lines are fixed.' },
  },
};

// A thread whose newest message is a saved draft (in acc-work's Drafts folder): the reader shows
// it as a draft block with Edit draft, and the reply bar as Continue draft.
THREADS['t-lease'] = {
  subject: 'Lease renewal: two options',
  label: 'Home',
  participants: 'Marcus Oduya and you',
  messages: [
    { id: 'm-lease-1', from: { name: 'Marcus Oduya', email: 'marcus@oduya-lettings.example' }, to: 'you', date: daysAgoAt(3, 14, 5), folder: 'INBOX', accountId: ACCOUNT_WORK,
      text: 'Hi, your lease ends in November. Would you like a 12-month renewal at the same rent, or 24 months with a 2% increase?' },
    { id: 'm-lease-draft', uid: 41, folder: 'Drafts', accountId: ACCOUNT_WORK, from: { name: 'You', email: 'me@example.org' }, to: 'Marcus Oduya', date: todayAt(8, 15),
      subject: 'Re: Lease renewal: two options', to_addresses: [{ name: 'Marcus Oduya', address: 'marcus@oduya-lettings.example' }],
      text: 'Hi Marcus, the 12-month renewal works for me. Could we' },
  ],
  story: null,
  deadline: null,
  quickReplies: [],
};

// Upstream rows in acc-work's Drafts folder (GET /mail/messages?folder=Drafts), newest first.
function mockDrafts() {
  return [
    { id: 'd-1', uid: 41, folder: 'Drafts', account_id: ACCOUNT_WORK, subject: 'Re: Lease renewal: two options', date: todayAt(8, 15),
      from_name: 'You', from_email: 'me@example.org', to_addresses: [{ name: 'Marcus Oduya', address: 'marcus@oduya-lettings.example' }], cc_addresses: [],
      snippet: 'Hi Marcus, the 12-month renewal works for me. Could we', is_read: true },
    { id: 'd-2', uid: 40, folder: 'Drafts', account_id: ACCOUNT_WORK, subject: '', date: daysAgoAt(2, 18, 30),
      from_name: 'You', from_email: 'me@example.org', to_addresses: [], cc_addresses: [], snippet: 'Ideas for the offsite: a morning walk, then', is_read: true },
  ];
}
const MOCK_BODIES = {
  'd-1': { html: '<p>Hi Marcus, the 12-month renewal works for me. Could we</p>', text: 'Hi Marcus, the 12-month renewal works for me. Could we' },
  'd-2': { html: null, text: 'Ideas for the offsite: a morning walk, then' },
  'm-lease-draft': { html: '<p>Hi Marcus, the 12-month renewal works for me. Could we</p>', text: 'Hi Marcus, the 12-month renewal works for me. Could we' },
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
    rule: null, promptId: null, promptVersion: null, model: null, senderKey: 'anna.berg@northwind.example', senderScope: 'address' },
  'm-marcus': { layer: 'reflex', reason: 'He asked you to choose between two options four days ago.', confidence: 0.81,
    signals: ['Question addressed to you', 'No reply from you yet', 'Sender is in your contacts'],
    rule: null, promptId: 'sort.reflex', promptVersion: '2026-09-23.1', model: 'google/gemma-4-12B-it-qat-w4a16-ct', senderKey: 'marcus@oduya-lettings.example', senderScope: 'address' },
  'm-ben': { layer: 'rule', reason: 'A newsletter, so it waits in Reading.', confidence: 1,
    signals: [{ name: 'listRule', label: 'A mailing list: Reading', weight: 0.9 }, { name: 'list', label: 'Mailing list weekly.benedict.example', weight: 0.6 }, { name: 'unsubscribe', label: 'Has an unsubscribe link', weight: 0.3 }],
    engineVersion: '2026-09-24.2',
    senderDecision: { key: 'weekly.benedict.example', scope: 'list', decision: 'reading', source: 'user' },
    senderKey: 'weekly.benedict.example', senderScope: 'list',
    rule: null, promptId: null, promptVersion: null, model: null },
  'm-kaur': { layer: 'classifier', reason: 'The clinic asks you to confirm or rebook.', confidence: 0.64, pending: 'reflex', engineVersion: '2026-09-24.2',
    signals: [{ name: 'alwaysIn', label: 'You have written to them', weight: 0.5 }, { name: 'question', label: 'Asks you to confirm', weight: 0.4 }],
    rule: null, promptId: null, promptVersion: null, model: null, senderKey: 'reception@bergen-clinic.example', senderScope: 'address' },
  'm-dhl': { layer: 'rule', reason: 'A delivery notice, bundled with Deliveries.', confidence: 1,
    signals: ['From a carrier domain', 'Tracking number in the subject'], rule: { id: 'r-1', name: 'Deliveries' },
    promptId: null, promptVersion: null, model: null, senderKey: 'dhl.example', senderScope: 'domain' },
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
    // The key the message is grouped under: its list when it has a List-Id, else the address.
    senderKey: it?.list || it?.from?.email || null, senderScope: it?.list ? 'list' : (it?.from?.email ? 'address' : null),
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
    // Where today's prose came from: the template stood in because Tier 2 was not answering.
    prose: { insightId: 'i-brief', source: 'template', fallback: true, reason: 'tier2_degraded', model: null, at: todayAt(7, 0) },
    coverage: clone(db.coverage),
    today: { ...db.counts, ...todayUndo() },
  };
}

// insights/briefing.js briefToday: the newest undoable "Hedwig today" entries (POST /sort/undo { logId }).
function todayUndo() {
  const entries = db.log.filter((e) => e.undoable && !e.undone);
  return { undoable: entries.length, entries: entries.slice(0, 5).map((e) => ({ id: e.id, action: e.action, text: e.text || null, messageId: e.messageId || null, subject: e.subject || null, createdAt: e.createdAt || null })) };
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
    if (method === 'GET' && seg[2] === 'for' && seg[3]) {
      const q = db.questions.find((x) => x.messageId === decodeURIComponent(seg[3]));
      return { question: q ? clone(q) : null };
    }
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
  if (method === 'GET' && seg[0] === 'index' && seg[1] === 'coverage') return clone(db.coverage);
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
    if (method === 'GET' && seg[1] === 'tldr') {
      const ids = String(params.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
      return { tldr: Object.fromEntries(ids.filter((id) => db.tldrs[id]).map((id) => [id, clone(db.tldrs[id])])) };
    }
    if (method === 'GET' && seg[1] === 'message' && seg[3] === 'tldr') {
      const id = decodeURIComponent(seg[2]);
      return { messageId: id, tldr: db.tldrs[id] ? clone(db.tldrs[id]) : null, computed: false };
    }
    if (seg[1] === 'lists') {
      if (method === 'GET' && !seg[2]) return listCounts();
      const kind = listKind(seg[2]);
      if (kind === 'reminder' && method === 'GET') return { kind, items: db.reminders.map(reminderRow), next: null };
      if (method === 'POST' && kind === 'reminder' && !body?.threadId) {
        const note = body?.note ?? body?.text;
        if (!note || !String(note).trim()) throw bad('A reminder needs text');
        const until = body?.until ?? body?.at;
        if (!until || Number.isNaN(new Date(until).getTime())) throw bad('A reminder needs a time (at)');
        const r = { id: 100 + db.reminders.length, note: String(note).trim().slice(0, 500), until: new Date(until).toISOString() };
        db.reminders.push(r);
        return { item: reminderRow(r) };
      }
      if (method === 'POST' && kind === 'reminder') {
        if (!findThread(body.threadId)) throw notFound();
        if (!body?.until) throw bad('A reminder needs a time (until)');
        const r = { id: 100 + db.reminders.length, note: body.note || null, until: new Date(body.until).toISOString(), threadId: body.threadId };
        db.reminders.push(r);
        return { item: { ...clone(findThread(body.threadId)), note: r.note, until: r.until }, counts: listCounts() };
      }
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
        storyMeta: t.story ? { source: 'eager', tier: 'reflex', model: 'google/gemma-4-12B-it-qat-w4a16-ct', lighter: false } : null,
        tldr: t.tldr || null,
        messageTldrs: clone(t.messageTldrs || {}),
        provenance: {}, cached: true,
        ...clone(db.threadExtras[decodeURIComponent(seg[2])] || {}),
      };
    }
    if (method === 'POST' && seg[1] === 'thread' && seg[2] && seg[3] === 'story' && seg[4] === 'regenerate') {
      const id = decodeURIComponent(seg[2]);
      const t = threadFor(id);
      if (!t) throw notFound();
      return regenAnswer(() => {
        const n = db.regen.count;
        const last = t.messages[t.messages.length - 1];
        const story = { text: `Rewrite ${n}: ${t.subject} is waiting on your reply [1].`, citations: [{ n: 1, messageId: last?.id }] };
        const storyMeta = { source: 'regenerate', tier: 'reasoning', model: 'Qwen/Qwen3.8-Flash-Next', lighter: Boolean(db.admin.degraded) };
        db.threadExtras[id] = { ...(db.threadExtras[id] || {}), story, storyMeta, storyError: undefined };
        return { threadId: id, upToMessageId: last?.id, story: clone(story), storyMeta: clone(storyMeta), tldr: t.tldr || null, timeline: [], regenerated: true };
      });
    }
    if (method === 'POST' && seg[1] === 'message' && seg[2] && seg[3] === 'tldr' && seg[4] === 'regenerate') {
      const id = decodeURIComponent(seg[2]);
      if (!Object.values(THREADS).some((t) => t.messages.some((m) => m.id === id)) && !findItem(id)) throw notFound();
      return regenAnswer(() => {
        const tldr = { text: `Rewrite ${db.regen.count}: one line about ${id}.`, model: 'google/gemma-4-12B-it-qat-w4a16-ct', tier: 'reflex', lighter: Boolean(db.admin.degraded), promptId: 'work.summarise' };
        db.tldrs[id] = tldr;
        return { messageId: id, tldr: clone(tldr), computed: true, regenerated: true };
      });
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
    if (method === 'GET' && seg[1] === 'waiting' && !seg[2]) return clone(db.waiting).sort((x, y) => y.days - x.days);
    if (method === 'POST' && seg[1] === 'waiting' && seg[3] === 'nudge') {
      const w = db.waiting.find((x) => x.threadId === decodeURIComponent(seg[2]));
      if (!w) throw notFound();
      const first = String(w.who).split(' ')[0];
      return {
        draft: `Hi ${first}, just checking in on ${w.subject}. Could you let me know where it stands?`,
        provenance: { promptId: 'work.nudge' },
        reply: { inReplyToMessageId: w.messageId, to: [{ name: w.who, email: w.whoEmail }], subject: `Re: ${w.subject}` },
      };
    }
    if (method === 'POST' && seg[1] === 'waiting' && seg[3] === 'resolve') {
      const id = decodeURIComponent(seg[2]);
      const n = db.waiting.length;
      db.waiting = db.waiting.filter((x) => x.threadId !== id);
      if (db.waiting.length === n) throw notFound();
      return { ok: true, resolved: n - db.waiting.length };
    }
    if (method === 'POST' && seg[1] === 'waiting' && !seg[2]) {
      if (!body?.threadId) throw bad('threadId is required');
      const days = Math.max(1, Math.min(60, Math.round(Number(body.days) || 3)));
      const watch = { id: db.watches.length + 1, threadId: body.threadId, messageId: null, anchorAt: new Date().toISOString(), days, dueAt: new Date(Date.now() + days * DAY).toISOString() };
      db.watches = [...db.watches.filter((x) => x.threadId !== body.threadId), watch];
      return { watch: clone(watch) };
    }
    if (method === 'POST' && seg[1] === 'sweep') return { marked: 0, before: body?.before || body?.day || null, after: null };
    if (method === 'POST' && seg[1] === 'sendguard') {
      const warnings = [];
      const m = /\b(attached|attachment|enclosed)\b/i.exec(String(body?.body || ''));
      if (m && !(body?.attachments || []).length) warnings.push({ kind: 'missing_attachment', text: `You mention “${m[1].toLowerCase()}” but nothing is attached.` });
      return { warnings };
    }
  }

  // ── G: cards ────────────────────────────────────────────────────────────
  if (seg[0] === 'cards') {
    if (method === 'GET' && !seg[1]) {
      const kinds = params.get('kinds') ? params.get('kinds').split(',') : null;
      const limit = Math.max(1, Math.min(500, Number(params.get('limit')) || 100));
      return { cards: db.cards.filter((c) => !c.dismissedAt && (!kinds || kinds.includes(c.kind))).slice(0, limit).map(withMessage) };
    }
    if (method === 'GET' && seg[1] === 'ledger') {
      if (!LEDGER_ROWS[seg[2]]) throw bad(`ledger must be one of ${Object.keys(LEDGER_ROWS).join(', ')}`);
      return mockLedger(seg[2], params);
    }
    if (method === 'GET' && seg[1] === 'messages') {
      const ids = String(params.get('ids') || '').split(',').filter(Boolean);
      const out = {};
      for (const id of ids) {
        const list = db.cards.filter((c) => !c.dismissedAt && (c.messageId === id || c.messageIds.includes(id))).map(withMessage);
        if (list.length) out[id] = list;
      }
      return { cards: out };
    }
    // cards/feedback.js: the owner's verdicts, newest first.
    if (method === 'GET' && seg[1] === 'feedback') {
      const limit = Math.max(1, Math.min(200, Number(params.get('limit')) || 50));
      return { count: db.cardFeedback.length, recent: db.cardFeedback.length, feedback: clone(db.cardFeedback.slice(0, limit)) };
    }
    if (method === 'GET' && seg[1] === 'message' && seg[2]) {
      const id = decodeURIComponent(seg[2]);
      return { cards: db.cards.filter((c) => c.messageId === id || c.messageIds.includes(id)).map(withMessage) };
    }
    const c = db.cards.find((x) => x.id === decodeURIComponent(seg[1] || ''));
    if (!c) throw notFound();
    if (method === 'GET' && !seg[2]) return withMessage(c);
    if (method === 'GET' && seg[2] === 'actions') return { cardId: c.id, actions: mockActions(withMessage(c)) };
    const feedback = (verdict, extra = {}) => {
      const f = { id: `fb-${db.cardFeedback.length + 1}`, cardId: c.id, kind: c.kind, merchantKey: String(c.fields.merchant || c.fields.issuer || '').toLowerCase() || null, verdict, createdAt: new Date().toISOString(), ...extra };
      db.cardFeedback.unshift(f);
      return f;
    };
    if (method === 'POST' && seg[2] === 'dismiss') { c.dismissedAt = new Date().toISOString(); feedback('dismissed'); return { ok: true, id: c.id }; }
    if (method === 'POST' && (seg[2] === 'not-recurring' || seg[2] === 'not-kind')) {
      if (seg[2] === 'not-recurring' && c.kind !== 'subscription') throw bad('only a subscription card can be marked as not recurring');
      c.dismissedAt = new Date().toISOString();
      const f = feedback(seg[2] === 'not-recurring' ? 'not_recurring' : 'not_this_kind');
      return { ok: true, id: c.id, verdict: f.verdict, feedbackId: f.id };
    }
    if (method === 'POST' && seg[2] === 'restore') {
      c.dismissedAt = null;
      db.cardFeedback = db.cardFeedback.filter((f) => f.cardId !== c.id || !['not_recurring', 'not_this_kind', 'dismissed'].includes(f.verdict));
      if (c.kind === 'subscription' && c.layer === 'derived') feedback('confirmed');
      return withMessage(c);
    }
    if (method === 'PATCH' && !seg[2]) {
      const fields = body?.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw bad('fields must be an object');
      const now = new Date().toISOString();
      for (const [k, v] of Object.entries(fields)) {
        if (!CARD_KEYS[c.kind].includes(k)) throw bad(`${k} is not a field of a ${c.kind} card`);
        const before = c.fields[k] ?? null;
        if (v === null || v === '') { delete c.fields[k]; c.sources[k] = { via: 'user', at: now, before, cleared: true }; continue; }
        c.fields[k] = typeof before === 'number' && typeof v === 'string' ? Number(v) : v;
        c.sources[k] = { via: 'user', at: now, before };
      }
      for (const [k, v] of Object.entries(fields)) feedback('wrong_field', { field: k, after: { [k]: v === '' ? null : v } });
      c.userEdited = true;
      c.updatedAt = now;
      return withMessage(c);
    }
  }

  // ── G: Ask (the stream itself is mockStream) ────────────────────────────
  if (seg[0] === 'context' && seg[1] === 'ask') {
    if (method === 'GET' && seg[2] === 'history') return clone(db.asks.slice(0, Number(params.get('limit')) || 50));
    const a = db.asks.find((x) => x.id === decodeURIComponent(seg[2] || ''));
    if (!a) throw notFound();
    if (method === 'GET' && !seg[3]) return clone(a);
    if (method === 'POST' && seg[3] === 'feedback') {
      if (body?.note != null && typeof body.note !== 'string') throw bad('note must be text');
      a.feedback = { wrong: body?.wrong !== false, note: body?.note || null, at: new Date().toISOString() };
      return { ok: true, feedback: clone(a.feedback) };
    }
  }

  // Stands in for upstream's GET /mail/thread/:threadKey (the messages), under the mock only.
  if (method === 'GET' && seg[0] === 'mock' && seg[1] === 'thread' && seg[2]) {
    const t = threadFor(decodeURIComponent(seg[2]));
    if (!t) throw notFound();
    return { subject: t.subject, label: t.label || null, participants: t.participants || null, messages: clone(t.messages) };
  }

  // Stand-ins for upstream's folder list, folder messages and message body (the Drafts view).
  if (method === 'GET' && seg[0] === 'mock' && seg[1] === 'folders' && seg[2]) {
    const id = decodeURIComponent(seg[2]);
    return id === ACCOUNT_WORK
      ? [{ path: 'INBOX', name: 'INBOX', special_use: null }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }, { path: 'Sent', name: 'Sent', special_use: '\\Sent' }]
      : [{ path: 'INBOX', name: 'INBOX', special_use: null }];
  }
  if (method === 'GET' && seg[0] === 'mock' && seg[1] === 'messages') {
    const rows = mockDrafts().filter((m) => m.account_id === params.get('accountId') && m.folder === params.get('folder'));
    return { messages: rows, total: rows.length };
  }
  if (method === 'GET' && seg[0] === 'mock' && seg[1] === 'body' && seg[2]) {
    const b = MOCK_BODIES[decodeURIComponent(seg[2])];
    if (!b) throw notFound();
    return { ...clone(b), attachments: [] };
  }

  // onboarding/routing.js GET /routing: the table for everyone, read-only, with this person's tokens today.
  if (method === 'GET' && pathname === '/routing') {
    const t = routingTable(db.admin);
    return { ...t, readOnly: true, myModels: {}, modelChoices: clone(db.admin.enabled), features: t.features.map((f) => ({ ...f, usedToday: f.feature === 'sort' ? 48210 : 0 })) };
  }
  if (seg[0] === 'admin') {
    const a = db.admin;
    if (method === 'GET' && pathname === '/admin/config') return clone(a.config);
    if (method === 'PATCH' && pathname === '/admin/config') {
      for (const [k, v] of Object.entries(body || {})) {
        const f = a.config.find((x) => x.key === k);
        if (f) f.value = v; else a.config.push({ key: k, value: v, scope: 'system' });
      }
      return clone(a.config);
    }
    if (method === 'GET' && pathname === '/admin/catalog') return clone(a.catalog);
    if (method === 'GET' && pathname === '/admin/routing') return routingTable(a);
    if (method === 'PUT' && pathname === '/admin/routing') {
      for (const [feature, change] of Object.entries(body || {})) {
        const r = a.routing[feature];
        if (!r) throw bad(`unknown feature ${feature}`);
        if (change.tier !== undefined) r.override = change.tier || 'auto';
        if (change.escalateBelow !== undefined) r.escalateBelow = change.escalateBelow;
        if (change.budget !== undefined) r.budget = change.budget;
      }
      return { ...routingTable(a), changed: Object.keys(body || {}) };
    }
    if (pathname === '/admin/models/enabled') {
      if (method === 'PUT') a.enabled = [...new Set(body?.models || [])];
      const val = (k) => a.config.find((f) => f.key === k)?.value;
      return {
        models: clone(a.enabled),
        defaults: { fast: val('llm.models.fast'), long: val('llm.models.long'), agent: val('llm.models.agent') },
        catalog: a.catalog.models.filter((m) => m.capabilities.includes('chat')).map((m) => ({ id: m.id, displayName: m.display_name, status: m.status, maxOutputTokens: m.max_output_tokens ?? null })),
      };
    }
    if (method === 'GET' && pathname === '/admin/runtime') return runtimeOf(a);
    if (method === 'PUT' && pathname === '/admin/runtime') {
      const notes = [];
      const setKey = (k, v) => { const f = a.config.find((x) => x.key === k); if (f) f.value = v; else a.config.push({ key: k, value: v, scope: 'system' }); };
      const alias = { reflex: 'fast', reasoning: 'long' };
      for (const [raw, id] of Object.entries(body?.models || {})) {
        const role = alias[raw] || raw;
        const m = a.catalog.models.find((x) => x.id === id);
        if (id && !m) throw bad(`models.${raw}: ${id} is not in the gateway catalog`);
        if (role === 'agent' && m && !m.capabilities.includes('tools')) throw bad(`models.agent: ${id} does not support tool calling`);
        setKey(role === 'fallback' ? 'llm.fallbackModel' : `llm.models.${role}`, id || '');
      }
      for (const [raw, e] of Object.entries(body?.effort || {})) {
        const role = alias[raw] || raw;
        setKey(`llm.reasoning.${role}`, e);
        const m = a.catalog.models.find((x) => x.id === a.config.find((f) => f.key === `llm.models.${role}`)?.value);
        const allowed = m ? m.reasoning_efforts.map((x) => (x === 'none' ? 'off' : x)) : [];
        if (m && !allowed.includes(e)) notes.push(`${m.id} accepts ${m.reasoning_efforts.join('/')}; ${e} is sent as ${m.reasoning_efforts[0]}`);
      }
      if (Array.isArray(body?.enabledModels)) a.enabled = [...new Set(body.enabledModels)];
      return { ...runtimeOf(a), changed: Object.keys(body || {}), notes };
    }
    if (method === 'GET' && pathname === '/admin/models/catalog') {
      const val = (k) => a.config.find((f) => f.key === k)?.value;
      return { generatedAt: at(HOUR), models: a.catalog.models.map((m) => {
        const roles = ['fast', 'long', 'agent'].filter((r) => val(`llm.models.${r}`) === m.id);
        return { ...clone(m), displayName: m.display_name, chat: m.capabilities.includes('chat'), tools: m.capabilities.includes('tools'), reasoning: m.capabilities.includes('reasoning'),
          streaming: m.capabilities.includes('streaming'), reasoningEfforts: [...new Set(m.reasoning_efforts.map((e) => (e === 'none' ? 'off' : e)))], roles,
          fallback: val('llm.fallbackModel') === m.id, enabled: a.enabled.includes(m.id), health: null };
      }) };
    }
    if (method === 'POST' && pathname === '/admin/tiers/probe') {
      const st = tierStatusOf(a);
      const models = [...new Set([st.reflex.model, st.reasoning.model, st.agent.model, st.reasoning.fallback].filter(Boolean))];
      return { ...st, probed: models.map((m) => ({ model: m, ok: !(a.degraded && m === st.reasoning.model), latencyMs: a.degraded && m === st.reasoning.model ? null : (m === st.reflex.model ? 1900 : 4200), error: a.degraded && m === st.reasoning.model ? 'no response within 10000 ms' : null })), skipped: null };
    }
    if (method === 'GET' && pathname === '/admin/usage') {
      if (a.noUsage) throw notFound();
      const row = (feature, tier, calls, errors, fellBack, escalated, tokens, avg) => ({ feature, tier, calls, errors, fellBack, escalated, tokens, avgLatencyMs: avg, p95LatencyMs: avg * 2,
        errorRate: calls ? errors / calls : 0, fallbackRate: calls ? fellBack / calls : 0, escalationRate: calls ? escalated / calls : 0 });
      const features = [row('sort', 'reflex', 400, 3, 0, 12, 910000, 2300), row('sort', 'reasoning', 12, 0, 4, 0, 88000, 9000), row('work', 'reflex', 38, 0, 0, 0, 120000, 3100), row('ask', 'reasoning', 7, 4, 3, 0, 42000, 46000)];
      const calls = features.reduce((n, r) => n + r.calls, 0);
      return { days: Number(params.get('days')) || 7, userId: null, daily: [], features, tiers: {}, escalation: { escalated: 12, calls, rate: Math.round((12 / calls) * 1000) / 1000 } };
    }
    if (method === 'GET' && pathname === '/admin/health') {
      return {
        status: { ready: true }, models: activeModelsOf(a), tiers: tierStatusOf(a), gateway: { ok: true },
        aiCalls24h: [
          { feature: 'sort', calls: 412, errors: 3, avg_latency_ms: 2400 },
          { feature: 'work', calls: 38, errors: 0, avg_latency_ms: 3100 },
          { feature: 'ask', calls: 7, errors: 4, avg_latency_ms: 46000 },
        ],
      };
    }
    if (method === 'POST' && pathname === '/admin/test-llm') {
      const role = body?.role || 'fast';
      const m = activeModelsOf(a)[role];
      return { ok: true, model: m?.active, reply: 'ready', ms: role === 'fast' ? 1900 : 4200 };
    }
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

/** A regenerate answer after the configured delay, or the configured failure. */
async function regenAnswer(make) {
  db.regen.count += 1;
  if (db.regen.delayMs) await new Promise((r) => setTimeout(r, db.regen.delayMs));
  if (db.regen.fail) { const e = new Error('Could not rewrite the summary'); e.status = 502; throw e; }
  return make();
}

/** What the next regenerate calls do: { fail, delayMs } (tests). */
export function mockRegenerate(opts = {}) { Object.assign(db.regen, opts); }

let requestLog = [];
/** Every request the mock answered since the last reset ("GET /sort/screener"), for tests. */
export function mockRequests({ clear = false } = {}) { const out = requestLog; if (clear) requestLog = []; return out; }

/** Override what GET /work/thread/:id answers for a thread (tests: provenance, storyError). */
export function mockThreadExtras(threadId, extras) { db.threadExtras[threadId] = { ...(db.threadExtras[threadId] || {}), ...extras }; }

/** Answer GET /admin/usage with 404, as a server without it would (tests: the /admin/health fallback). */
export function mockNoUsage(on = true) { db.admin.noUsage = Boolean(on); }

/** Tier 2 degraded (the fallback standing in) in the mock's /admin/health and mockStatus(). */
export function mockSetDegraded(on) { db.admin.degraded = Boolean(on); }

/** A /status body with the models block, as core/index.js answers it. */
export function mockStatus() {
  return { ready: true, enabled: true, features: { context: true, triage: true, insights: true, agent: true, extraction: true, sort: true }, models: activeModelsOf(db.admin), tiers: tierStatusOf(db.admin) };
}

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
