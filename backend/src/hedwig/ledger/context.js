// Ambient runtime context for model calls, carried with AsyncLocalStorage so no call site has to
// thread it: which lane a call belongs to, and which job (if any) it runs under so its tokens are
// added to hedwig_jobs.tokens_in/tokens_out.
//
//   runInContext({ lane: 'background', job }, fn)   jobs.js wraps every handler in this
//   currentLane()                                   explicit lane > ambient > process default
//   setDefaultLane('background')                    the worker process calls this once
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
let processDefaultLane = 'interactive';

export const LANES = ['interactive', 'background'];

export function setDefaultLane(lane) {
  if (!LANES.includes(lane)) throw new Error(`unknown lane ${lane}`);
  processDefaultLane = lane;
}

export function runInContext(ctx, fn) {
  const parent = storage.getStore() || {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function currentContext() {
  return storage.getStore() || null;
}

export function currentLane(explicit) {
  if (LANES.includes(explicit)) return explicit;
  const ambient = storage.getStore()?.lane;
  return LANES.includes(ambient) ? ambient : processDefaultLane;
}

/** Add a call's usage to the job running in this context, if any. */
export function recordUsage(usage) {
  const job = storage.getStore()?.job;
  if (!job || !usage) return;
  job.tokensIn = (job.tokensIn || 0) + (Number(usage.prompt_tokens) || 0);
  job.tokensOut = (job.tokensOut || 0) + (Number(usage.completion_tokens) || 0);
}

export function currentJobId() {
  return storage.getStore()?.job?.id ?? null;
}

export function _resetContext() { processDefaultLane = 'interactive'; }
