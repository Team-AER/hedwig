// Ask eval triples (question, answer, source message ids), built from the user's real threads:
// ask.generate writes questions whose answers the thread states, ask.verify checks each answer is
// really in its sources (with a quote that must occur verbatim), and unanswerable questions are
// generated about things the mailbox does not contain (their key terms must match no message).
// User "wrong answer" marks on Ask join the set as gold.
import { createHash } from 'crypto';
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { messageText } from '../text.js';
import { userAddresses } from '../triage/store.js';
import { runPrompt, recordCorrection } from './runtime.js';
import { upsertLabels } from './store.js';
import { ownerLine } from './judge.js';

export const askTarget = (question) => `ask:${createHash('sha1').update(String(question).trim().toLowerCase()).digest('hex').slice(0, 16)}`;

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Does the verifier's quote occur (whitespace- and case-insensitively) in one of the sources? Pure. */
export function quoteInSources(quote, texts) {
  const q = norm(quote);
  if (q.length < 3) return false;
  return texts.some((t) => norm(t).includes(q));
}

/** Map the prompt's short source ids back to message ids, dropping any it made up. Pure. */
export function mapSourceIds(ids, byShort) {
  return [...new Set((ids || []).map((s) => byShort.get(String(s).trim())).filter(Boolean))];
}

async function pickThreads(userId, n, seed) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT m.account_id, m.thread_key
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE NOT m.is_deleted AND m.date > NOW() - INTERVAL '180 days' AND m.thread_key IS NOT NULL
          AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL)
          AND COALESCE(f.special_use, '') NOT IN ('\\Junk', '\\Trash', '\\Drafts')
          AND m.folder !~* '(^|[/.])(spam|junk|trash|bin|deleted items|drafts)$'),
     threads AS (SELECT account_id, thread_key, COUNT(*)::int AS n FROM mine GROUP BY 1, 2 HAVING COUNT(*) <= 8)
     SELECT account_id, thread_key FROM threads t
      WHERE NOT EXISTS (SELECT 1 FROM hedwig_labels l WHERE l.user_id = $1 AND l.suite = 'ask' AND l.evidence->>'threadKey' = t.thread_key)
      ORDER BY md5(t.thread_key || $3) LIMIT $2`,
    [userId, n, String(seed)],
  );
  if (!rows.length) return [];
  const { rows: msgs } = await query(
    `SELECT DISTINCT ON (m.account_id, m.thread_key, COALESCE(m.message_id, m.id::text))
            m.id, m.account_id, m.thread_key, m.date, m.from_name, lower(m.from_email) AS from_email, m.subject, m.body_text, m.body_html, m.snippet
       FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE NOT m.is_deleted AND (m.account_id, m.thread_key) IN (SELECT * FROM UNNEST($2::uuid[], $3::text[]))
      ORDER BY m.account_id, m.thread_key, COALESCE(m.message_id, m.id::text), m.date`,
    [userId, rows.map((r) => r.account_id), rows.map((r) => r.thread_key)],
  );
  const byThread = new Map();
  for (const m of msgs) {
    const key = `${m.account_id}|${m.thread_key}`;
    if (!byThread.has(key)) byThread.set(key, { threadKey: m.thread_key, messages: [] });
    byThread.get(key).messages.push(m);
  }
  for (const t of byThread.values()) t.messages.sort((a, b) => new Date(a.date) - new Date(b.date));
  return [...byThread.values()];
}

function threadForPrompt(thread) {
  const byShort = new Map();
  const texts = new Map();
  const view = thread.messages.map((m, i) => {
    const id = `s${i + 1}`;
    byShort.set(id, m.id);
    const text = messageText(m, { maxChars: 2000 });
    texts.set(m.id, text);
    return { id, from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email, date: m.date ? new Date(m.date).toISOString().slice(0, 10) : '', subject: m.subject, text };
  });
  return { view, byShort, texts };
}

async function termHits(userId, term) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE NOT m.is_deleted AND (m.search_vector @@ plainto_tsquery('english', $2) OR m.subject ILIKE '%' || $2 || '%' OR m.from_name ILIKE '%' || $2 || '%')`,
    [userId, term],
  );
  return rows[0]?.n ?? 0;
}

/** Verify an answer against its thread: the verifier says supported, and its quote is real. */
export async function verifyAnswer(userId, { question, answer, sources }) {
  const { data } = await runPrompt('ask.verify', { question, answer, sources }, { userId, feature: 'labels', lane: 'background' });
  const quoteOk = quoteInSources(data?.quote, sources.map((s) => s.text));
  return { supported: Boolean(data?.supported) && quoteOk, answerable: Boolean(data?.answerable), quote: data?.quote || '', quoteOk, reason: data?.reason || '' };
}

/**
 * Generate and verify triples for one user. Half the budget answerable, the rest unanswerable.
 * @returns {{ threads, answerable, unanswerable, rejected, partial }}
 */
export async function askTriplesForUser(userId, { day = new Date().toISOString().slice(0, 10) } = {}) {
  const cfg = await getConfig(userId);
  const want = cfg['labels.askTriplesPerNight'];
  const stats = { threads: 0, answerable: 0, unanswerable: 0, rejected: 0, partial: false };
  if (!cfg.enabled || !want) return stats;
  const addresses = (await userAddresses([userId])).get(userId) || new Set();
  const owner = await ownerLine(userId, addresses);
  const threads = await pickThreads(userId, Math.max(1, Math.ceil(want / 2)), `${userId}:${day}`);
  stats.threads = threads.length;
  const labels = [];
  const wantUnanswerable = Math.floor(want / 3);
  try {
    for (const [i, thread] of threads.entries()) {
      const { view, byShort, texts } = threadForPrompt(thread);
      const gen = await runPrompt('ask.generate', { mode: 'answerable', n: 2, owner, thread: view }, { userId, feature: 'labels', lane: 'background' });
      for (const it of gen.data?.items || []) {
        if (!it.answer || stats.answerable >= want - wantUnanswerable) continue;
        const sourceIds = mapSourceIds(it.sourceIds, byShort);
        if (!sourceIds.length) { stats.rejected++; continue; }
        const sources = thread.messages.map((m, k) => ({ id: view[k].id, text: texts.get(m.id) }));
        const v = await verifyAnswer(userId, { question: it.question, answer: it.answer, sources });
        if (!v.supported || !v.answerable) { stats.rejected++; continue; }
        stats.answerable++;
        labels.push({
          suite: 'ask', targetId: askTarget(it.question), grade: 'silver', source: 'generated',
          label: { question: it.question, answer: it.answer, sourceIds, answerable: true },
          evidence: { rule: 'generated', threadKey: thread.threadKey, quote: v.quote, verify: v.reason, promptVersion: gen.provenance?.promptVersion || null, model: gen.provenance?.model || null, day },
        });
      }
      if (i % 2 === 0 && stats.unanswerable < wantUnanswerable) {
        const un = await runPrompt('ask.generate', { mode: 'unanswerable', n: 1, owner, thread: view }, { userId, feature: 'labels', lane: 'background' });
        for (const it of un.data?.items || []) {
          if (!Array.isArray(it.absentTerms) || !it.absentTerms.length) continue;
          const hits = {};
          for (const term of it.absentTerms.slice(0, 3)) hits[term] = await termHits(userId, term);
          if (!Object.values(hits).some((n) => n === 0)) { stats.rejected++; continue; }
          stats.unanswerable++;
          labels.push({
            suite: 'ask', targetId: askTarget(it.question), grade: 'silver', source: 'generated',
            label: { question: it.question, answerable: false, sourceIds: [] },
            evidence: { rule: 'unanswerable', threadKey: thread.threadKey, absentTerms: hits, promptVersion: un.provenance?.promptVersion || null, day },
          });
        }
      }
    }
  } catch (err) {
    if (!['budget_exceeded', 'llm_disabled'].includes(err.code)) throw err;
    stats.partial = true;
  }
  await upsertLabels(userId, labels);
  return stats;
}

/** A user marked an Ask answer wrong: a gold "this answer is wrong" item and a correction. */
export async function answerFeedback(userId, { askLogId, wrong = true, note = null } = {}) {
  const { rows } = await query(
    'SELECT id, question, answer, sources, citations FROM hedwig_ask_log WHERE id = $1 AND user_id = $2',
    [askLogId, userId],
  );
  const log = rows[0];
  if (!log) throw Object.assign(new Error('Answer not found'), { status: 404 });
  const cleanNote = note == null ? null : String(note).slice(0, 1000);
  await upsertLabels(userId, [{
    suite: 'ask', targetId: `asklog:${log.id}`, grade: 'gold', source: 'correction',
    label: { question: log.question, answer: log.answer, wrong: Boolean(wrong), sourceIds: Array.isArray(log.sources) ? log.sources : [], note: cleanNote },
    evidence: { rule: 'answer_feedback', askLogId: log.id, at: new Date().toISOString() },
  }]);
  await recordCorrection({
    userId, kind: 'answer', targetId: log.id, before: { answer: log.answer }, after: { wrong: Boolean(wrong) }, note: cleanNote,
    promptId: null, promptVersion: null,
  });
  return { ok: true };
}
