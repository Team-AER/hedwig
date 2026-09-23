// labels module (v2 stream D): labels without homework and the eval harness.
// Behaviour labels hourly, the judge and Ask triples nightly, gentle questions, eval runs.
// See docs/hedwig/V2-BUILD.md "Labels without homework".
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { defineJob, enqueue, deferJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getState, setState } from '../state.js';
import { behaviourTick, recordDwell } from './behaviour.js';
import { judgeForUser } from './judge.js';
import { askTriplesForUser, answerFeedback } from './askTriples.js';
import { listOpenQuestions, answerQuestionById, skipQuestion, questionFor } from './questions.js';
import { labelStats } from './store.js';
import { EVAL_SUITES, runAndRecord, listRuns } from './eval.js';
import { reasoningTier } from './tier.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[hedwig] labels route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

const handle = (fn) => async (req, res) => {
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled) return res.status(403).json({ error: 'Hedwig intelligence is turned off' });
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const requireUuid = (v, what) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(`${what} must be an id`);
  return v;
};

export const TIER2_RETRY_MS = 30 * 60_000;

/**
 * Nightly: judge, then Ask triples. Both need Tier 2: while it is degraded the job waits (deferred,
 * no attempt spent) for up to labels.judgeDeferHours from when it was queued; after that the judge
 * runs in single mode (Tier 1 only, labels marked singleJudge) and the Ask triples are skipped.
 */
export async function runNightly({ userId, day }, job = {}) {
  if (!userId) return null;
  const cfg = await getConfig(userId);
  const queuedAt = job?.created_at ? new Date(job.created_at).getTime() : Date.now();
  const waitedH = (Date.now() - queuedAt) / 3600_000;
  const mayWait = waitedH < (cfg['labels.judgeDeferHours'] ?? 18);
  const tier = await reasoningTier(userId);
  if (tier.degraded && mayWait) {
    deferJob(`Tier 2 (${tier.model || 'reasoning model'}) is degraded (${tier.reason || 'no answer'}); the judge needs two different models`, TIER2_RETRY_MS);
  }
  const mode = tier.degraded ? 'single' : 'dual';
  const judge = await judgeForUser(userId, { day, mode });
  if (judge.tier2Lost && mayWait) {
    // What it labelled before Tier 2 went away is kept; the rest of the sample runs when it is back.
    deferJob(`Tier 2 stopped answering during the judge run (${judge.judged} judged, ${judge.silver} silver kept)`, TIER2_RETRY_MS);
  }
  const skipAsk = tier.degraded || judge.tier2Lost;
  const ask = skipAsk ? { answerable: 0, unanswerable: 0, rejected: 0, partial: false, skipped: true } : await askTriplesForUser(userId, { day });
  const partial = judge.partial || ask.partial || judge.mode === 'single' || skipAsk;
  const judgeNote = `judge${judge.mode === 'single' ? ' (single, Tier 2 degraded)' : ''} ${judge.judged}/${judge.sampled}, ${judge.silver} silver, ${judge.proposed} questions`;
  const askNote = ask.skipped ? 'ask triples skipped: Tier 2 degraded' : `ask ${ask.answerable}+${ask.unanswerable} (${ask.rejected} rejected)`;
  const note = `${judgeNote}; ${askNote}`;
  return partial ? { status: 'partial', note } : { status: 'done', note };
}

/** Enqueue the nightly job for users whose labels.judgeHour has passed today (server time). */
export async function nightlyTick(now = new Date()) {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  const day = now.toISOString().slice(0, 10);
  for (const { user_id: userId } of rows) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['labels.judgeSample']) continue;
      if (now.getHours() < cfg['labels.judgeHour']) continue;
      const key = `labels.nightly.${userId}`;
      const last = await getState(key, null);
      if (last?.day === day) continue;
      await enqueue('labels.nightly', { userId, day }, { userId, dedupeKey: `labels.nightly:${userId}:${day}`, priority: 7, maxAttempts: 3 });
      await setState(key, { day, at: now.toISOString() });
    } catch (err) {
      console.warn(`[hedwig] labels nightly tick failed for ${userId}:`, err.message);
    }
  }
}

export default {
  name: 'labels',

  routes(r) {
    r.get('/labels/questions', handle(async (req, res) => {
      res.json({ questions: await listOpenQuestions(req.session.userId) });
    }));

    // The open question about one message, for asking it inline there (counts toward the daily limit).
    r.get('/labels/questions/for/:messageId', handle(async (req, res) => {
      res.json({ question: await questionFor(req.session.userId, requireUuid(req.params.messageId, 'message id')) });
    }));

    r.post('/labels/questions/:id/answer', handle(async (req, res) => {
      const id = requireUuid(req.params.id, 'question id');
      const { optionId, always } = req.body || {};
      if (typeof optionId !== 'string' || !optionId) throw bad('optionId is required');
      res.json(await answerQuestionById(req.session.userId, id, { optionId, always }));
    }));

    r.post('/labels/questions/:id/skip', handle(async (req, res) => {
      res.json(await skipQuestion(req.session.userId, requireUuid(req.params.id, 'question id')));
    }));

    r.post('/labels/answer-feedback', handle(async (req, res) => {
      const { askLogId, wrong = true, note = null } = req.body || {};
      res.json(await answerFeedback(req.session.userId, { askLogId: requireUuid(askLogId, 'askLogId'), wrong: wrong !== false, note }));
    }));

    // Optional exact dwell time from the reading pane (ms the message was open and visible).
    r.post('/labels/dwell', handle(async (req, res) => {
      const { messageId, ms } = req.body || {};
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0 || n > 6 * 3600_000) throw bad('ms must be a duration in milliseconds');
      const out = await recordDwell(req.session.userId, requireUuid(messageId, 'messageId'), n);
      if (!out) return res.status(404).json({ error: 'Message not found' });
      res.json(out);
    }));
  },

  adminRoutes(r) {
    r.get('/labels/stats', async (req, res) => {
      try { res.json(await labelStats()); } catch (err) { sendError(res, err); }
    });

    r.get('/eval/runs', async (req, res) => {
      try {
        const suite = typeof req.query.suite === 'string' && EVAL_SUITES.includes(req.query.suite) ? req.query.suite : null;
        res.json({ runs: await listRuns({ suite, limit: req.query.limit }) });
      } catch (err) { sendError(res, err); }
    });

    r.post('/eval/run', async (req, res) => {
      try {
        const { suite, userId = null, prompt = null, promptId = null, model = null, limit = null } = req.body || {};
        if (!EVAL_SUITES.includes(suite)) throw bad(`suite must be one of ${EVAL_SUITES.join(', ')}`);
        if (userId) requireUuid(userId, 'userId');
        const payload = { suite, userId, promptVersion: prompt, promptId, model, limit: Number(limit) || null, notes: `admin ${req.session.userId}` };
        const jobId = await enqueue('labels.eval', payload, { userId, dedupeKey: `labels.eval:${suite}:${userId || 'all'}:${prompt || ''}:${model || ''}`, priority: 6, maxAttempts: 1 });
        res.status(202).json({ ok: true, jobId, deduplicated: jobId === null });
      } catch (err) { sendError(res, err); }
    });

    // Run the nightly labelling for one user now (judge + Ask triples).
    r.post('/labels/run', async (req, res) => {
      try {
        const userId = requireUuid((req.body || {}).userId, 'userId');
        const day = new Date().toISOString().slice(0, 10);
        const jobId = await enqueue('labels.nightly', { userId, day }, { userId, dedupeKey: `labels.nightly:${userId}:${day}:manual`, priority: 5, maxAttempts: 1 });
        res.status(202).json({ ok: true, jobId });
      } catch (err) { sendError(res, err); }
    });
  },

  worker() {
    defineJob('labels.nightly', (payload, job) => runNightly(payload, job), { timeoutMs: 45 * 60_000 });
    defineJob('labels.eval', async (payload) => {
      const out = await runAndRecord(payload.suite, { ...payload, record: true });
      return { status: 'done', note: `run ${out.id}: ${out.accepted ? 'accepted' : 'not accepted'}${out.gates.failures.length ? ` (${out.gates.failures.join('; ')})` : ''}` };
    }, { timeoutMs: 60 * 60_000 });
    defineSchedule({ name: 'labels.behaviour', everySec: 300, run: () => behaviourTick() });
    defineSchedule({ name: 'labels.nightly', everySec: 600, run: () => nightlyTick() });
  },
};
