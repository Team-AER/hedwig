// Pending agent actions: approval, rejection and execution. An action runs only after the user
// approved it, only once (the pending → approved transition is atomic), and only in the API
// process where the mail engine lives; elsewhere approval queues the API-side job instead.
import { enqueue } from '../jobs.js';
import { getTool } from './toolRegistry.js';
import { userTools } from './access.js';
import { validateArgs } from './validate.js';
import { ToolError, engineAvailable } from './mailOps.js';
import * as store from './store.js';

export const EXECUTE_JOB = 'agent.executeAction';
const NOTE_PREFIX = '[Hedwig status update, not typed by the user]';

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} characters]` : s;
}

/** A conversation note so a continued run knows what happened to an action. */
export function actionNote(action) {
  const what = `action ${action.id} (${action.tool}: ${action.summary})`;
  let outcome;
  if (action.status === 'rejected') outcome = `The user rejected ${what}. It was not carried out.`;
  else if (action.status === 'executed') outcome = `The user approved ${what} and it was carried out. Result: ${truncate(JSON.stringify(action.result ?? null), 1500)}`;
  else if (action.status === 'failed') outcome = `The user approved ${what} but it failed: ${truncate(action.result?.error || 'unknown error', 500)}`;
  else outcome = `The user approved ${what}; it is queued to run.`;
  return { role: 'user', kind: 'action_update', action_id: action.id, content: `${NOTE_PREFIX} ${outcome}` };
}

async function addNote(userId, action) {
  try {
    await store.appendToRun(userId, action.run_id, { messages: [actionNote(action)] });
  } catch (err) {
    console.warn(`[hedwig] could not note action ${action.id} on its run:`, err.message);
  }
}

/** Run an action that is already in status 'approved'. Records executed/failed and the result. */
export async function executeApproved(userId, row, { note = true } = {}) {
  let result;
  let status;
  try {
    const tool = getTool(row.tool);
    if (!tool || !tool.mutates) throw new ToolError(`tool ${row.tool} is not available`);
    const available = await userTools(userId);
    if (!available.some((t) => t.name === tool.name)) throw new ToolError(`tool ${row.tool} is no longer allowed for this user`);
    const v = validateArgs(tool.parameters, row.args);
    if (!v.ok) throw new ToolError(`invalid arguments: ${v.errors.join('; ')}`);
    result = await tool.handler(v.value, { userId, runId: row.run_id, actionId: row.id });
    status = 'executed';
  } catch (err) {
    status = 'failed';
    const expected = err instanceof ToolError || (err.status && err.status < 500);
    if (!expected) console.error(`[hedwig] agent action ${row.id} (${row.tool}) failed:`, err);
    result = { error: err.message || 'failed' };
  }
  const updated = await store.transitionAction(userId, row.id, 'approved', status, result ?? null);
  const action = store.toAction(updated || { ...row, status, result });
  if (note) await addNote(userId, action);
  return { action, result: result ?? null };
}

/**
 * Approve a pending action and, in the API process, execute it. Throws 404 for an unknown (or
 * another user's) action and 409 when it was already decided.
 */
export async function approveAction(userId, actionId, { note = true } = {}) {
  const row = await store.transitionAction(userId, actionId, 'pending', 'approved');
  if (!row) {
    const existing = await store.getActionRow(userId, actionId);
    if (!existing) throw store.httpError(404, 'Action not found');
    throw store.httpError(409, `Action is already ${existing.status}`);
  }
  if (!engineAvailable()) {
    await enqueue(EXECUTE_JOB, { userId, actionId: row.id }, { userId, dedupeKey: `agent.action:${row.id}`, priority: 2, maxAttempts: 1 });
    const action = store.toAction(row);
    if (note) await addNote(userId, action);
    return { action, result: null, queued: true };
  }
  return executeApproved(userId, row, { note });
}

export async function rejectAction(userId, actionId) {
  const row = await store.transitionAction(userId, actionId, 'pending', 'rejected');
  if (!row) {
    const existing = await store.getActionRow(userId, actionId);
    if (!existing) throw store.httpError(404, 'Action not found');
    throw store.httpError(409, `Action is already ${existing.status}`);
  }
  const action = store.toAction(row);
  await addNote(userId, action);
  return { action };
}

/** API-side job: execute an action approved somewhere without the mail engine. */
export async function executeActionJob({ userId, actionId }) {
  const row = await store.getActionRow(userId, actionId);
  if (!row || row.status !== 'approved') return;
  await executeApproved(userId, row);
}
