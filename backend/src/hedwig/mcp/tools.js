// The tools Hedwig offers over MCP: everything a connected app may read or do in the person's mail.
// Some are Hedwig's own (Ask, the sorted lists, summaries, categorising, the work lists); the rest
// come from the agent tool registry (agent/toolRegistry.js), so the in-app agent and a connected
// app share one implementation. `search` and `fetch` have the shapes ChatGPT's deep research and
// company knowledge expect. Write tools need the mail.write scope; nothing here sends or deletes
// mail (draft_reply saves a draft for the person to send).
import { userTools } from '../agent/access.js';
import { validateArgs } from '../agent/validate.js';
import { loadOwnedMessage } from '../agent/mailOps.js';
import { query } from '../../services/db.js';
import { messageText, addressesOf } from '../text.js';

const ID = { type: 'string', minLength: 1, maxLength: 1000 };
const MESSAGE_ID = { type: 'string', format: 'uuid', description: 'message id from another tool' };
const THREAD_OR_MESSAGE = { ...ID, description: 'a message id, or a thread_id from another tool' };
const LIMIT = (max, def) => ({ type: 'integer', minimum: 1, maximum: max, default: def });

const CATEGORY_HELP = {
  needs_you: 'conversations that need a reply or an action from the person',
  people: 'mail from real people and conversations the person is part of',
  reading: 'newsletters, updates and anything to read later, grouped into bundles',
  records: 'receipts, invoices, notifications, bookings and codes: to keep, not to answer',
  screener: 'first mail from new senders, waiting for the person to say where they go',
  spam: 'spam and suspected phishing',
};
const STREAMS = ['people', 'reading', 'records', 'spam'];
const LIST_NAMES = {
  reply_later: 'Reply later', set_aside: 'Set aside', pin: 'Pinned', reminder: 'Reminders', done: 'Done',
  snoozed: 'Snoozed', delegated: 'Delegated', reference: 'Reference',
};
const POSTABLE = ['reply_later', 'set_aside', 'pin', 'reminder', 'done', 'delegated', 'reference'];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const messageUrl = (origin, id) => `${origin}/?m=${encodeURIComponent(id)}`;
const who = (from) => (from?.name && from?.email ? `${from.name} <${from.email}>` : from?.email || from?.name || null);
const whoRow = (m) => (m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email || null);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

/** A list row (sort stream, work list) as a connected app sees it. */
function row(origin, r, summaries) {
  return {
    id: r.messageId || null,
    thread_id: r.threadId,
    from: who(r.from),
    subject: r.subject,
    date: r.date,
    unread: Boolean(r.unread),
    needs_you: Boolean(r.needsYou),
    ...(r.reason ? { why: r.reason } : {}),
    ...(r.bundle ? { bundle: r.bundle } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.until ? { until: r.until } : {}),
    summary: (r.messageId && summaries?.get(r.messageId)?.text) || r.snippet || null,
    ...(r.messageId ? { url: messageUrl(origin, r.messageId) } : {}),
  };
}

async function summariesFor(userId, items) {
  const ids = items.map((i) => i.messageId).filter(isUuid);
  if (!ids.length) return new Map();
  const { tldrFor } = await import('../work/summaries.js');
  return tldrFor(userId, ids).catch(() => new Map());
}

// ── Hedwig's own tools ──────────────────────────────────────────────────────

const OWN = [
  {
    name: 'search',
    title: 'Search mail',
    description: "Search the person's email across all their accounts, by keyword and by meaning. Returns up to 10 matches as { id, title, url, snippet }; pass an id to fetch to read the message. For filters (a person, a date range, more results) use search_mail; to have a question answered from the mail, use ask.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500, description: 'What to look for, in words' } }, required: ['query'] },
    async run({ query: q }, { userId, origin }) {
      const { searchIndexed } = await import('../context/search.js');
      const { results } = await searchIndexed(userId, { q, limit: 10 });
      return {
        results: results.map((m) => ({
          id: m.id,
          title: `${m.subject || '(no subject)'} — ${m.from_name || m.from_email || 'unknown sender'}`,
          url: messageUrl(origin, m.id),
          snippet: m.excerpt || m.snippet || '',
        })),
      };
    },
  },
  {
    name: 'fetch',
    title: 'Read a message',
    description: "Read one message in full: sender, recipients, date, account, folder, Hedwig's category and one-line summary, attachment names, and the text (quoted history removed). Takes an id from search, search_mail, list_mail or any other tool.",
    inputSchema: { type: 'object', properties: { id: MESSAGE_ID }, required: ['id'] },
    async run({ id }, { userId, origin }) {
      const m = await loadOwnedMessage(userId, id);
      const hasBody = Boolean(m.body_text || m.body_html);
      if (!hasBody) {
        import('../core/bodies.js').then(({ requestBody }) => requestBody(m.id, { priority: 3 })).catch(() => {});
      }
      const [{ rows: [acc] }, { rows: [s] }, tldrs] = await Promise.all([
        query('SELECT name, email_address FROM email_accounts WHERE id = $1 AND user_id = $2', [m.account_id, userId]),
        query('SELECT stream, bundle, needs_you, needs_you_reason, spam FROM hedwig_sort WHERE message_id = $1 AND user_id = $2', [m.id, userId]),
        summariesFor(userId, [{ messageId: m.id }]),
      ]);
      const short = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);
      const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => a?.filename || a?.name).filter(Boolean);
      return {
        id: m.id,
        title: m.subject || '(no subject)',
        text: messageText(m, { maxChars: 16000 }) || '',
        url: messageUrl(origin, m.id),
        metadata: {
          from: whoRow(m),
          to: addressesOf(m.to_addresses).slice(0, 20).map(short),
          cc: addressesOf(m.cc_addresses).slice(0, 20).map(short),
          date: m.date,
          account: acc ? `${acc.name} <${acc.email_address}>` : null,
          folder: m.folder,
          thread_id: m.thread_key || m.id,
          unread: !m.is_read,
          starred: Boolean(m.is_starred),
          category: s ? (s.spam && !['clean', 'rescued'].includes(s.spam) ? 'spam' : s.stream) : null,
          ...(s?.bundle ? { bundle: s.bundle } : {}),
          needs_you: Boolean(s?.needs_you),
          ...(s?.needs_you && s.needs_you_reason ? { why: s.needs_you_reason } : {}),
          summary: tldrs.get(m.id)?.text || null,
          attachments,
          ...(hasBody ? {} : { note: 'Only the preview has been downloaded so far; the full text has been requested. Fetch again in a minute.' }),
        },
      };
    },
  },
  {
    name: 'ask',
    title: 'Ask Hedwig',
    // It can read public web pages (search results and links in the mail), so it is open-world, but
    // it only reads: it never opens sign-in, unsubscribe or payment links, and changes no mail.
    openWorld: true,
    description: "Ask a question about the person's mail in plain words ('what did the landlord say about the deposit?', 'all the AI expenses my team sent me'). Hedwig searches several ways, reads the messages and answers with [n] citations to the mail in sources and, when it looked on the web, to the pages in web_sources (numbered after the mail). Pass thread_id to ask about one conversation: it is read whole first and the rest of the mail searched for what it leaves out. When the person allows it, Hedwig may also search the web and read a few pages; use_web turns that on or off for this question, and dig_deeper looks further. Takes 5 to 30 seconds, longer with the web. To follow up on an answer, pass its answer_id as follow_up_of (a follow-up stays on its conversation); to look further, ask the same question again with follow_up_of and dig_deeper.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 2000 },
        follow_up_of: { type: 'string', format: 'uuid', description: 'answer_id of an earlier answer this question follows up on' },
        thread_id: { ...THREAD_OR_MESSAGE, description: 'ask about this conversation: a thread_id, or the id of any message in it' },
        use_web: { type: 'boolean', description: "search the web and read pages for this question (true) or answer from the mail alone (false); leave out to follow the person's setting" },
        dig_deeper: { type: 'boolean', default: false, description: 'more rounds of looking on the web, following links on the pages read; turns the web on unless use_web is false' },
      },
      required: ['question'],
    },
    async run({ question, follow_up_of: followUpOf, thread_id: threadId, use_web: useWeb, dig_deeper: deep }, { userId, origin, signal }) {
      const { answerQuestion } = await import('../context/service.js');
      // answerQuestion resolves thread_id (a thread_key or a message id) with findThreadKey.
      const web = useWeb ?? (deep ? true : null);
      const out = await answerQuestion(userId, question, {
        followUpOf: followUpOf || null, threadKey: threadId || null, web, deep: deep === true, signal,
      });
      const thread = out.plan?.thread?.key || null;
      return {
        answer: out.answer,
        answer_id: out.askLogId || null,
        found_nothing: Boolean(out.notFound),
        ...(thread ? { thread_id: thread } : {}),
        sources: (out.sources || []).map((s) => ({
          n: s.n,
          id: s.message?.id || null,
          subject: s.message?.subject || null,
          from: s.message ? whoRow(s.message) : null,
          date: s.message?.date || null,
          ...(s.message?.id ? { url: messageUrl(origin, s.message.id) } : {}),
        })),
        web_sources: (out.web || []).map((w) => ({
          n: w.n, url: w.url, title: w.title || w.host || null, host: w.host || null, snippet_only: Boolean(w.snippetOnly),
        })),
        ...(web === true && out.plan?.research?.via === 'unavailable'
          ? { note: 'Web search is not set up on this Hedwig, so the answer comes from the mail alone.' } : {}),
      };
    },
  },
  {
    name: 'list_mail',
    title: 'List sorted mail',
    description: `List the newest conversations in one of Hedwig's categories, one row per conversation with a one-line summary: ${Object.entries(CATEGORY_HELP).map(([k, v]) => `${k} (${v})`).join('; ')}. Pass next_cursor back as cursor for the next page.`,
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: Object.keys(CATEGORY_HELP), default: 'needs_you' },
        bundle: { type: 'string', maxLength: 100, description: 'only this bundle (a key from list_categories), for reading and records' },
        limit: LIMIT(50, 20),
        cursor: { type: 'string', maxLength: 500 },
      },
    },
    async run({ category, bundle, limit, cursor }, { userId, origin }) {
      const { streamList } = await import('../sort/service.js');
      const stream = category === 'needs_you' ? 'people' : category;
      const page = await streamList(userId, stream, { needsYou: category === 'needs_you', limit, cursor: cursor || null, bundle: bundle || null });
      const items = page.items.slice(0, limit);
      const summaries = await summariesFor(userId, items);
      return { category, items: items.map((r) => row(origin, r, summaries)), next_cursor: page.next };
    },
  },
  {
    name: 'list_categories',
    title: 'Categories and bundles',
    description: "How Hedwig sorts the person's mail: the categories, and the bundles that group Reading and Records (newsletters, receipts, travel…), with how many messages each bundle holds.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { userId }) {
      const { listBundles } = await import('../sort/bundles.js');
      const { bundles } = await listBundles(userId);
      return {
        categories: Object.entries(CATEGORY_HELP).map(([id, description]) => ({ id, description })),
        bundles: bundles.map((b) => ({ key: b.key, name: b.name, category: b.stream, messages: b.count, enabled: b.enabled !== false, ...(b.schedule?.mode && b.schedule.mode !== 'instant' ? { delivered: b.schedule } : {}) })),
      };
    },
  },
  {
    name: 'explain_category',
    title: 'Why it was sorted there',
    description: 'Explain why Hedwig put a message in its category: which layer decided (a rule, the sender, the classifier, a model or the person), the reason, the signals, and any rule or sender decision behind it.',
    inputSchema: { type: 'object', properties: { id: MESSAGE_ID }, required: ['id'] },
    async run({ id }, { userId }) {
      const { why } = await import('../sort/service.js');
      const w = await why(userId, id);
      return {
        category: w.spam && !['clean', 'rescued'].includes(w.spam) ? 'spam' : w.stream,
        bundle: w.bundle,
        needs_you: Boolean(w.needsYou),
        ...(w.needsYouReason ? { needs_you_reason: w.needsYouReason } : {}),
        spam: w.spam,
        ...(w.spamReason ? { spam_reason: w.spamReason } : {}),
        decided_by: w.layer,
        reason: w.reason,
        confidence: w.confidence,
        signals: (w.signals || []).slice(0, 12).map((s) => s.label || s.name).filter(Boolean),
        ...(w.rule ? { rule: { id: w.rule.id, name: w.rule.name } } : {}),
        ...(w.senderDecision ? { sender_decision: { sender: w.senderDecision.key, scope: w.senderDecision.scope, category: w.senderDecision.decision, by: w.senderDecision.source } } : {}),
        decided_at: w.decidedAt,
      };
    },
  },
  {
    name: 'sorting_log',
    title: 'What Hedwig sorted today',
    description: "Today's sorting: senders screened, mail bundled, rescued from spam or blocked, and every change with a log_id. Changes marked undoable can be reversed with undo_sorting.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { userId }) {
      const { today } = await import('../sort/service.js');
      const t = await today(userId);
      return {
        since: t.since, screened: t.screened, bundled: t.bundled, rescued: t.rescued, blocked: t.blocked,
        changes: t.entries.slice(0, 60).map((e) => ({ log_id: Number(e.id), what: e.text, by: e.by, at: e.createdAt, undoable: e.undoable, ...(e.messageId ? { id: e.messageId } : {}) })),
      };
    },
  },
  {
    name: 'list_screener',
    title: 'Senders in the Screener',
    description: "New senders waiting in the Screener, each with Hedwig's proposal (people, reading, records or block), how many messages they sent and recent subjects. Decide with screen_sender.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { userId }) {
      const { screener } = await import('../sort/service.js');
      const { senders } = await screener(userId);
      return {
        senders: senders.map((s) => ({
          sender_key: s.key, scope: s.scope, sender: s.display, messages: s.count, proposed: s.proposed,
          ...(s.reason ? { why: s.reason } : {}), in_spam: s.inSpam, subjects: s.subjects.slice(0, 3), last_date: s.lastDate,
        })),
      };
    },
  },
  {
    name: 'summarize_thread',
    title: 'Summarise a conversation',
    description: "Hedwig's summary of a conversation: the story so far, a one-line TL;DR, any deadline, a timeline of who said what, a one-line summary of each message, and suggested quick replies. Takes a message id or thread_id. Written once and kept, so it is fast the second time.",
    inputSchema: { type: 'object', properties: { id: THREAD_OR_MESSAGE, refresh: { type: 'boolean', default: false, description: 'write it again even if one is saved' } }, required: ['id'] },
    async run({ id, refresh }, { userId }) {
      const { threadStory } = await import('../work/thread.js');
      const s = await threadStory(userId, id, { refresh });
      return {
        thread_id: s.threadId,
        tldr: s.tldr,
        story: s.story,
        ...(s.deadline ? { deadline: s.deadline } : {}),
        timeline: s.timeline,
        message_summaries: s.messageTldrs,
        quick_replies: s.quickReplies,
        ...(s.storyError ? { note: s.storyError === 'budget' ? "Today's AI budget is used up; the timeline is from the messages alone." : `The summary could not be written: ${s.storyError}` } : {}),
      };
    },
  },
  {
    name: 'get_list',
    title: 'Work lists',
    description: `The conversations on one of the person's work lists (${Object.entries(LIST_NAMES).map(([k, v]) => `${k}: ${v}`).join(', ')}), with how many are on every list.`,
    inputSchema: { type: 'object', properties: { list: { type: 'string', enum: Object.keys(LIST_NAMES) }, limit: LIMIT(100, 30) }, required: ['list'] },
    async run({ list, limit }, { userId, origin }) {
      const { listItems, listCounts } = await import('../work/lists.js');
      const [page, counts] = await Promise.all([listItems(userId, list, { limit }), listCounts(userId)]);
      const summaries = await summariesFor(userId, page.items);
      return {
        list,
        items: page.items.map((r) => row(origin, r, summaries)),
        counts: Object.fromEntries(Object.keys(LIST_NAMES).map((k) => [k, Number(counts[k]) || 0])),
      };
    },
  },
  {
    name: 'list_waiting_on',
    title: 'Waiting on replies',
    description: 'Conversations where the person asked something and nobody has answered yet, longest wait first, with who they are waiting on.',
    inputSchema: { type: 'object', properties: { limit: LIMIT(100, 30) } },
    async run({ limit }, { userId, origin }) {
      const { listWaiting } = await import('../work/waiting.js');
      const items = (await listWaiting(userId)).slice(0, limit);
      return {
        items: items.map((w) => ({
          id: w.messageId, thread_id: w.threadId, waiting_on: w.whoEmail ? `${w.who} <${w.whoEmail}>` : w.who, subject: w.subject,
          asked_at: w.askedAt, days: w.days, why: w.reason, ...(w.messageId ? { url: messageUrl(origin, w.messageId) } : {}),
        })),
      };
    },
  },
  {
    name: 'list_cards',
    title: 'Receipts, bills, deliveries…',
    description: 'What Hedwig pulled out of the mail: receipts, invoices, subscriptions, deliveries, travel, events, sign-in codes and deadlines, newest first, each with its fields (amounts, dates, tracking…) and the message it came from.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['receipt', 'invoice', 'subscription', 'delivery', 'travel', 'event', 'code', 'deadline'] },
        limit: LIMIT(100, 30),
      },
    },
    async run({ kind, limit }, { userId, origin }) {
      const { listCards } = await import('../cards/store.js');
      const cards = await listCards(userId, { kinds: kind ? [kind] : null, limit });
      return {
        cards: cards.map((c) => ({
          id: c.id, kind: c.kind, fields: c.fields, date: c.eventAt,
          ...(c.message ? { message: { id: c.message.id, subject: c.message.subject, from: whoRow(c.message), date: c.message.date }, url: messageUrl(origin, c.message.id) } : {}),
        })),
      };
    },
  },

  // ── Write tools ───────────────────────────────────────────────────────────
  {
    name: 'categorize',
    title: 'Move to a category',
    write: true,
    description: "Correct how Hedwig sorted a message: move it to people, reading, records or spam, put it in a bundle, or say whether it needs the person. apply_to 'sender' or 'list' does the same for everything from that sender or mailing list, now and from now on; 'kind' makes a rule for mail like it. Hedwig learns from it, and undo_sorting reverses it with the log_id.",
    inputSchema: {
      type: 'object',
      properties: {
        id: MESSAGE_ID,
        category: { type: 'string', enum: STREAMS },
        bundle: { type: ['string', 'null'], maxLength: 100, description: 'bundle key from list_categories (reading and records); null takes it out of its bundle' },
        needs_you: { type: 'boolean' },
        apply_to: { type: 'string', enum: ['this', 'sender', 'list', 'kind'], default: 'this' },
        note: { type: 'string', maxLength: 500, description: 'why, in the person\'s words (optional)' },
      },
      required: ['id'],
    },
    async run({ id, category, bundle, needs_you: needsYou, apply_to: applyTo, note }, { userId }) {
      const { correct } = await import('../sort/service.js');
      const out = await correct(userId, {
        messageId: id, stream: category, bundle, needsYou, always: applyTo && applyTo !== 'this' ? applyTo : null, note: note || null,
      });
      return {
        category: out.sort.stream, bundle: out.sort.bundle || null, needs_you: Boolean(out.sort.needsYou), spam: out.sort.spam,
        reason: out.sort.reason, log_id: Number(out.logId), ...(out.ruleId ? { rule_id: out.ruleId } : {}),
        _summary: `Sorted “${out.sort.subject || 'a message'}” into ${cap(out.sort.stream)}${applyTo && applyTo !== 'this' ? `, with everything like it (${applyTo})` : ''}`,
      };
    },
  },
  {
    name: 'screen_sender',
    title: 'Decide on a sender',
    write: true,
    description: 'Decide where a sender goes from now on (people, reading or records), or block them. Use the sender_key and scope from list_screener; an email address, domain or List-Id also works. Their waiting mail moves at once. undo_sorting reverses it.',
    inputSchema: {
      type: 'object',
      properties: {
        sender_key: { type: 'string', minLength: 1, maxLength: 320 },
        scope: { type: 'string', enum: ['address', 'domain', 'list'], default: 'address' },
        decision: { type: 'string', enum: ['people', 'reading', 'records', 'block'] },
      },
      required: ['sender_key', 'decision'],
    },
    async run({ sender_key: key, scope, decision }, { userId }) {
      const { decide } = await import('../sort/service.js');
      const out = await decide(userId, { key, scope, decision });
      return { decided: out.decided, moved: out.moved, log_id: out.logId == null ? null : Number(out.logId), _summary: decision === 'block' ? `Blocked ${key}` : `Sent mail from ${key} to ${cap(decision)}` };
    },
  },
  {
    name: 'undo_sorting',
    title: 'Undo a sorting change',
    write: true,
    description: 'Reverse a sorting change by its log_id (from categorize, screen_sender or sorting_log).',
    inputSchema: { type: 'object', properties: { log_id: { type: 'integer', minimum: 1 } }, required: ['log_id'] },
    async run({ log_id: logId }, { userId }) {
      const { undo } = await import('../sort/service.js');
      return { ...(await undo(userId, { logId })), _summary: 'Undid a sorting change' };
    },
  },
  {
    name: 'snooze',
    title: 'Snooze',
    write: true,
    description: "Snooze a conversation: it leaves the inbox and comes back at `until` (within 30 days; call today first to resolve 'tomorrow' or 'Monday'). Without until it comes back at the person's usual snooze time.",
    inputSchema: {
      type: 'object',
      properties: { id: THREAD_OR_MESSAGE, until: { type: 'string', format: 'date-time', description: 'ISO 8601 date-time with a timezone offset' } },
      required: ['id'],
    },
    async run({ id, until }, { userId }) {
      const { snooze } = await import('../work/lists.js');
      const out = await snooze(userId, { ...(isUuid(id) ? { messageId: id } : { threadId: id }), until });
      return { thread_id: out.threadId, until: out.until, _summary: `Snoozed a conversation until ${new Date(out.until).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
    },
  },
  {
    name: 'add_to_list',
    title: 'Add to a work list',
    write: true,
    description: `Put a conversation on one of the person's work lists: ${POSTABLE.map((k) => `${k} (${LIST_NAMES[k]})`).join(', ')}. 'done' marks it handled and clears it from Needs You. A reminder needs until; a reminder with no id is a free-standing to-do (note is its text).`,
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: POSTABLE },
        id: { ...THREAD_OR_MESSAGE, description: 'the conversation (a message id or thread_id); leave out for a free-standing reminder' },
        note: { type: 'string', maxLength: 500 },
        until: { type: 'string', format: 'date-time', description: 'for reminders: when (ISO 8601 with offset)' },
      },
      required: ['list'],
    },
    async run({ list, id, note, until }, { userId }) {
      const { addItem } = await import('../work/lists.js');
      const out = await addItem(userId, list, { threadId: id, note, until });
      return {
        list, thread_id: out.item?.threadId || null, subject: out.item?.subject || null,
        _summary: `Added ${out.item?.subject ? `“${out.item.subject}”` : 'a conversation'} to ${LIST_NAMES[list]}`,
      };
    },
  },
  {
    name: 'remove_from_list',
    title: 'Take off a work list',
    write: true,
    description: 'Take a conversation off a work list (from get_list). Taking it off done puts it back in People.',
    inputSchema: {
      type: 'object',
      properties: { list: { type: 'string', enum: POSTABLE }, id: { ...THREAD_OR_MESSAGE, description: 'thread_id from get_list (or a message id)' } },
      required: ['list', 'id'],
    },
    async run({ list, id }, { userId }) {
      const { removeItem } = await import('../work/lists.js');
      await removeItem(userId, list, id);
      return { ok: true, _summary: `Took a conversation off ${LIST_NAMES[list]}` };
    },
  },
  {
    name: 'remind_if_no_reply',
    title: 'Remind me if no reply',
    write: true,
    description: 'Watch a conversation the person wrote in: if nobody answers within `days`, it shows up in Waiting On and Needs You.',
    inputSchema: { type: 'object', properties: { id: THREAD_OR_MESSAGE, days: { type: 'integer', minimum: 1, maximum: 60, default: 3 } }, required: ['id'] },
    async run({ id, days }, { userId }) {
      const { addWatch } = await import('../work/waiting.js');
      const out = await addWatch(userId, { threadId: id, days });
      return { thread_id: out.watch.threadId, due_at: out.watch.dueAt, _summary: `Will remind if nobody replies in ${days} day${days === 1 ? '' : 's'}` };
    },
  },
];

// ── Tools from the agent registry ───────────────────────────────────────────

// Core registry tools offered here, and whether each changes anything. read_message and
// snooze_message have fuller versions above (fetch, snooze); the triage tools are the older lists
// that Hedwig's sorting replaced.
const REGISTRY = {
  list_accounts: { title: 'Mail accounts' },
  search_mail: { title: 'Search mail with filters' },
  get_thread: { title: 'Read a conversation' },
  today: { title: 'Date and time' },
  get_overview: { title: 'Mail statistics' },
  get_briefing: { title: 'Daily briefing' },
  get_person: { title: 'About a person' },
  list_topics: { title: 'Topics' },
  get_topic: { title: 'A topic' },
  list_commitments: { title: 'Commitments' },
  list_automations: { title: 'Automations' },
  archive_message: { title: 'Archive', write: true },
  move_message: { title: 'Move to a folder', write: true },
  mark_read: { title: 'Mark read or unread', write: true },
  star_message: { title: 'Star or unstar', write: true },
  draft_reply: { title: 'Save a reply draft', write: true },
  create_commitment: { title: 'Track a commitment', write: true },
  complete_commitment: { title: 'Complete a commitment', write: true },
  update_commitment: { title: 'Change a commitment', write: true },
};

const humanize = (name) => cap(name.replace(/^[a-z0-9]+__/, '').replace(/_/g, ' '));

function fromRegistry(t, meta) {
  return {
    name: t.name,
    title: meta.title || humanize(t.name),
    description: t.description,
    inputSchema: t.parameters || { type: 'object', properties: {} },
    write: Boolean(meta.write),
    registry: t,
    async run(args, ctx) {
      let summary = null;
      if (typeof t.prepare === 'function') summary = (await t.prepare(args, { userId: ctx.userId }))?.summary || null;
      const out = await t.handler(args, { userId: ctx.userId, signal: ctx.signal });
      const base = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out };
      return meta.write ? { ...base, _summary: summary || (typeof t.summarize === 'function' ? t.summarize(args) : meta.title) } : base;
    },
  };
}

/** Every tool this connection may use: read tools always, write tools with mail.write. */
export async function toolsFor({ userId, scopes }) {
  const canWrite = scopes.includes('mail.write');
  const list = OWN.filter((t) => !t.write || canWrite);
  const available = await userTools(userId);
  for (const t of available) {
    const meta = t.pluginId ? { write: Boolean(t.mutates) } : REGISTRY[t.name];
    if (!meta || list.some((x) => x.name === t.name)) continue;
    if (meta.write && !canWrite) continue;
    list.push(fromRegistry(t, meta));
  }
  return list;
}

/** The MCP tools/list entry for a tool. */
export function describe(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      // Nothing here deletes or sends: archive, move, snooze and sorting can all be put back.
      destructiveHint: false,
      idempotentHint: !t.write,
      openWorldHint: Boolean(t.openWorld),
    },
  };
}

export class ToolInputError extends Error {}

/**
 * Validate and run one tool. Returns the tool's result; a `_summary` key (write tools) is split off
 * as `summary` for the activity log.
 */
export async function runTool(tool, rawArgs, ctx) {
  const v = validateArgs(tool.inputSchema, rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
  if (!v.ok) throw new ToolInputError(`Invalid arguments: ${v.errors.join('; ')}`);
  const out = await tool.run(v.value, ctx);
  if (out && typeof out === 'object' && !Array.isArray(out) && '_summary' in out) {
    const { _summary: summary, ...result } = out;
    return { result, summary };
  }
  return { result: out, summary: null };
}

export function _ownTools() { return OWN; }
