// Summaries written eagerly (AI-rebuild PRD "Summaries", v2 PRD "The story so far"): the thread
// story for every thread of two or more messages with a real person in it, and a one-line TL;DR for
// every People and Screener message, both from the one summarise prompt family (work.summarise).
//
//   mail arrives ──pipeline step (work)──▶ enqueue work.summarise for the user (deduplicated)
//   every work.summariesEverySec ──sweep──▶ enqueue it for users with gaps (the repair pass)
//   work.summarise job ──▶ gaps newest first within pipeline.backfillDays
//        threads: 4 per call on Tier 1; longer than work.storyEscalateAbove → Tier 2, or Tier 1
//                 with lighter = true while Tier 2 is degraded or the call fell back
//        messages: 6 per call on Tier 1
//     ──▶ hedwig_work_stories / hedwig_work_tldr with provenance; hands on to a next job while
//         gaps remain and this run made progress.
//
// Opening a thread with no fresh cached story computes it through summariseThreads too (one item,
// interactive lane), so there is one path and one cache.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { runPrompt } from '../prompts/index.js';
import { activeModels } from '../llm.js';
import { enqueue } from '../jobs.js';
import { senderKind } from '../triage/signals.js';
import { buildStoryVars, assembleStory, assembleTimeline, newTextOf } from './thread.js';
import {
  ownerOf, todayLine, clampInt, shortDate, senderLabel, attachmentNames, loadThreadMessages,
} from './util.js';

export const SUMMARISE_PROMPT = 'work.summarise';
export const SUMMARISE_JOB = 'work.summarise';

const running = new Set(); // userIds with a summarise job in this process

/** A message from a real person (not the owner, not a list, not a notification address). Pure. */
export function isPersonRow(r) {
  if (!r || r.mine || r.is_outgoing || r.own) return false;
  if (r.is_bulk || r.list_unsubscribe) return false;
  return senderKind(r.from_email) === 'person';
}

// The same test in SQL, for gap queries (m = messages, f = folders). $owner is a text[] of the owner's addresses.
const NOT_PERSON_LOCAL = String.raw`^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|receipts?|orders?|order-updates?|shipping|shipment|security|automated|system|bounces?|newsletters?|news|digest|weekly|updates?|marketing|promo(tions?)?|offers?|deals)$`;
const NOT_PERSON_PART = String.raw`(^|[-_.+])(no-?reply|noreply|donotreply|notifications?)($|[-_.+])`;
const JUNK_FOLDER = String.raw`(^|/)(spam|junk|bulk|trash|bin|deleted items|drafts?)$`;
export function personSql(m, f, ownerParam) {
  return `(NOT COALESCE(${m}.is_bulk, false) AND ${m}.list_unsubscribe IS NULL
    AND COALESCE(${f}.special_use, '') NOT IN ('\\Sent', '\\Junk', '\\Trash', '\\Drafts')
    AND ${m}.folder !~* '${JUNK_FOLDER}' AND ${m}.folder !~* '(^|/)sent( items| mail)?$'
    AND NOT (lower(COALESCE(${m}.from_email, '')) = ANY(${ownerParam}::text[]))
    AND split_part(lower(COALESCE(${m}.from_email, '')), '@', 1) !~ '${NOT_PERSON_LOCAL}'
    AND split_part(lower(COALESCE(${m}.from_email, '')), '@', 1) !~ '${NOT_PERSON_PART}')`;
}

/** One line, at most 140 characters, no wrapping quotes. Pure. */
export function cleanTldr(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^["“']+|["”']+$/g, '').trim();
  if (!t) return null;
  return t.length > 140 ? `${t.slice(0, 139).trimEnd()}…` : t;
}

/**
 * How to run a thread's story: long threads escalate to Tier 2 unless it is degraded (then Tier 1,
 * labelled lighter) or the admin pinned work to Tier 1.
 */
export async function tierPlan(userId, cfg, messageCount) {
  const long = messageCount > clampInt(cfg['work.storyEscalateAbove'], 8, 2, 100);
  if (!long) return { long: false, escalate: false, lighter: false, degraded: false };
  if (cfg['routing.work.tier'] === 'reflex') return { long: true, escalate: false, lighter: true, degraded: false };
  const models = await activeModels(userId).catch(() => null);
  if (models?.long?.degraded) return { long: true, escalate: false, lighter: true, degraded: true };
  return { long: true, escalate: true, lighter: false, degraded: false };
}

/** A long thread's result is lighter when Tier 2 did not produce it. Pure. */
export function isLighter(plan, provenance) {
  if (!plan.long) return false;
  if (plan.lighter) return true;
  return provenance?.tier !== 'reasoning' || Boolean(provenance?.fellBack);
}

function provOf(p) {
  if (!p) return null;
  return {
    aiCallId: p.aiCallId ?? null, promptId: p.promptId, promptVersion: p.promptVersion, model: p.model, tier: p.tier,
    fellBack: Boolean(p.fellBack), lighterModel: Boolean(p.lighterModel), escalated: Boolean(p.escalated), tokensIn: p.tokensIn, tokensOut: p.tokensOut,
  };
}

const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const isOutputError = (err) => err?.name === 'PromptOutputError';

// ── Threads ─────────────────────────────────────────────────────────────────

/**
 * Write the story of some threads.
 * @param {string} userId
 * @param {{ threadKey: string, messages: object[] }[]} threads   messages oldest first (loadThreadMessages)
 * @param {{ cfg?, owner?, lane?: 'background'|'interactive', source?: 'eager'|'open', save?: boolean }} [opts]
 *   save: store each story as soon as its call returns (the job); otherwise the caller stores it.
 * @returns {Promise<{ threadKey, ok: boolean, entry?, provenance?, lighter?, error? }[]>}
 *   Throws only on budget / gateway / disabled errors (after saving what was done).
 */
export async function summariseThreads(userId, threads, { cfg = null, owner = null, lane = 'background', source = 'eager', save = false } = {}) {
  const config = cfg || await getConfig(userId);
  const who = owner || await ownerOf(userId);
  const perCall = clampInt(config['work.summariseThreadsPerCall'], 4, 1, 8);
  const max = clampInt(config['work.storyMaxMessages'], 20, 2, 100);
  const chars = clampInt(config['work.storyMessageChars'], 1500, 200, 10000);
  const today = todayLine(config);
  const planned = [];
  for (const t of threads.filter((x) => x.messages?.length)) planned.push({ ...t, plan: await tierPlan(userId, config, t.messages.length) });
  // Escalated threads go in their own calls; long ones two per call so Tier 1 stays under 4k output.
  const groups = [
    ...chunks(planned.filter((t) => !t.plan.long), perCall),
    ...chunks(planned.filter((t) => t.plan.long && t.plan.escalate), Math.max(1, Math.ceil(perCall / 2))),
    ...chunks(planned.filter((t) => t.plan.long && !t.plan.escalate), Math.max(1, Math.ceil(perCall / 2))),
  ];
  const results = [];
  for (const group of groups) {
    const views = group.map((t, i) => {
      const latest = t.messages[t.messages.length - 1];
      const { window, vars } = buildStoryVars({ messages: t.messages, owner: who, subject: latest.subject || t.messages[0].subject || '', today, max, chars, cfg: config });
      return { t, window, item: { id: `t${i + 1}`, kind: 'thread', subject: vars.subject, sinceN: vars.sinceN, count: vars.count, messages: vars.messages } };
    });
    let res;
    try {
      res = await runPrompt(SUMMARISE_PROMPT, { today, user: who, items: views.map((v) => v.item) }, { userId, feature: 'work', lane, escalate: group[0].plan.escalate });
    } catch (err) {
      if (!isOutputError(err)) throw err;
      for (const v of views) {
        await saveStoryFailure(userId, v.t, err.message, source);
        results.push({ threadKey: v.t.threadKey, ok: false, error: err.message });
      }
      continue;
    }
    const byId = new Map((res.data.items || []).map((it) => [it.id, it]));
    for (const v of views) {
      const it = byId.get(v.item.id);
      if (!it) {
        await saveStoryFailure(userId, v.t, 'the model returned no summary for this thread', source);
        results.push({ threadKey: v.t.threadKey, ok: false, error: 'no summary returned' });
        continue;
      }
      const lighter = isLighter(v.t.plan, res.provenance);
      const prov = provOf(res.provenance);
      const entry = {
        story: assembleStory(it, v.window.map((m) => m.id)),
        timeline: assembleTimeline(it.timeline, v.window),
        tldr: cleanTldr(it.tldr),
        storyMeta: { source, tier: prov.tier, model: prov.model, lighter, promptId: prov.promptId, promptVersion: prov.promptVersion, aiCallId: prov.aiCallId, at: new Date().toISOString() },
      };
      if (save) await saveStory(userId, v.t.threadKey, v.t.messages, entry, { story: prov }, { source, lighter });
      results.push({ threadKey: v.t.threadKey, ok: true, entry, provenance: prov, lighter, messages: v.t.messages });
    }
  }
  return results;
}

/**
 * Store a thread's entry (story, timeline, tldr, storyMeta, and quickReplies when known) in the
 * cache, keyed by the thread's latest message. `prov` is { story, quickReplies }.
 */
export async function saveStory(userId, threadKey, messages, entry, prov, { source = 'eager', lighter = false } = {}) {
  const latest = messages[messages.length - 1];
  const s = prov?.story || {};
  await query(
    `INSERT INTO hedwig_work_stories (user_id, thread_key, up_to_message_id, message_count, story, provenance,
                                      prompt_id, prompt_version, model, ai_call_id, tier, lighter, source, error, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, NOW())
     ON CONFLICT (user_id, thread_key) DO UPDATE SET up_to_message_id = EXCLUDED.up_to_message_id, message_count = EXCLUDED.message_count,
       story = EXCLUDED.story, provenance = EXCLUDED.provenance, prompt_id = EXCLUDED.prompt_id, prompt_version = EXCLUDED.prompt_version,
       model = EXCLUDED.model, ai_call_id = EXCLUDED.ai_call_id, tier = EXCLUDED.tier, lighter = EXCLUDED.lighter, source = EXCLUDED.source,
       error = NULL, attempted_at = NOW(), updated_at = NOW()`,
    [userId, threadKey, latest.id, messages.length, JSON.stringify(entry), JSON.stringify(prov || {}),
      s.promptId || null, s.promptVersion || null, s.model || null, s.aiCallId ?? null, s.tier || null, Boolean(lighter), source],
  );
}

/** A failed eager story: remembered against the thread's latest message so the sweep waits before retrying. */
async function saveStoryFailure(userId, t, error, source) {
  const latest = t.messages[t.messages.length - 1];
  await query(
    `INSERT INTO hedwig_work_stories (user_id, thread_key, up_to_message_id, message_count, story, provenance, source, error, attempted_at)
     VALUES ($1, $2, $3, $4, '{"story":null,"timeline":[]}'::jsonb, '{}'::jsonb, $5, $6, NOW())
     ON CONFLICT (user_id, thread_key) DO UPDATE SET up_to_message_id = EXCLUDED.up_to_message_id, message_count = EXCLUDED.message_count,
       error = EXCLUDED.error, attempted_at = NOW(), updated_at = NOW()`,
    [userId, t.threadKey, latest.id, t.messages.length, source, String(error).slice(0, 500)],
  );
}

// ── Messages (TL;DR) ────────────────────────────────────────────────────────

/**
 * Write one-line TL;DRs for some messages (rows with id, subject, from_*, date, body_*, snippet, attachments).
 * @returns {Promise<{ written: number, failed: number }>} Throws only on budget / gateway / disabled errors.
 */
export async function summariseMessages(userId, rows, { cfg = null, owner = null, lane = 'background' } = {}) {
  const config = cfg || await getConfig(userId);
  const who = owner || await ownerOf(userId);
  const chars = clampInt(config['work.tldrChars'], 1500, 200, 10000);
  const today = todayLine(config);
  let written = 0;
  let failed = 0;
  for (const batch of chunks(rows, clampInt(config['work.tldrPerCall'], 6, 1, 10))) {
    const items = batch.map((r, i) => ({
      id: `m${i + 1}`, kind: 'message', subject: r.subject || '',
      messages: [{ n: 1, from: senderLabel(r), mine: false, date: shortDate(r.date, config), attachments: attachmentNames(r), text: newTextOf(r, chars) }],
    }));
    let res;
    try {
      res = await runPrompt(SUMMARISE_PROMPT, { today, user: who, items }, { userId, feature: 'work', lane });
    } catch (err) {
      if (!isOutputError(err)) throw err;
      for (const r of batch) await saveTldr(userId, r.id, null, null, err.message);
      failed += batch.length;
      continue;
    }
    const byId = new Map((res.data.items || []).map((it) => [it.id, it]));
    const prov = provOf(res.provenance);
    for (let i = 0; i < batch.length; i++) {
      const text = cleanTldr(byId.get(`m${i + 1}`)?.tldr);
      if (text) { await saveTldr(userId, batch[i].id, text, prov, null); written++; } else { await saveTldr(userId, batch[i].id, null, prov, 'no TL;DR returned'); failed++; }
    }
  }
  return { written, failed };
}

async function saveTldr(userId, messageId, text, prov, error) {
  // A failed rewrite keeps the old line (and its provenance); only a new line replaces them.
  await query(
    `INSERT INTO hedwig_work_tldr (message_id, user_id, text, prompt_id, prompt_version, model, ai_call_id, tier, lighter, error, attempts)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $10, $9, CASE WHEN $3::text IS NULL THEN 1 ELSE 0 END
      WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1) -- deleted meanwhile: nothing to keep
     ON CONFLICT (message_id) DO UPDATE SET
       text = COALESCE(EXCLUDED.text, hedwig_work_tldr.text),
       prompt_id = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.prompt_id ELSE EXCLUDED.prompt_id END,
       prompt_version = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.prompt_version ELSE EXCLUDED.prompt_version END,
       model = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.model ELSE EXCLUDED.model END,
       ai_call_id = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.ai_call_id ELSE EXCLUDED.ai_call_id END,
       tier = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.tier ELSE EXCLUDED.tier END,
       lighter = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.lighter ELSE EXCLUDED.lighter END,
       error = EXCLUDED.error,
       attempts = CASE WHEN EXCLUDED.text IS NULL THEN hedwig_work_tldr.attempts + 1 ELSE 0 END, updated_at = NOW()`,
    [messageId, userId, text, text ? prov?.promptId || null : null, text ? prov?.promptVersion || null : null, text ? prov?.model || null : null,
      text ? prov?.aiCallId ?? null : null, text ? prov?.tier || null : null, error ? String(error).slice(0, 500) : null,
      text ? Boolean(prov?.lighterModel) : false],
  );
}

/**
 * TL;DRs for these messages (or another copy of the same Message-ID in the same account).
 * @returns {Promise<Map<string, { text, model, tier, lighter, promptId, promptVersion, aiCallId, at }>>}
 */
export async function tldrFor(userId, messageIds) {
  const ids = [...new Set((messageIds || []).filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))];
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (m.id) m.id, x.text, x.model, x.tier, x.lighter, x.prompt_id, x.prompt_version, x.ai_call_id, x.updated_at
       FROM messages m
       JOIN messages mx ON mx.account_id = m.account_id AND (mx.id = m.id OR (m.message_id IS NOT NULL AND mx.message_id = m.message_id))
       JOIN hedwig_work_tldr x ON x.message_id = mx.id AND x.user_id = $1 AND x.text IS NOT NULL
      WHERE m.id = ANY($2::uuid[])
      ORDER BY m.id, (mx.id = m.id) DESC, x.updated_at DESC`,
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.id, {
    text: r.text, model: r.model, tier: r.tier, lighter: Boolean(r.lighter), promptId: r.prompt_id, promptVersion: r.prompt_version,
    aiCallId: r.ai_call_id == null ? null : Number(r.ai_call_id), at: r.updated_at,
  }]));
}

// ── Gaps ────────────────────────────────────────────────────────────────────

const windowDays = (cfg) => Math.max(1, clampInt(cfg['pipeline.backfillDays'], 365, 0, 10000) || 365);

/** Threads of 2+ messages with a real person in them and no story for their current length, newest first. */
export async function storyGaps(userId, cfg, owner, limit) {
  if (limit <= 0) return [];
  const { rows } = await query(
    `WITH t AS (
       SELECT m.thread_key, COUNT(DISTINCT COALESCE(m.message_id, m.id::text))::int AS n, MAX(m.date) AS last,
              BOOL_OR(${personSql('m', 'f', '$4')}) AS person
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND NOT m.is_deleted AND m.thread_key IS NOT NULL
        GROUP BY m.thread_key
       HAVING MAX(m.date) > NOW() - make_interval(days => $2::int))
     SELECT t.thread_key, t.n, t.last FROM t
       LEFT JOIN hedwig_work_stories w ON w.user_id = $1 AND w.thread_key = t.thread_key
      WHERE t.n >= 2 AND t.person
        AND (w.thread_key IS NULL OR w.message_count <> t.n
             OR (w.error IS NOT NULL AND w.attempted_at < NOW() - make_interval(hours => $3::int)))
      ORDER BY t.last DESC NULLS LAST
      LIMIT $5`,
    [userId, windowDays(cfg), clampInt(cfg['work.summariseRetryHours'], 6, 1, 720), owner.addresses, limit],
  );
  return rows.map((r) => r.thread_key);
}

/** People and Screener messages with a body and no TL;DR under the current prompt version, newest first. */
export async function tldrGaps(userId, cfg, limit, { promptVersion }) {
  if (limit <= 0) return [];
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.account_id, COALESCE(m.message_id, m.id::text))
              m.id, m.account_id, m.subject, m.from_name, m.from_email, m.date, m.body_text, m.body_html, m.snippet, m.attachments
         FROM hedwig_sort s
         JOIN messages m ON m.id = s.message_id
         LEFT JOIN hedwig_work_tldr x ON x.message_id = m.id
        WHERE s.user_id = $1 AND s.stream IN ('people', 'screener') AND NOT s.own AND NOT m.is_deleted
          AND m.date > NOW() - make_interval(days => $2::int)
          -- List mail belongs in Reading (sort/headers.js listRule); until the engine re-sort moves
          -- it there, it does not get a TL;DR. The user's own choice to keep a list in People does.
          AND (s.layer = 'user' OR s.rule_id IS NOT NULL OR (m.list_unsubscribe IS NULL AND NOT COALESCE(m.is_bulk, false)))
          AND (COALESCE(m.body_text, '') <> '' OR COALESCE(m.body_html, '') <> '')
          AND (x.message_id IS NULL
               OR ((x.error IS NULL OR x.updated_at < NOW() - make_interval(hours => $3::int))
                   AND (x.text IS NULL OR x.prompt_version IS DISTINCT FROM $4)))
        ORDER BY m.account_id, COALESCE(m.message_id, m.id::text), m.date DESC) g
      ORDER BY date DESC NULLS LAST
      LIMIT $5`,
    [userId, windowDays(cfg), clampInt(cfg['work.summariseRetryHours'], 6, 1, 720), promptVersion, limit],
  );
  return rows;
}

// ── The job, the pipeline trigger, the sweep ────────────────────────────────

async function promptVersion() {
  const { getPrompt } = await import('../prompts/index.js');
  return (await getPrompt(SUMMARISE_PROMPT))?.version || null;
}

/**
 * work.summarise job: fill the user's gaps, newest first, up to the per-job limits; hand on to a
 * next job while gaps remain and this one made progress.
 */
export async function runSummariseJob({ userId } = {}, job = null) {
  if (!userId) return { status: 'done', note: 'no user' };
  if (running.has(userId)) return { status: 'done', note: 'another summarise run is in progress for this user' };
  running.add(userId);
  try {
    const cfg = await getConfig(userId);
    if (!cfg.enabled || cfg['work.enabled'] === false || cfg['work.summariesEager'] === false) return { status: 'done', note: 'eager summaries are off' };
    if (!cfg['llm.baseUrl']) return { status: 'done', note: 'no model gateway configured' };
    const owner = await ownerOf(userId);
    const maxThreads = clampInt(cfg['work.summariseThreadsPerJob'], 12, 0, 200);
    const maxMessages = clampInt(cfg['work.summariseMessagesPerJob'], 36, 0, 500);
    const version = await promptVersion();

    const keys = await storyGaps(userId, cfg, owner, maxThreads + 1);
    const threads = [];
    for (const threadKey of keys.slice(0, maxThreads)) {
      const messages = await loadThreadMessages(userId, threadKey, { addresses: owner.addresses });
      if (messages.length >= 2) threads.push({ threadKey, messages });
    }
    let stories = 0;
    let storyFailed = 0;
    let lighter = 0;
    const results = threads.length ? await summariseThreads(userId, threads, { cfg, owner, lane: 'background', source: 'eager', save: true }) : [];
    for (const r of results) {
      if (!r.ok) { storyFailed++; continue; }
      stories++;
      if (r.lighter) lighter++;
    }

    const msgs = await tldrGaps(userId, cfg, maxMessages + 1, { promptVersion: version });
    const { written, failed } = msgs.length ? await summariseMessages(userId, msgs.slice(0, maxMessages), { cfg, owner }) : { written: 0, failed: 0 };

    const more = keys.length > maxThreads || msgs.length > maxMessages;
    if (more && stories + written > 0) {
      await enqueue(SUMMARISE_JOB, { userId }, { userId, dedupeKey: `work.summarise:${userId}:after:${job?.id ?? Date.now()}`, runAt: new Date(Date.now() + 10_000), priority: 7, maxAttempts: 3 });
    }
    const note = `${stories} stories (${lighter} lighter), ${storyFailed} failed; ${written} TL;DRs, ${failed} failed${more ? '; more queued' : ''}`;
    return storyFailed || failed ? { status: 'partial', note } : { status: 'done', note };
  } finally {
    running.delete(userId);
  }
}

/**
 * Pipeline step: new mail from a person, or a reply in a thread, queues the user's summarise job
 * (one pending job per user; it picks up everything that is missing).
 */
export async function enqueueForRows(rows, { delayMs = 30_000 } = {}) {
  const users = new Set();
  for (const r of rows) {
    if (!r.user_id || r.is_outgoing) continue;
    if (isPersonRow(r) || r.in_reply_to) users.add(r.user_id);
  }
  let queued = 0;
  for (const userId of users) {
    const cfg = await getConfig(userId);
    if (!cfg.enabled || cfg['work.enabled'] === false || cfg['work.summariesEager'] === false || !cfg['llm.baseUrl']) continue;
    const id = await enqueue(SUMMARISE_JOB, { userId }, { userId, dedupeKey: `work.summarise:${userId}`, runAt: new Date(Date.now() + delayMs), priority: 6, maxAttempts: 3 });
    if (id) queued++;
  }
  return queued;
}

/** The half-hourly repair pass: queue the job for every user who has a gap. */
export async function sweepSummaries() {
  const { rows: users } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  const version = await promptVersion();
  let queued = 0;
  for (const { user_id: userId } of users) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || cfg['work.enabled'] === false || cfg['work.summariesEager'] === false || !cfg['llm.baseUrl']) continue;
      const owner = await ownerOf(userId);
      const gaps = (await storyGaps(userId, cfg, owner, 1)).length + (await tldrGaps(userId, cfg, 1, { promptVersion: version })).length;
      if (!gaps) continue;
      if (await enqueue(SUMMARISE_JOB, { userId }, { userId, dedupeKey: `work.summarise:${userId}`, priority: 7, maxAttempts: 3 })) queued++;
    } catch (err) {
      console.warn(`[hedwig] work: summaries sweep failed for ${userId}:`, err.message);
    }
  }
  return queued;
}

/** Coverage for GET /work/summaries/status (and the audit). */
export async function summaryStatus(userId) {
  const cfg = await getConfig(userId);
  const owner = await ownerOf(userId);
  const version = await promptVersion();
  const [{ rows: [s] }, { rows: [t] }, threadGaps, msgGaps] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE error IS NULL)::int AS stories, COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
                  COUNT(*) FILTER (WHERE lighter)::int AS lighter, MAX(updated_at) AS last FROM hedwig_work_stories WHERE user_id = $1`, [userId]),
    query(`SELECT COUNT(*) FILTER (WHERE text IS NOT NULL)::int AS tldrs, COUNT(*) FILTER (WHERE text IS NULL)::int AS failed, MAX(updated_at) AS last
             FROM hedwig_work_tldr WHERE user_id = $1`, [userId]),
    storyGaps(userId, cfg, owner, 500),
    tldrGaps(userId, cfg, 2000, { promptVersion: version }),
  ]);
  return {
    eager: cfg['work.summariesEager'] !== false,
    stories: { ...s, missing: threadGaps.length },
    tldrs: { ...t, missing: msgGaps.length },
    promptVersion: version,
  };
}

export function _resetSummaries() { running.clear(); }

/**
 * GET /work/message/:id/tldr — one message's TL;DR; with compute, written now on the interactive
 * lane when there is none yet (the top of a message opened before the job reached it).
 * @returns {{ messageId, tldr: { text, lighter, model, tier, promptId, promptVersion, aiCallId, at } | null, computed: boolean }}
 */
export async function messageTldr(userId, messageId, { compute = false } = {}) {
  const have = (await tldrFor(userId, [messageId])).get(messageId) || null;
  if (have || !compute) return { messageId, tldr: have, computed: false };
  const { rows } = await query(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.date, m.body_text, m.body_html, m.snippet, m.attachments
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = $2 AND NOT m.is_deleted`,
    [userId, messageId],
  );
  if (!rows[0]) { const err = new Error('Message not found'); err.status = 404; throw err; }
  const cfg = await getConfig(userId);
  if (!cfg['llm.baseUrl']) return { messageId, tldr: null, computed: false };
  await summariseMessages(userId, rows, { cfg, lane: 'interactive' });
  return { messageId, tldr: (await tldrFor(userId, [messageId])).get(messageId) || null, computed: true };
}
