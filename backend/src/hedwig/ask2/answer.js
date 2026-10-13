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
import { ANSWER_PROMPT, answerMessages, ownerLine } from './prompt.js';
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
    'SELECT id, question, answer, sources, citations, status FROM hedwig_ask_log WHERE id = $1 AND user_id = $2',
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
    let data;
    try {
      ({ data } = await runPrompt('ask.refine', {
        question, previous: previous ? `${previous.question}${previous.answer ? ` (answered: ${String(previous.answer).replace(/\s+/g, ' ').slice(0, 300)})` : ''}` : '',
        searches: runs.map((r) => r.text), found, count: lite.length,
      }, { userId, feature: 'ask', lane: 'interactive', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
    } catch (err) {
      if (signal?.aborted) throw err;
      break;
    }
    const next = [];
    for (const raw of Array.isArray(data?.searches) ? data.searches : []) {
      const text = searchWords(raw);
      if (text.length >= 2 && ![...runs.map((r) => r.text), ...next].some((t) => sameSearch(t, text))) next.push(text);
    }
    if (data?.enough === true || !next.length) break;
    const results = await Promise.all(next.slice(0, 3).map((text) => gather(userId, { ...planned, text }, { entityId, topicId, cfg, queryText: text })));
    let fresh = 0;
    next.slice(0, 3).forEach((text, i) => {
      const chunks = results[i].chunks;
      const added = new Set(chunks.map((c) => c.messageId).filter((id) => !seen.has(id)));
      for (const id of added) seen.add(id);
      fresh += added.size;
      runs.push({ text, chunks });
      searches.push({ text, found: added.size });
      onEvent({ type: 'search', text, found: added.size, round });
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

/**
 * Answer a question from the user's mail, streaming events through onEvent.
 * @returns {Promise<{ answer, citations, sources: {n, message}[], unsupported, notFound, askLogId, plan }>}
 */
export async function answerQuestion(userId, question, { entityId = null, topicId = null, followUpOf = null, onEvent = () => {}, signal, now = new Date() } = {}) {
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw httpError(400, 'question is required');
  if (q.length > 2000) throw httpError(400, 'question too long');
  if (entityId != null && !(await ownsEntity(userId, entityId))) throw httpError(404, 'Entity not found');
  if (topicId != null && !(await ownsTopic(userId, topicId))) throw httpError(404, 'Topic not found');
  if (followUpOf != null && !isUuid(followUpOf)) throw httpError(400, 'invalid followUpOf');
  const cfg = await getConfig(userId);
  const previous = followUpOf ? await previousAnswer(userId, followUpOf) : null;

  const { rows: [log] } = await query(
    'INSERT INTO hedwig_ask_log (user_id, question, entity_id, topic_id, follow_up_of) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, q, isUuid(entityId) ? entityId : null, isUuid(topicId) ? topicId : null, previous?.id || null],
  );
  const askLogId = log.id;
  let plan = null;
  const finish = (f) => query(
    `UPDATE hedwig_ask_log SET status = $2, answer = $3, citations = $4, sources = $5, error = $6, plan = $7, unsupported = $8,
            not_found = $9, model = $10, ai_call_id = $11, prompt_id = $12, prompt_version = $13, completed_at = NOW()
      WHERE id = $1`,
    [askLogId, f.status, f.answer ?? null, JSON.stringify(f.citations || []), JSON.stringify(f.sources || []), f.error ?? null,
      plan ? JSON.stringify(plan) : null, f.unsupported ?? null, f.notFound ?? null, f.model ?? null, f.aiCallId ?? null,
      f.model ? ANSWER_PROMPT.id : null, f.model ? ANSWER_PROMPT.version : null],
  ).catch((err) => console.warn('[hedwig] ask: could not record the answer:', err.message));

  try {
    const [planned, coverage] = await Promise.all([
      planQuery(userId, q, { now, cfg, signal }),
      coverageShare(userId).catch(() => null),
    ]);
    const nothing = nothingRelevant(coverage);
    // A short follow-up ("and the fee?") searches with the earlier question for context.
    const shortFollowUp = previous && q.split(/\s+/).length < 7;
    const queryText = shortFollowUp ? `${previous.question} ${planned.text}` : planned.text;
    const first = await gather(userId, planned, { entityId, topicId, cfg, queryText });
    onEvent({ type: 'search', text: queryText, found: messageCount(first.chunks), round: 0 });
    const searched = await searchAgain(userId, q, planned, { text: queryText, chunks: first.chunks }, { previous, entityId, topicId, cfg, signal, onEvent });
    const got = { ...first, chunks: searched.chunks };
    plan = { ...compactPlan(planned), queryText, retrieval: { via: first.via, chunks: got.chunks.length, floor: first.floor }, searches: searched.searches };

    const pinned = previous ? carriedSources(previous, cfg['ask.followUpSources']) : [];
    if (!got.chunks.length && !pinned.length) {
      // Nothing above the relevance floor (or nothing at all): answer without a model call.
      onEvent({ type: 'sources', sources: [], askLogId, plan: compactPlan(planned), coverage });
      onEvent({ type: 'delta', text: nothing });
      onEvent({ type: 'done', answer: nothing, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId, coverage, model: null, lighterModel: false });
      await finish({ status: 'done', answer: nothing, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: nothing, citations: [], sources: [], unsupported: false, notFound: true, askLogId, plan, coverage, model: null, lighterModel: false };
    }

    const ids = [...new Set([...pinned, ...got.chunks.map((c) => c.messageId)])];
    const rows = await visibleRows(userId, ids);
    const groups = groupByThread(got.chunks, rows, { latest: planned.latest, pinned });
    const evidence = buildEvidence(groups, { contextTokens: cfg['ask.contextTokens'], messageChars: cfg['ask.messageChars'] });
    plan.retrieval.threads = groups.length;
    plan.retrieval.messages = evidence.sources.length;
    plan.retrieval.evidenceTokens = evidence.tokens;
    plan.retrieval.omitted = evidence.omitted;

    const lite = new Map((await loadMessagesLite(userId, evidence.sources.map((s) => s.messageId), { dedupe: false })).map((m) => [m.id, m]));
    const sources = evidence.sources.map((s) => ({ n: s.n, message: lite.get(s.messageId) || { id: s.messageId } }));
    const sourceIds = evidence.sources.map((s) => s.messageId);
    onEvent({ type: 'sources', sources, askLogId, plan: compactPlan(planned), coverage });

    if (!sources.length) {
      onEvent({ type: 'delta', text: nothing });
      onEvent({ type: 'done', answer: nothing, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId, coverage, model: null, lighterModel: false });
      await finish({ status: 'done', answer: nothing, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: nothing, citations: [], sources, unsupported: false, notFound: true, askLogId, plan, coverage, model: null, lighterModel: false };
    }

    const messages = answerMessages({
      today: isoDay(new Date(now), cfg['insights.timezone']),
      owner: await ownerLine(userId),
      question: q,
      evidence: evidence.block,
      focus: await focusLine(userId, entityId, topicId),
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
    const checked = checkCitations(answer.trim(), sources.length);
    const lighterModel = ranOnLighterModel(meta, cfg['llm.models.long']);
    plan.answer = { model: meta.model || null, lighterModel };
    onEvent({
      type: 'done', answer: checked.answer, citations: checked.citations, unsupported: checked.unsupported,
      notFound: checked.notFound, invalidCitations: checked.invalid, askLogId, coverage, model: meta.model || null, lighterModel,
    });
    await finish({
      status: 'done', answer: checked.answer, citations: checked.citations, sources: sourceIds,
      unsupported: checked.unsupported, notFound: checked.notFound, model: meta.model, aiCallId: meta.aiCallId,
    });
    return {
      answer: checked.answer, citations: checked.citations, sources, unsupported: checked.unsupported, notFound: checked.notFound,
      askLogId, plan, coverage, model: meta.model || null, lighterModel,
    };
  } catch (err) {
    await finish({ status: signal?.aborted ? 'aborted' : 'error', error: String(err?.message || err).slice(0, 500) });
    throw err;
  }
}
