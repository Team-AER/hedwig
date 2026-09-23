// Ask on the v2 index: plan → retrieve (A's retrieve(), threads expanded) → relevance floor →
// evidence grouped by thread → streamed answer on the reasoning tier → citation check → log.
// Events (unchanged for the frontend, fields only added):
//   { type: 'sources', sources: [{ n, message: MessageLite }], askLogId, plan }
//   { type: 'delta', text }…
//   { type: 'done', answer, citations: [n], unsupported, notFound, invalidCitations: [n], askLogId }
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { chatStream } from '../llm.js';
import { retrieve } from '../indexer/retrieve.js';
import { loadMessagesLite } from '../context/shapes.js';
import { ownsEntity, ownsTopic } from '../context/cards.js';
import { httpError, isoDay, isUuid } from '../context/util.js';
import { planQuery } from './plan.js';
import { groupByThread, buildEvidence } from './evidence.js';
import { checkCitations } from './citations.js';
import { ANSWER_PROMPT, answerMessages, ownerLine } from './prompt.js';

export const NOTHING_RELEVANT = "I couldn't find anything relevant in your mail about that.";

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

async function previousAnswer(userId, id) {
  const { rows } = await query(
    'SELECT id, question, answer, sources, status FROM hedwig_ask_log WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!rows[0]) throw httpError(404, 'Earlier answer not found');
  return rows[0];
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
    const planned = await planQuery(userId, q, { now, cfg, signal });
    // A short follow-up ("and the fee?") searches with the earlier question for context.
    const shortFollowUp = previous && q.split(/\s+/).length < 7;
    const queryText = shortFollowUp ? `${previous.question} ${planned.text}` : planned.text;
    const got = await gather(userId, planned, { entityId, topicId, cfg, queryText });
    plan = { ...compactPlan(planned), queryText, retrieval: { via: got.via, chunks: got.chunks.length, floor: got.floor } };

    const pinned = previous ? (Array.isArray(previous.sources) ? previous.sources : []).filter(isUuid).slice(0, cfg['ask.followUpSources']) : [];
    if (!got.chunks.length && !pinned.length) {
      // Nothing above the relevance floor (or nothing at all): answer without a model call.
      onEvent({ type: 'sources', sources: [], askLogId, plan: compactPlan(planned) });
      onEvent({ type: 'delta', text: NOTHING_RELEVANT });
      onEvent({ type: 'done', answer: NOTHING_RELEVANT, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId });
      await finish({ status: 'done', answer: NOTHING_RELEVANT, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: NOTHING_RELEVANT, citations: [], sources: [], unsupported: false, notFound: true, askLogId, plan };
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
    onEvent({ type: 'sources', sources, askLogId, plan: compactPlan(planned) });

    if (!sources.length) {
      onEvent({ type: 'delta', text: NOTHING_RELEVANT });
      onEvent({ type: 'done', answer: NOTHING_RELEVANT, citations: [], unsupported: false, notFound: true, invalidCitations: [], askLogId });
      await finish({ status: 'done', answer: NOTHING_RELEVANT, citations: [], sources: [], unsupported: false, notFound: true });
      return { answer: NOTHING_RELEVANT, citations: [], sources, unsupported: false, notFound: true, askLogId, plan };
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
        meta = { model: ev.model, aiCallId: ev.aiCallId };
      }
    }
    const checked = checkCitations(answer.trim(), sources.length);
    onEvent({
      type: 'done', answer: checked.answer, citations: checked.citations, unsupported: checked.unsupported,
      notFound: checked.notFound, invalidCitations: checked.invalid, askLogId,
    });
    await finish({
      status: 'done', answer: checked.answer, citations: checked.citations, sources: sourceIds,
      unsupported: checked.unsupported, notFound: checked.notFound, model: meta.model, aiCallId: meta.aiCallId,
    });
    return { answer: checked.answer, citations: checked.citations, sources, unsupported: checked.unsupported, notFound: checked.notFound, askLogId, plan };
  } catch (err) {
    await finish({ status: signal?.aborted ? 'aborted' : 'error', error: String(err?.message || err).slice(0, 500) });
    throw err;
  }
}
