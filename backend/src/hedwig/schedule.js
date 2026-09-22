// Periodic tasks for the worker. Long-period tasks persist their last run in hedwig_state so a
// restart does not re-run them early. Per-user clock times (briefings, retrains) are handled by
// the owning module: it schedules a frequent tick and decides who is due.
import { getState, setState } from './state.js';

const tasks = new Map(); // name -> { everySec, run, running }

export function defineSchedule({ name, everySec, run, runOnStart = false }) {
  if (tasks.has(name)) throw new Error(`schedule ${name} already defined`);
  if (!(everySec > 0) || typeof run !== 'function') throw new Error(`schedule ${name} needs everySec and run`);
  tasks.set(name, { name, everySec, run, runOnStart, running: false });
}

export function definedSchedules() {
  return [...tasks.values()].map(({ name, everySec }) => ({ name, everySec }));
}

async function lastRun(task) {
  if (task.everySec < 3600) return task.lastRun || 0;
  const s = await getState(`schedule.${task.name}`, null);
  return s?.at ? Date.parse(s.at) : 0;
}

/** Run every due task once. Called by the worker loop every few seconds. */
export async function tick(now = Date.now()) {
  for (const task of tasks.values()) {
    if (task.running) continue;
    const last = await lastRun(task);
    const due = last === 0 ? (task.runOnStart || task.everySec < 3600) : now - last >= task.everySec * 1000;
    if (!due) {
      if (last === 0 && task.everySec >= 3600) await setState(`schedule.${task.name}`, { at: new Date(now).toISOString() });
      continue;
    }
    task.running = true;
    task.lastRun = now;
    if (task.everySec >= 3600) await setState(`schedule.${task.name}`, { at: new Date(now).toISOString() });
    Promise.resolve()
      .then(() => task.run())
      .catch((err) => console.warn(`[hedwig] schedule ${task.name} failed:`, err?.message || err))
      .finally(() => { task.running = false; });
  }
}

export function _resetSchedules() { tasks.clear(); }
