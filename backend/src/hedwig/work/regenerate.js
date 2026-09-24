// "Regenerate summary": the owner clicks the sparkles in a summary and gets it written again, now.
//   POST /work/thread/:threadId/story/regenerate  → the thread's story, as GET /work/thread has it
//   POST /work/message/:id/tldr/regenerate        → one message's TL;DR, as GET /work/message/:id/tldr has it
// Both run the one summarise path (work/summaries.js) synchronously on the interactive lane and
// replace the stored row only when the new one is in hand: a failed rewrite keeps the old text.
// Stories go to Tier 2 while tierStatus() says the reasoning tier is up, otherwise straight to
// Tier 1 (never a wait on the degraded model); TL;DRs stay on Tier 1. At most six a minute per user.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { tierStatus } from '../llm.js';
import { summariseThreads, summariseMessages, saveStory, tldrFor } from './summaries.js';
import { httpError, threadKeyOf, loadThreadMessages, ownerOf, clampInt } from './util.js';

export const REGENERATE_LIMIT = 6;
export const REGENERATE_WINDOW_MS = 60_000;
export const SLOW_DOWN = 'Slow down: six rewrites a minute';

/**
 * A sliding-window counter per key. `take(key)` records one use and says whether it was allowed;
 * refused uses are not recorded. Pure apart from its own memory.
 */
export function createRateLimiter({ limit = REGENERATE_LIMIT, windowMs = REGENERATE_WINDOW_MS, now = () => Date.now() } = {}) {
  const seen = new Map(); // key → timestamps, oldest first
  return {
    take(key) {
      const t = now();
      const recent = (seen.get(key) || []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) { seen.set(key, recent); return false; }
      recent.push(t);
      seen.set(key, recent);
      return true;
    },
    reset() { seen.clear(); },
  };
}

const limiter = createRateLimiter();

/** Throws 429 when this user has used their rewrites for the minute. */
export function takeRegenerate(userId) {
  if (!limiter.take(String(userId))) throw httpError(429, SLOW_DOWN);
}

/**
 * The tier plan for a rewritten story. Pure. Tier 2 unless the admin pinned work to Tier 1 or Tier 2
 * is degraded; then Tier 1 at once, labelled lighter for a long thread (as the eager path labels it).
 */
export function regeneratePlanFrom({ long = false, pinnedReflex = false, reasoningDegraded = false } = {}) {
  if (pinnedReflex) return { long, escalate: false, lighter: long, degraded: false };
  if (reasoningDegraded) return { long, escalate: false, lighter: long, degraded: true };
  return { long, escalate: true, lighter: false, degraded: false };
}

export async function regeneratePlan(userId, cfg, messageCount) {
  const long = messageCount > clampInt(cfg['work.storyEscalateAbove'], 8, 2, 100);
  const status = await tierStatus(userId).catch(() => null);
  return regeneratePlanFrom({ long, pinnedReflex: cfg['routing.work.tier'] === 'reflex', reasoningDegraded: Boolean(status?.reasoning?.degraded) });
}

const inflight = new Map(); // `${userId}|${threadKey}` or `${userId}|m:${id}` → promise

function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function rewriteStory(userId, threadKey, messages, cfg, owner) {
  const latest = messages[messages.length - 1];
  const [res] = await summariseThreads(userId, [{ threadKey, messages }], { cfg, owner, lane: 'interactive', source: 'regenerate', planFor: regeneratePlan });
  if (!res?.ok || !res.entry?.story) throw httpError(502, 'Could not rewrite the summary');
  // Quick replies belong to the latest message, not to the wording of the story: keep them while it is the same.
  const { rows: [cached] } = await query('SELECT * FROM hedwig_work_stories WHERE user_id = $1 AND thread_key = $2', [userId, threadKey]);
  const same = cached && cached.up_to_message_id === latest.id;
  const entry = {
    ...res.entry,
    quickReplies: same ? cached.story?.quickReplies ?? null : null,
    quickReplyGate: same ? cached.story?.quickReplyGate ?? null : null,
  };
  const prov = { story: res.provenance, quickReplies: same ? cached.provenance?.quickReplies ?? null : null };
  await saveStory(userId, threadKey, messages, entry, prov, { source: 'regenerate', lighter: res.lighter });
  return {
    threadId: threadKey,
    upToMessageId: latest.id,
    story: entry.story,
    storyMeta: entry.storyMeta,
    tldr: entry.tldr || null,
    timeline: entry.timeline || [],
    provenance: prov,
    regenerated: true,
  };
}

/** POST /work/thread/:threadId/story/regenerate. 404 for a thread the user does not have. */
export async function regenerateStory(userId, threadId) {
  const threadKey = threadKeyOf(threadId);
  const cfg = await getConfig(userId);
  const owner = await ownerOf(userId);
  const messages = await loadThreadMessages(userId, threadKey, { addresses: owner.addresses });
  if (!messages.length) throw httpError(404, 'Thread not found');
  if (!cfg['llm.baseUrl']) throw httpError(503, 'No model is set up to write summaries');
  // A second click while the first rewrite runs shares it.
  return once(`${userId}|${threadKey}`, () => rewriteStory(userId, threadKey, messages, cfg, owner));
}

/** POST /work/message/:id/tldr/regenerate. 404 for a message the user does not have. */
export async function regenerateTldr(userId, messageId) {
  const { rows } = await query(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.date, m.body_text, m.body_html, m.snippet, m.attachments
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = $2 AND NOT m.is_deleted`,
    [userId, messageId],
  );
  if (!rows[0]) throw httpError(404, 'Message not found');
  const cfg = await getConfig(userId);
  if (!cfg['llm.baseUrl']) throw httpError(503, 'No model is set up to write summaries');
  return once(`${userId}|m:${messageId}`, async () => {
    // Tier 1, as every TL;DR; the stored line is replaced only by a new one (summaries.js saveTldr).
    const { written } = await summariseMessages(userId, rows, { cfg, lane: 'interactive' });
    const tldr = written ? (await tldrFor(userId, [messageId])).get(messageId) || null : null;
    if (!tldr) throw httpError(502, 'Could not rewrite the TL;DR');
    return { messageId, tldr, computed: true, regenerated: true };
  });
}

/** Test hook. */
export function _resetRegenerate() { limiter.reset(); inflight.clear(); }
