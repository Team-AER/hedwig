// The memory profile: versions, user edits (pinned lines), the weekly rebuild and its schedule.
// Every function takes the user id first and touches only that user's rows.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue, deferJob } from '../jobs.js';
import { reasoningTier, ranOnLighterModel } from '../labels/tier.js';
import { getState, setState } from '../state.js';
import { runPrompt } from '../prompts/index.js';
import { gatherEvidence } from './evidence.js';
import { unifiedDiff } from './diff.js';
import { applyUserEdit, composeLines, linesToText, parseLines, validateLines } from './lines.js';

export const PROFILE_PROMPT = 'profile.rebuild';
const SOFT_ERRORS = new Set(['llm_disabled', 'budget_exceeded']);

const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);

function toVersion(row) {
  if (!row) return null;
  return {
    version: row.version,
    text: row.text,
    lines: asArray(row.lines),
    pinned: asArray(row.pinned),
    dismissed: asArray(row.dismissed),
    diff: row.diff || '',
    source: row.source,
    provenance: row.provenance || null,
    // Built on the lighter model while Tier 2 was degraded; rebuilt when Tier 2 is back.
    provisional: Boolean(row.provenance?.provisional),
    updatedAt: row.created_at,
  };
}

export async function latestVersion(userId) {
  const { rows } = await query('SELECT * FROM hedwig_profile WHERE user_id = $1 ORDER BY version DESC LIMIT 1', [userId]);
  return toVersion(rows[0]);
}

/** GET /profile. A user with no profile yet gets version 0 and empty text. */
export async function getProfile(userId) {
  const cur = await latestVersion(userId);
  if (!cur) return { version: 0, text: '', lines: [], pinned: [], dismissed: [], diff: '', source: null, provenance: null, provisional: false, updatedAt: null };
  return cur;
}

/** GET /profile/history: newest first. */
export async function profileHistory(userId, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  const { rows } = await query(
    `SELECT version, source, diff, created_at, jsonb_array_length(pinned)::int AS pinned,
            array_length(regexp_split_to_array(NULLIF(text, ''), E'\\n'), 1) AS lines,
            provenance->>'model' AS model, provenance->>'promptVersion' AS prompt_version
       FROM hedwig_profile WHERE user_id = $1 ORDER BY version DESC LIMIT $2`,
    [userId, n],
  );
  return {
    versions: rows.map((r) => ({
      version: r.version, source: r.source, diff: r.diff || '', createdAt: r.created_at,
      lines: Number(r.lines) || 0, pinned: Number(r.pinned) || 0, model: r.model || null, promptVersion: r.prompt_version || null,
    })),
  };
}

/** Insert the next version for a user (retries once if another writer took the number). */
async function insertVersion(userId, v) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { rows } = await query(
        `INSERT INTO hedwig_profile (user_id, version, text, pinned, dismissed, lines, evidence, diff, source, provenance)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9 FROM hedwig_profile WHERE user_id = $1
         RETURNING *`,
        [userId, v.text, JSON.stringify(v.pinned), JSON.stringify(v.dismissed), JSON.stringify(v.lines), JSON.stringify(v.evidence || []),
          v.diff, v.source, v.provenance ? JSON.stringify(v.provenance) : null],
      );
      return toVersion(rows[0]);
    } catch (err) {
      if (err?.code !== '23505' || attempt > 0) throw err;
    }
  }
}

/** PUT /profile { text }: the user's edit becomes a version; their own lines are pinned. */
export async function saveProfileEdit(userId, { text } = {}) {
  if (typeof text !== 'string') throw Object.assign(new Error('text is required'), { status: 400 });
  if (text.length > 20000) throw Object.assign(new Error('text is too long'), { status: 400 });
  const cfg = await getConfig(userId);
  const prev = await latestVersion(userId);
  const edit = applyUserEdit(prev, text, { max: cfg['profile.maxLines'] });
  const newText = linesToText(edit.lines);
  if (prev && newText === prev.text && JSON.stringify(edit.pinned) === JSON.stringify(prev.pinned)) return { ...prev, unchanged: true };
  return insertVersion(userId, {
    text: newText,
    lines: edit.lines,
    pinned: edit.pinned,
    dismissed: edit.dismissed,
    evidence: [],
    diff: unifiedDiff(prev?.text || '', newText, { from: `v${prev?.version || 0}`, to: `v${(prev?.version || 0) + 1} (you)` }),
    source: 'user',
    provenance: null,
  });
}

/**
 * Rebuild from behaviour: facts by SQL, profile.rebuild on the reasoning tier, lines checked
 * against the facts, pinned lines kept verbatim. No new version when nothing changed.
 * @returns {Promise<{ status: 'done'|'skipped', version?: number, note: string, dropped?: object[] }>}
 */
/** Too few facts in the usual window: learn from the longer one. */
export const MIN_FACTS = 3;

export async function rebuildProfile(userId, { fetchFn, lane = 'background', allowLighter = true } = {}) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['profile.enabled']) return { status: 'skipped', note: 'profile is off' };
  const prev = await latestVersion(userId);
  const pinned = prev?.pinned || [];
  const dismissed = prev?.dismissed || [];
  const max = cfg['profile.maxLines'];
  let evidence = await gatherEvidence(userId, cfg);
  const longer = cfg['profile.fallbackDays'];
  if (evidence.facts.length < MIN_FACTS && longer > (evidence.days || cfg['profile.windowDays'])) {
    // A newly connected account, or a quiet quarter: the facts say which window they cover.
    const wide = await gatherEvidence(userId, cfg, { days: longer });
    if (wide.facts.length > evidence.facts.length) evidence = wide;
  }
  const { facts, excerpts } = evidence;
  const days = evidence.days || cfg['profile.windowDays'];
  if (!facts.length && !prev) return { status: 'skipped', note: 'no evidence yet' };
  let generated = [];
  let dropped = [];
  let provenance = null;
  if (facts.length) {
    const vars = { days, maxLines: Math.max(1, max - pinned.length), facts, excerpts, pinned, dismissed, previous: prev?.text || '' };
    const res = await runPrompt(PROFILE_PROMPT, vars, { userId, feature: 'profile', lane, fetchFn, allowLighter });
    const checked = validateLines(res.data?.lines, facts, { pinned, dismissed, max: max - pinned.length });
    generated = checked.kept;
    dropped = [...(res.provenance?.dropped || []).map((d) => ({ text: d.entry?.text ?? null, reason: `invalid entry: ${(d.errors || []).join('; ')}` })), ...checked.dropped];
    // Written by the fallback model while Tier 2 was degraded: kept, marked provisional, and
    // rebuilt on Tier 2 when it is back (weeklyTick).
    const p = res.provenance || {};
    // An admin routing the profile to Tier 1 on purpose (provenance.routed) is not a degradation.
    const provisional = typeof p.lighterModel === 'boolean' ? p.lighterModel
      : Boolean(p.fellBack) || (p.tier === 'reflex' && !p.routed) || (!p.routed && ranOnLighterModel({ model: p.model }, cfg['llm.models.long']));
    provenance = { ...res.provenance, dropped: undefined, droppedLines: dropped, provisional, windowDays: days };
    if (dropped.length) console.warn(`[hedwig] profile: dropped ${dropped.length} line(s) for ${userId}: ${dropped.slice(0, 3).map((d) => d.reason).join('; ')}`);
  }
  const lines = composeLines({ pinned, generated, max });
  const text = linesToText(lines);
  if (prev && text === prev.text) return { status: 'done', version: prev.version, note: 'unchanged', dropped };
  const v = await insertVersion(userId, {
    text, lines, pinned, dismissed, evidence: facts,
    diff: unifiedDiff(prev?.text || '', text, { from: `v${prev?.version || 0}`, to: `v${(prev?.version || 0) + 1} (rebuild)` }),
    source: 'rebuild',
    provenance,
  });
  return { status: 'done', version: v.version, note: `v${v.version}${provenance?.provisional ? ' (provisional, lighter model)' : ''}: ${lines.length} lines (${pinned.length} pinned), ${facts.length} facts from ${days} days, ${dropped.length} dropped`, dropped };
}

export const TIER2_RETRY_MS = 30 * 60_000;

/**
 * Job handler for 'profile.rebuild' { userId }. Budget or gateway off → skipped, not failed.
 * The profile is a Tier 2 job: while Tier 2 is degraded the job waits (deferred, no attempt spent)
 * for up to profile.deferHours from when it was queued, then builds on the lighter model and marks
 * the version provisional.
 */
export async function runRebuildJob(payload = {}, job = {}) {
  const userId = payload.userId || job.user_id;
  if (!userId) return { status: 'done', note: 'no user' };
  try {
    const cfg = await getConfig(userId);
    const queuedAt = job?.created_at ? new Date(job.created_at).getTime() : Date.now();
    const mayWait = (Date.now() - queuedAt) / 3600_000 < (cfg['profile.deferHours'] ?? 24);
    const tier = await reasoningTier(userId);
    if (tier.degraded && mayWait) {
      deferJob(`Tier 2 (${tier.model || 'reasoning model'}) is degraded (${tier.reason || 'no answer'}); the profile waits for it`, TIER2_RETRY_MS);
    }
      // While it may still wait, the prompt must not fall back: tier_degraded then defers the job.
    const out = await rebuildProfile(userId, { allowLighter: !mayWait });
    return { status: 'done', note: out.note };
  } catch (err) {
    if (err?.code === 'job_deferred' || err?.code === 'tier_degraded') throw err;
    if (SOFT_ERRORS.has(err?.code)) return { status: 'partial', note: `skipped: ${err.message}` };
    throw err;
  }
}

/** POST /profile/rebuild. */
export async function enqueueRebuild(userId, { reason = 'manual' } = {}) {
  const jobId = await enqueue('profile.rebuild', { userId, reason }, { userId, dedupeKey: `profile.rebuild:${userId}`, priority: reason === 'manual' ? 4 : 7, maxAttempts: 2 });
  return { ok: true, jobId, deduplicated: jobId === null };
}

/** ISO week key, e.g. 2026-W39, for "once per week". Pure. */
export function weekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Schedule tick (every 10 min): enqueue the weekly rebuild for users whose profile.weekday /
 * profile.hour has come this week (server time), and a first build for users with none yet (once
 * a day until there is evidence for one).
 */
export async function weeklyTick(now = new Date()) {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  let enqueued = 0;
  for (const { user_id: userId } of rows) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['profile.enabled']) continue;
      const key = `profile.weekly.${userId}`;
      const last = await getState(key, null);
      const week = weekKey(now);
      const today = now.toISOString().slice(0, 10);
      const weeklyDue = now.getDay() === cfg['profile.weekday'] && now.getHours() >= cfg['profile.hour'] && last?.week !== week;
      let firstDue = false;
      let provisionalDue = false;
      if (!weeklyDue && last?.day !== today) {
        const { rows: has } = await query('SELECT 1 FROM hedwig_profile WHERE user_id = $1 LIMIT 1', [userId]);
        firstDue = !has.length;
      }
      if (!weeklyDue && !firstDue && (!last?.provisionalAt || now - new Date(last.provisionalAt) > 6 * 3600_000)) {
        // The latest version was written on the lighter model: redo it once Tier 2 answers again.
        const { rows: cur } = await query(
          `SELECT (provenance->>'provisional')::boolean AS provisional, source FROM hedwig_profile WHERE user_id = $1 ORDER BY version DESC LIMIT 1`,
          [userId],
        );
        provisionalDue = Boolean(cur[0]?.provisional && cur[0]?.source === 'rebuild') && !(await reasoningTier(userId)).degraded;
      }
      if (!weeklyDue && !firstDue && !provisionalDue) continue;
      await enqueueRebuild(userId, { reason: weeklyDue ? 'weekly' : firstDue ? 'first' : 'provisional' });
      if (provisionalDue && !weeklyDue && !firstDue) {
        await setState(key, { ...(last || {}), provisionalAt: now.toISOString() });
        enqueued++;
        continue;
      }
      await setState(key, { week: weeklyDue ? week : last?.week || null, day: today, at: now.toISOString() });
      enqueued++;
    } catch (err) {
      console.warn(`[hedwig] profile weekly tick failed for ${userId}:`, err.message);
    }
  }
  return enqueued;
}

export { parseLines };
