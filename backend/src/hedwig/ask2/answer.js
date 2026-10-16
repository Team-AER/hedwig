// Ask on the v2 index: plan → retrieve (A's retrieve(), threads expanded) → relevance floor →
// evidence grouped by thread → streamed answer on the reasoning tier → citation check → log.
// Events (unchanged for the frontend, fields only added):
//   { type: 'sources', sources: [{ n, message: MessageLite }], askLogId, plan, coverage }
//   { type: 'delta', text }…
//   { type: 'done', answer, citations: [n], unsupported, notFound, invalidCitations: [n], askLogId,
//     coverage, model, lighterModel }
// coverage = { share: 0..1, indexed, total, complete } (indexer/truth.js): until the index is
// complete, the UI says how much of the mail the answer could see. lighterModel: the answer came
// from the fallback model because Tier 2 did not answer (label it "lighter model").
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { chatStream } from '../llm.js';
import { retrieve } from '../indexer/retrieve.js';
import { loadMessagesLite } from '../context/shapes.js';
import { ownsEntity, ownsTopic } from '../context/cards.js';
import { httpError, isoDay, isUuid } from '../context/util.js';
import { planQuery } from './plan.js';
import { runPrompt } from '../prompts/index.js';
import { groupByThread, buildEvidence } from './evidence.js';
import { checkCitations } from './citations.js';
import { ANSWER_PROMPT, answerMessages, ownerIdentity, ownerLine } from './prompt.js';
import { webSettings, planResearch, researchWeb, linkCandidates, webEvidence, publicWebSource } from './web.js';
import { findThreadKey, loadThreadMessages } from '../work/util.js';
import { requestBody } from '../core/bodies.js';
import { coverageShare } from '../indexer/truth.js';
import { ranOnLighterModel } from '../labels/tier.js';

export const NOTHING_RELEVANT = "I couldn't find anything relevant in your mail about that.";

/** The "nothing found" answer, saying how much of the mail was searchable when the index is incomplete. Pure. */
export function nothingRelevant(coverage) {
  const share = coverage?.share;
  if (coverage?.complete || typeof share !== 'number' || !(share < 1)) return NOTHING_RELEVANT;
  const pct = Math.max(0, Math.min(99, Math.floor(share * 100)));
  return `${NOTHING_RELEVANT} Only ${pct}% of your mail is indexed so far, so it may still turn up.`;
}

const ROW_COLS = `m.id, m.thread_key, m.subject, m.from_name, m.from_email, m.to_addresses, m.date, m.folder,
  m.body_text, m.body_html, m.snippet, m.attachments, m.has_attachments`;

async function visibleRows(userId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT ${ROW_COLS} FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = ANY($2::uuid[]) AND m.is_deleted = false`,
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function focusLine(userId, entityId, topicId) {
  const lines = [];
  if (entityId) {
    const { rows } = await query('SELECT display_name, primary_email, domain FROM hedwig_entities WHERE id = $1 AND user_id = $2', [entityId, userId]);
    if (rows[0]) lines.push(`The question is about ${rows[0].display_name || rows[0].primary_email || rows[0].domain}${rows[0].primary_email ? ` <${rows[0].primary_email}>` : ''}.`);
  }
  if (topicId) {
    const { rows } = await query('SELECT label FROM hedwig_topics WHERE id = $1 AND user_id = $2', [topicId, userId]);
    if (rows[0]?.label) lines.push(`The question is about the matter "${rows[0].label}".`);
  }
  return lines.join('\n');
}

/**
 * The earlier answer's messages a follow-up reads again: the ones it cited first, then the rest in
 * order, up to `max`. sources are message ids in evidence order, so citation n is sources[n - 1].
 */
export function carriedSources(previous, max) {
  const ids = (Array.isArray(previous?.sources) ? previous.sources : []).filter(isUuid);
  const cited = (Array.isArray(previous?.citations) ? previous.citations : []).map((n) => ids[Number(n) - 1]).filter(Boolean);
  return [...new Set([...cited, ...ids])].slice(0, Math.max(0, Number(max) || 0));
}

async function previousAnswer(userId, id) {
  const { rows } = await query(
    'SELECT id, question, answer, sources, citations, status, thread_key, web FROM hedwig_ask_log WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!rows[0]) throw httpError(404, 'Earlier answer not found');
  return rows[0];
}

const messageCount = (chunks) => new Set((chunks || []).map((c) => c.messageId)).size;
const MONTH_OR_YEAR = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|(?:19|20)\d{2})\b/gi;
/** A search the model named, without month names and years: the search does not filter by them. */
export function searchWords(text) {
  return String(text || '').replace(MONTH_OR_YEAR, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
const sameSearch = (a, b) => String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Several searches' chunks (each list best first) as one list, best first. A chunk ranks by its best
 * place in any one search, so each search's top hits come first in turn; being found by more
 * searches only breaks ties. (Summing the ranks let mail that every search half-matches, such
 * as newsletters that all mention "AI", crowd out the one mail a single search found first.)
 * One search comes back as it was.
 */
export function mergeRuns(runs, { k = 60, limit = Infinity } = {}) {
  const lists = (runs || []).filter((r) => Array.isArray(r?.chunks));
  if (lists.length === 1) return lists[0].chunks.slice(0, limit);
  const byId = new Map();
  for (const run of lists) {
    run.chunks.forEach((c, i) => {
      const id = c.chunkId != null ? `c${c.chunkId}` : `m${c.messageId}:${c.kind}:${c.ordinal}`;
      const cur = byId.get(id) || { chunk: c, best: 0, sum: 0 };
      const r = 1 / (k + i + 1);
      cur.best = Math.max(cur.best, r);
      cur.sum += r;
      byId.set(id, cur);
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.best - a.best || b.sum - a.sum)
    .slice(0, limit)
    .map(({ chunk, best }) => ({ ...chunk, score: Math.round(best * 1e5) / 1e5 }));
}

/**
 * Ask searches again with its own words. After each round the Reflex model (ask.refine) sees the
 * question and what the searches found, and either says that is enough or names up to three new
 * searches in the words the missing mail would use ("AI subscription reimbursement" for "AI
 * expenses"). Stops after ask.searchRounds rounds, when it is satisfied, or when a round finds no
 * new message. A model failure or timeout ends the searching, never the answer.
 * @returns {{ chunks: object[], searches: { text: string, found: number }[] }}
 */
export async function searchAgain(userId, question, planned, first, { previous = null, entityId = null, topicId = null, cfg, signal, onEvent = () => {} } = {}) {
  const runs = [first];
  const searches = [{ text: first.text, found: messageCount(first.chunks) }];
  const seen = new Set(first.chunks.map((c) => c.messageId));
  // Up to twice what one search returns; the evidence's token budget trims the rest.
  const limit = () => Math.max(...runs.map((r) => r.chunks.length)) * Math.min(runs.length, 2);
  for (let round = 1; round <= (Number(cfg['ask.searchRounds']) || 0); round++) {
    const merged = mergeRuns(runs, { limit: limit() });
    const ids = [...new Set(merged.map((c) => c.messageId))].slice(0, 40);
    const lite = await loadMessagesLite(userId, ids, { dedupe: false });
    const found = lite.map((m) => `${m.date ? new Date(m.date).toISOString().slice(0, 10) : '?'} · ${m.from_name || m.from_email || '?'} · ${String(m.subject || '(no subject)').slice(0, 120)}`).join('\n');
    const timeout = AbortSignal.timeout(cfg['ask.refineTimeoutMs'] || 8000);
    onEvent({ type: 'review', round, status: 'running' });
    let data;
    try {
      ({ data } = await runPrompt('ask.refine', {
        question, previous: previous ? `${previous.question}${previous.answer ? ` (answered: ${String(previous.answer).replace(/\s+/g, ' ').slice(0, 300)})` : ''}` : '',
        searches: runs.map((r) => r.text), found, count: lite.length,
      }, { userId, feature: 'ask', lane: 'interactive', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
    } catch (err) {
      if (signal?.aborted) throw err;
      onEvent({ type: 'review', round, status: 'done', enough: true, searches: [] });
      break;
    }
    const next = [];
    for (const raw of Array.isArray(data?.searches) ? data.searches : []) {
      const text = searchWords(raw);
      if (text.length >= 2 && ![...runs.map((r) => r.text), ...next].some((t) => sameSearch(t, text))) next.push(text);
    }
    const enough = data?.enough === true || !next.length;
    onEvent({ type: 'review', round, status: 'done', enough, searches: enough ? [] : next.slice(0, 3) });
    if (enough) break;
    for (const text of next.slice(0, 3)) onEvent({ type: 'search', text, round, status: 'running' });
    const results = await Promise.all(next.slice(0, 3).map((text) => gather(userId, { ...planned, text }, { entityId, topicId, cfg, queryText: text })));
    let fresh = 0;
    next.slice(0, 3).forEach((text, i) => {
      const chunks = results[i].chunks;
      const added = new Set(chunks.map((c) => c.messageId).filter((id) => !seen.has(id)));
      for (const id of added) seen.add(id);
      fresh += added.size;
      runs.push({ text, chunks });
      searches.push({ text, found: added.size });
      onEvent({ type: 'search', text, found: added.size, round, status: 'done' });
    });
    if (!fresh) break;
  }
  return { chunks: mergeRuns(runs, { limit: limit() }), searches };
}

/** Retrieval, with the old message-level search as a stand-in while the chunk index is incomplete. */
async function gather(userId, plan, { entityId, topicId, cfg, queryText }) {
  const filters = {
    people: plan.people, after: plan.after, before: plan.before, folders: plan.folders,
    hasAttachment: plan.hasAttachment === true ? true : undefined, entityId, topicId,
  };
  const res = await retrieve({ userId, query: queryText, filters, limit: cfg['ask.retrieveLimit'], expandThreads: true });
  if (res.chunks.length || res.floor) return { chunks: res.chunks, floor: res.floor, via: 'index' };
  const { indexComplete, searchIndexed } = await import('../context/search.js');
  if (await indexComplete(userId)) return { chunks: [], floor: false, via: 'index' };
  const { results } = await searchIndexed(userId, {
    q: queryText, limit: Math.min(30, cfg['ask.retrieveLimit']), entityId, topicId, after: plan.after, before: plan.before, people: plan.people,
  });
  return {
    chunks: results.map((m, i) => ({
      chunkId: `legacy-${i}`, messageId: m.id, threadId: m.thread_key, kind: 'body', ordinal: 0, text: `\n${m.excerpt || m.snippet || ''}`, score: m.score, date: m.date,
    })),
    floor: false,
    via: 'legacy',
  };
}

const compactPlan = (p) => ({
  text: p.text, people: p.people, after: p.after, before: p.before, folders: p.folders,
  hasAttachment: p.hasAttachment, latest: p.latest, quoted: p.quoted, rules: p.rules, via: p.via,
  ...(p.reflexError ? { reflexError: p.reflexError } : {}), ...(p.provenance ? { provenance: p.provenance } : {}), ms: p.ms,
});

/** A thread's subject without reply and forward prefixes. Pure. */
export const bareSubject = (s) => String(s || '').replace(/^((re|fw|fwd|aw|wg|sv|tr)\s*:\s*)+/i, '').trim();

/** The newest message in the thread from someone other than the user (whose site tracked links belong to). */
function latestSender(threadRows) {
  const theirs = threadRows.filter((r) => !r.mine);
  const r = theirs[theirs.length - 1] || threadRows[threadRows.length - 1];
  return String(r?.from_email || '').split('@')[1] || '';
}

/**
 * Answer a question from the user's mail, streaming events through onEvent.
 *
 * threadKey: Ask about this (the reader). The thread is read whole and comes first; the rest of the
 * mailbox is searched for what it leaves out. A follow-up stays on its conversation's thread.
 * web: true/false for this question (null: the user's ask.web.enabled). With the web on and a search
 * service set up, ask.research decides what to look up, and the web stage (ask2/web.js) runs beside
 * the mail search; its pages are numbered after the mail. deep: Dig deeper (more rounds of looking).
 * Extra events: { type: 'thread', status, messages, subject }, and the web stage's 'web', 'read',
 * 'links' and 'dig' events. 'sources' carries `web: [{ n, url, title, host, … }]`.
 * @returns {Promise<{ answer, citations, sources: {n, message}[], web: object[], unsupported, notFound, askLogId, plan }>}
 */
export async function answerQuestion(userId, question, {
  entityId = null, topicId = null, threadKey = null, web = null, deep = false, followUpOf = null,
  onEvent = () => {}, signal, now = new Date(), fetchers = {},
} = {}) {
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw httpError(400, 'question is required');
  if (q.length > 2000) throw httpError(400, 'question too long');
  if (entityId != null && !(await ownsEntity(userId, entityId))) throw httpError(404, 'Entity not found');
  if (topicId != null && !(await ownsTopic(userId, topicId))) throw httpError(404, 'Topic not found');
  if (followUpOf != null && !isUuid(followUpOf)) throw httpError(400, 'invalid followUpOf');
  if (threadKey != null && (typeof threadKey !== 'string' || !threadKey.trim() || threadKey.length > 1000)) throw httpError(400, 'invalid threadKey');
  if (web != null && typeof web !== 'boolean') throw httpError(400, 'web must be true or false');
  const cfg = await getConfig(userId);
  const previous = followUpOf ? await previousAnswer(userId, followUpOf) : null;
  const askedKey = threadKey ?? previous?.thread_key ?? null;
  const focus = askedKey ? await findThreadKey(userId, askedKey) : null;
  if (askedKey && !focus) throw httpError(404, 'Thread not found');
  const ws = webSettings(cfg, web);

  const { rows: [log] } = await query(
    `INSERT INTO hedwig_ask_log (user_id, question, entity_id, topic_id, follow_up_of, thread_key, web)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, q, isUuid(entityId) ? entityId : null, isUuid(topicId) ? topicId : null, previous?.id || null, focus, ws.on],
  );
  const askLogId = log.id;
  let plan = null;
  const finish = (f) => query(
    `UPDATE hedwig_ask_log SET status = $2, answer = $3, citations = $4, sources = $5, error = $6, plan = $7, unsupported = $8,
            not_found = $9, model = $10, ai_call_id = $11, prompt_id = $12, prompt_version = $13, completed_at = NOW(),
            web_sources = $14
      WHERE id = $1`,
    [askLogId, f.status, f.answer ?? null, JSON.stringify(f.citations || []), JSON.stringify(f.sources || []), f.error ?? null,
      plan ? JSON.stringify(plan) : null, f.unsupported ?? null, f.notFound ?? null, f.model ?? null, f.aiCallId ?? null,
      f.model ? ANSWER_PROMPT.id : null, f.model ? ANSWER_PROMPT.version : null, f.web?.length ? JSON.stringify(f.web) : null],
  ).catch((err) => console.warn('[hedwig] ask: could not record the answer:', err.message));

  try {
    // The open thread first: everything else is planned around it.
    let threadRows = [];
    if (focus) {
      onEvent({ type: 'thread', status: 'running' });
      threadRows = await loadThreadMessages(userId, focus);
      // Older messages of a thread may have no body yet; the reader's own fetch path fills them in
      // for next time, and the snippet stands in now.
      for (const r of threadRows) if (!r.body_text && !r.body_html) requestBody(r.id, { priority: 2 }).catch(() => {});
      onEvent({ type: 'thread', status: 'done', messages: threadRows.length, subject: bareSubject(threadRows.at(-1)?.subject) });
    }
    const identity = await ownerIdentity(userId);
    const owner = { names: identity.name ? [identity.name] : [], emails: identity.emails };
    const links = ws.on && threadRows.length ? linkCandidates(threadRows) : [];
    const today = isoDay(new Date(now), cfg['insights.timezone']);

    // Progress for the Ask pane: each step as it starts and ends (thread, plan, search, review,
    // web, read, links, dig, then sources, the answer's deltas and done).
    onEvent({ type: 'plan', status: 'running' });
    const [planned, coverage, research] = await Promise.all([
      planQuery(userId, q, { now, cfg, signal }),
      coverageShare(userId).catch(() => null),
      ws.on
        ? planResearch(userId, { question: q, previous, threadRows, links, owner, settings: ws, today, signal })
        : Promise.resolve({ searchMail: true, web: [], links: [], deep: false, via: ws.allowed ? 'unavailable' : 'off' }),
    ]);
    const nothing = nothingRelevant(coverage);
    // A short follow-up ("and the fee?") searches with the earlier question for context; a question
    // about the open thread searches with its subject, so related mail (the last issue, the earlier
    // order) turns up.
    const shortFollowUp = previous && q.split(/\s+/).length < 7;
    const subject = focus ? bareSubject(threadRows.at(-1)?.subject || threadRows[0]?.subject) : '';
    const queryText = shortFollowUp ? `${previous.question} ${planned.text}` : subject ? `${subject} ${planned.text}` : planned.text;
    onEvent({ type: 'plan', status: 'done', text: planned.text, web: { on: ws.on, allowed: ws.allowed, available: ws.available } });

    const searchMail = !focus || research.searchMail !== false;
    const mailTask = (async () => {
      if (!searchMail) return { first: { chunks: [], floor: false, via: 'skipped' }, searched: { chunks: [], searches: [] } };
      onEvent({ type: 'search', text: queryText, round: 0, status: 'running' });
      const first = await gather(userId, planned, { entityId, topicId, cfg, queryText });
      onEvent({ type: 'search', text: queryText, found: messageCount(first.chunks), round: 0, status: 'done' });
      const searched = await searchAgain(userId, q, planned, { text: queryText, chunks: first.chunks }, { previous, entityId, topicId, cfg, signal, onEvent });
      return { first, searched };
    })();
    const wantWeb = ws.on && (research.web.length || research.links.length || deep);
    const webTask = wantWeb
      ? researchWeb({
        userId, question: q, plan: research, links, senderHost: focus ? latestSender(threadRows) : '', owner, settings: ws, deep, signal, onEvent, fetchers,
      })
      : Promise.resolve(null);
    const [{ first, searched }, found] = await Promise.all([mailTask, webTask]);
    const got = { ...first, chunks: searched.chunks };
    plan = {
      ...compactPlan(planned), queryText, retrieval: { via: first.via, chunks: got.chunks.length, floor: first.floor }, searches: searched.searches,
      ...(focus ? { thread: { key: focus, messages: threadRows.length } } : {}),
      research: {
        via: research.via, web: research.web, links: research.links, deep: Boolean(deep || research.deep), searchMail,
        ...(research.error ? { error: research.error } : {}),
        ...(found ? { searches: found.searches, read: found.sources.filter((x) => !x.snippetOnly).length, skipped: found.skipped.length, rounds: found.rounds } : {}),
      },
    };

    const pinned = [...threadRows.map((r) => r.id), ...(previous ? carriedSources(previous, cfg['ask.followUpSources']) : [])];
    const webFound = found?.sources || [];
    if (!got.chunks.length && !pinned.length && !webFound.length) {
      // Nothing above the relevance floor (or nothing at all): answer without a model call.
      onEvent({ type: 'sources', sources: [], web: [], askLogId, plan: compactPlan(planned), coverage });
      onEvent({ type: 'delta', text: nothing });
      onEvent({ type: 'done', answer: nothing, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId, coverage, model: null, lighterModel: false });
      await finish({ status: 'done', answer: nothing, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: nothing, citations: [], sources: [], web: [], unsupported: false, notFound: true, askLogId, plan, coverage, model: null, lighterModel: false };
    }

    const ids = [...new Set([...pinned, ...got.chunks.map((c) => c.messageId)])];
    const rows = await visibleRows(userId, ids);
    const groups = groupByThread(got.chunks, rows, { latest: planned.latest, pinned, focus });
    const evidence = buildEvidence(groups, {
      contextTokens: cfg['ask.contextTokens'], messageChars: cfg['ask.messageChars'], focus, focusChars: cfg['ask.threadChars'],
    });
    const webPart = webEvidence(webFound, { startAt: evidence.sources.length + 1, contextTokens: cfg['ask.web.contextTokens'] });
    plan.retrieval.threads = groups.length;
    plan.retrieval.messages = evidence.sources.length;
    plan.retrieval.evidenceTokens = evidence.tokens;
    plan.retrieval.omitted = evidence.omitted;
    if (found) plan.research.webTokens = webPart.tokens;

    const lite = new Map((await loadMessagesLite(userId, evidence.sources.map((s) => s.messageId), { dedupe: false })).map((m) => [m.id, m]));
    const sources = evidence.sources.map((s) => ({ n: s.n, message: lite.get(s.messageId) || { id: s.messageId } }));
    const sourceIds = evidence.sources.map((s) => s.messageId);
    const webSources = webPart.used.map(publicWebSource);
    onEvent({ type: 'sources', sources, web: webSources, askLogId, plan: compactPlan(planned), coverage });

    if (!sources.length && !webSources.length) {
      onEvent({ type: 'delta', text: nothing });
      onEvent({ type: 'done', answer: nothing, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId, coverage, model: null, lighterModel: false });
      await finish({ status: 'done', answer: nothing, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: nothing, citations: [], sources, web: [], unsupported: false, notFound: true, askLogId, plan, coverage, model: null, lighterModel: false };
    }

    const focusNote = focus ? `The question is about the email thread "${subject || '(no subject)'}", which the user has open.` : '';
    const messages = answerMessages({
      today,
      owner: await ownerLine(userId, identity),
      question: q,
      evidence: evidence.block,
      web: webPart.block,
      thread: Boolean(focus),
      focus: [focusNote, await focusLine(userId, entityId, topicId)].filter(Boolean).join('\n'),
      previous: previous ? { question: previous.question, answer: previous.answer } : null,
    });
    let answer = '';
    let meta = {};
    for await (const ev of chatStream({
      userId, feature: 'ask', role: 'long', lane: 'interactive', messages, signal, maxTokens: cfg['ask.maxAnswerTokens'],
      workflow: ANSWER_PROMPT.id, prompt: ANSWER_PROMPT,
    })) {
      if (ev.type === 'delta') {
        answer += ev.text;
        onEvent({ type: 'delta', text: ev.text });
      } else if (ev.type === 'done') {
        if (typeof ev.content === 'string') answer = ev.content;
        meta = { model: ev.model, aiCallId: ev.aiCallId, fellBack: Boolean(ev.fellBack), lighterModel: ev.lighterModel };
      }
    }
    const checked = checkCitations(answer.trim(), sources.length + webSources.length);
    const lighterModel = ranOnLighterModel(meta, cfg['llm.models.long']);
    plan.answer = { model: meta.model || null, lighterModel };
    onEvent({
      type: 'done', answer: checked.answer, citations: checked.citations, unsupported: checked.unsupported,
      notFound: checked.notFound, invalidCitations: checked.invalid, askLogId, coverage, model: meta.model || null, lighterModel,
    });
    await finish({
      status: 'done', answer: checked.answer, citations: checked.citations, sources: sourceIds, web: webSources,
      unsupported: checked.unsupported, notFound: checked.notFound, model: meta.model, aiCallId: meta.aiCallId,
    });
    return {
      answer: checked.answer, citations: checked.citations, sources, web: webSources, unsupported: checked.unsupported, notFound: checked.notFound,
      askLogId, plan, coverage, model: meta.model || null, lighterModel,
    };
  } catch (err) {
    await finish({ status: signal?.aborted ? 'aborted' : 'error', error: String(err?.message || err).slice(0, 500) });
    throw err;
  }
}
