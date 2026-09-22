// Automations: a saved prompt the agent runs on a schedule. Scheduled runs happen in the worker;
// results are delivered as an Insight (kind 'automation') and, when asked, as a push notification.
// Automations run unattended, so any mail change they propose waits for the user's approval.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { getTool } from './toolRegistry.js';
import { parseSchedule, formatSchedule, nextRunAt } from './cron.js';
import { runAgent } from './runner.js';
import { userTools } from './access.js';
import { createRun, httpError, isUuid } from './store.js';
import { validTimezone } from '../insights/time.js';
import { insertInsight, ownedMessageIds } from '../insights/store.js';

export const RUN_JOB = 'agent.runAutomation';
// Unattended runs stop (status 'cancelled') before the job's own timeout would abandon them.
export const AUTOMATION_DEADLINE_MS = 14 * 60_000;
export const DELIVERIES = ['insight', 'notification'];
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export const TEMPLATES = Object.freeze([
  {
    id: 'daily-triage',
    name: 'Daily triage summary',
    prompt: 'Summarise what needs me today: the messages waiting for my reply or action (most urgent first), anything due or overdue that I promised, and threads where I am waiting on someone. One line each, with message citations. Suggest which ones I could archive, but do not propose any actions.',
    schedule: 'weekdays@07:30',
    allowed_tools: ['today', 'list_needs_you', 'list_waiting_on', 'list_commitments', 'read_message', 'get_thread', 'get_briefing'],
    deliver: 'insight',
  },
  {
    id: 'who-am-i-ignoring',
    name: 'Who am I ignoring?',
    prompt: 'Look at people (not newsletters or notifications) who wrote to me directly in the last two weeks and are still waiting for an answer, and at promises I made that are open. List who I am ignoring, how long they have waited, and what they asked, with citations. Offer to draft replies for the three most important.',
    schedule: 'weekly@5@16:00',
    allowed_tools: ['today', 'list_needs_you', 'search_mail', 'read_message', 'get_thread', 'get_person', 'list_commitments', 'get_overview'],
    deliver: 'insight',
  },
  {
    id: 'chase-unpaid-invoices',
    name: 'Chase unpaid invoices',
    prompt: 'Find invoices I sent or that others owe me which look unpaid: invoices, payment reminders or "they owe" commitments about money with no payment confirmation afterwards. For each, say who owes what since when, with citations, and prepare a short, polite chaser as a draft reply for each one that is more than 14 days old.',
    schedule: 'weekly@1@09:00',
    allowed_tools: ['today', 'search_mail', 'read_message', 'get_thread', 'list_commitments', 'draft_reply'],
    deliver: 'notification',
  },
]);

/** Templates with tools this installation does not have removed, so they can be saved as-is. */
export function availableTemplates() {
  return TEMPLATES.map((t) => ({ ...t, allowed_tools: t.allowed_tools.filter((n) => getTool(n)) }));
}

export function toAutomation(row) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    enabled: row.enabled,
    allowed_tools: Array.isArray(row.allowed_tools) ? row.allowed_tools : [],
    deliver: row.deliver,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function userTz(userId) {
  const cfg = await getConfig(userId);
  return validTimezone(cfg['insights.timezone']);
}

/**
 * Validate a create (partial = false) or update (partial = true) body. Returns only the fields
 * present, normalised. Unknown tool names are rejected so a typo does not silently drop a tool.
 */
export function validateAutomation(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const errors = [];
  const has = (k) => b[k] !== undefined;
  if (has('name') || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120) errors.push('name is required (at most 120 characters)');
    else out.name = name;
  }
  if (has('prompt') || !partial) {
    const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) errors.push('prompt is required (at most 4000 characters)');
    else out.prompt = prompt;
  }
  if (has('schedule') || !partial) {
    const parsed = parseSchedule(b.schedule);
    if (!parsed) errors.push('schedule must be daily@HH:MM, weekdays@HH:MM, weekly@<0-6>@HH:MM, every@<N>m (5-1440) or every@<N>h (1-168)');
    else out.schedule = formatSchedule(parsed);
  }
  if (has('allowed_tools')) {
    const list = b.allowed_tools;
    if (!Array.isArray(list) || list.length > 50 || list.some((n) => typeof n !== 'string' || !TOOL_NAME_RE.test(n))) {
      errors.push('allowed_tools must be a list of tool names');
    } else {
      const unknown = list.filter((n) => !getTool(n));
      if (unknown.length) errors.push(`unknown tools: ${unknown.join(', ')}`);
      else out.allowed_tools = [...new Set(list)];
    }
  }
  if (has('deliver')) {
    if (!DELIVERIES.includes(b.deliver)) errors.push(`deliver must be one of ${DELIVERIES.join(', ')}`);
    else out.deliver = b.deliver;
  }
  if (has('enabled')) {
    if (typeof b.enabled !== 'boolean') errors.push('enabled must be true or false');
    else out.enabled = b.enabled;
  }
  if (errors.length) throw httpError(400, errors.join('; '));
  return out;
}

export async function listAutomations(userId) {
  const { rows } = await query('SELECT * FROM hedwig_automations WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(toAutomation);
}

export async function getAutomationRow(userId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await query('SELECT * FROM hedwig_automations WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

export async function createAutomation(userId, body) {
  const v = validateAutomation(body);
  const enabled = v.enabled ?? true;
  const next = enabled ? nextRunAt(v.schedule, await userTz(userId)) : null;
  const { rows } = await query(
    `INSERT INTO hedwig_automations (user_id, name, prompt, schedule, enabled, allowed_tools, deliver, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, v.name, v.prompt, v.schedule, enabled, JSON.stringify(v.allowed_tools || []), v.deliver || 'insight', next],
  );
  return toAutomation(rows[0]);
}

export async function updateAutomation(userId, id, body) {
  const current = await getAutomationRow(userId, id);
  if (!current) throw httpError(404, 'Automation not found');
  const v = validateAutomation(body, { partial: true });
  const merged = { ...toAutomation(current), ...v };
  const reschedule = v.schedule !== undefined || v.enabled !== undefined;
  let next = current.next_run_at;
  if (reschedule) next = merged.enabled ? nextRunAt(merged.schedule, await userTz(userId)) : null;
  const { rows } = await query(
    `UPDATE hedwig_automations
        SET name = $3, prompt = $4, schedule = $5, enabled = $6, allowed_tools = $7, deliver = $8, next_run_at = $9, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, merged.name, merged.prompt, merged.schedule, merged.enabled, JSON.stringify(merged.allowed_tools), merged.deliver, next],
  );
  if (!rows.length) throw httpError(404, 'Automation not found');
  return toAutomation(rows[0]);
}

export async function deleteAutomation(userId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM hedwig_automations WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount > 0;
}

/** Tools an automation may use: its list, or every read-only tool when the list is empty. */
export function automationTools(automation, available) {
  const listed = Array.isArray(automation.allowed_tools) ? automation.allowed_tools : [];
  if (listed.length) return listed;
  return available.filter((t) => !t.mutates).map((t) => t.name);
}

/**
 * Rewrite the agent's [msg:<id>] citations as the Insight convention ([n] → sources[n-1]), keeping
 * only messages that belong to the user.
 */
export async function citeForInsight(userId, text) {
  const ids = [...String(text || '').matchAll(/\[msg:([0-9a-f-]{36})\]/gi)].map((m) => m[1].toLowerCase());
  const owned = await ownedMessageIds(userId, ids);
  const sources = [];
  const body = String(text || '').replace(/\[msg:([0-9a-f-]{36})\]/gi, (_, id) => {
    const key = id.toLowerCase();
    if (!owned.has(key)) return '';
    let n = sources.indexOf(key);
    if (n < 0) { sources.push(key); n = sources.length - 1; }
    return `[${n + 1}]`;
  });
  return { body, sources };
}

async function sendPush(userId, payload) {
  try {
    const { sendPushToUser } = await import('../../services/pushNotifications.js');
    await sendPushToUser(userId, payload);
  } catch (err) {
    console.warn(`[hedwig] automation push failed for ${userId}:`, err.message);
  }
}

async function deliver(userId, automation, run) {
  const pending = run.pendingActions.length;
  const text = run.status === 'done'
    ? (run.result || '_The automation finished without an answer._')
    : `_The automation did not finish (${run.status}${run.error ? `: ${run.error}` : ''})._`;
  const { body, sources } = await citeForInsight(userId, text);
  const footer = pending ? `\n\n_${pending} proposed action${pending === 1 ? ' is' : 's are'} waiting for your approval._` : '';
  const insight = await insertInsight(userId, {
    kind: 'automation',
    title: automation.name,
    body: `${body}${footer}`,
    sources,
    severity: run.status === 'done' ? (pending ? 'warn' : 'info') : 'alert',
    data: { automation_id: automation.id, run_id: run.runId, status: run.status, pending_actions: run.pendingActions },
    periodEnd: new Date(),
  });
  if (automation.deliver === 'notification') {
    const plain = body.replace(/\[\d+\]/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    await sendPush(userId, {
      title: automation.name,
      body: (pending ? `${pending} action${pending === 1 ? '' : 's'} to approve · ` : '') + (plain.length > 180 ? `${plain.slice(0, 177)}…` : plain),
      url: `/?hedwig=agent&run=${encodeURIComponent(run.runId)}`,
      tag: `hedwig-automation-${automation.id}`,
    });
  }
  return insight;
}

/**
 * Run an automation now and deliver its result. `runId` is a run created beforehand (manual runs
 * return it to the client before the agent starts).
 */
export async function executeAutomation(userId, automationId, { runId = null, manual = false } = {}) {
  const row = await getAutomationRow(userId, automationId);
  if (!row) return null;
  if (!row.enabled && !manual) return null;
  const automation = toAutomation(row);
  const allowed = automationTools(automation, await userTools(userId));
  const run = await runAgent({
    userId,
    prompt: automation.prompt,
    runId,
    allowedTools: allowed,
    trigger: 'automation',
    automationId: automation.id,
    title: automation.name,
    signal: AbortSignal.timeout(AUTOMATION_DEADLINE_MS),
  });
  await query('UPDATE hedwig_automations SET last_run_at = NOW() WHERE id = $1 AND user_id = $2', [automation.id, userId]);
  await deliver(userId, automation, run);
  return run;
}

/** POST /agent/automations/:id/run: create the run now, execute in the background. */
export async function startAutomationNow(userId, automationId) {
  const row = await getAutomationRow(userId, automationId);
  if (!row) throw httpError(404, 'Automation not found');
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['features.agent']) throw httpError(403, 'The agent is turned off');
  const run = await createRun(userId, { trigger: 'automation', automationId: row.id, title: row.name, status: 'queued' });
  executeAutomation(userId, row.id, { runId: run.id, manual: true })
    .catch((err) => console.error(`[hedwig] automation ${row.id} run ${run.id} failed:`, err.message));
  return { runId: run.id };
}

/** Job handler (worker): a scheduled run claimed by the tick. */
export async function runAutomationJob({ userId, automationId }) {
  if (!userId || !automationId) return;
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['features.agent']) return;
  await executeAutomation(userId, automationId);
}

/**
 * Worker schedule: claim every due automation (moving next_run_at forward first, so a restart or a
 * second worker cannot run it twice) and queue its run. Missed runs are not replayed: an automation
 * that was due while the worker was down runs once, now.
 */
export async function tickAutomations(now = new Date()) {
  const { rows } = await query(
    `SELECT id, user_id, schedule, next_run_at FROM hedwig_automations
      WHERE enabled AND (next_run_at IS NULL OR next_run_at <= $1)
      ORDER BY next_run_at NULLS FIRST LIMIT 100`,
    [now],
  );
  let queued = 0;
  for (const a of rows) {
    try {
      const tz = await userTz(a.user_id);
      let next;
      try {
        next = nextRunAt(a.schedule, tz, now);
      } catch {
        await query('UPDATE hedwig_automations SET enabled = false, updated_at = NOW() WHERE id = $1', [a.id]);
        console.warn(`[hedwig] automation ${a.id} has an invalid schedule "${a.schedule}"; disabled it`);
        continue;
      }
      const claimed = await query(
        `UPDATE hedwig_automations SET next_run_at = $2
          WHERE id = $1 AND enabled AND next_run_at IS NOT DISTINCT FROM $3 RETURNING id`,
        [a.id, next, a.next_run_at],
      );
      // next_run_at NULL means "not scheduled yet" (e.g. just re-enabled by SQL): schedule, don't run.
      if (!claimed.rowCount || a.next_run_at === null) continue;
      await enqueue(RUN_JOB, { userId: a.user_id, automationId: a.id }, {
        userId: a.user_id, dedupeKey: `automation:${a.id}:${new Date(a.next_run_at).toISOString()}`, priority: 4, maxAttempts: 1,
      });
      queued++;
    } catch (err) {
      console.warn(`[hedwig] automation tick failed for ${a.id}:`, err.message);
    }
  }
  return queued;
}
