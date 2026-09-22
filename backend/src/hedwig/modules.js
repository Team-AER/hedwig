// Feature modules. Each is an object with optional lifecycle functions:
//
//   name: string
//   tools():               register agent tools (called in the API and the worker)
//   routes(router):        user routes, mounted at /api/hedwig (requireAuth applied)
//   adminRoutes(router):   admin routes, mounted at /api/hedwig/admin (requireAdmin applied)
//   api(ctx):              API-process start-up; ctx = { imapManager }. Define API-side jobs here
//                          (jobs that need the live mail engine).
//   worker(ctx):           worker start-up: defineStep / defineJob / defineSchedule
//
// Order matters only for pipeline steps, which carry their own `order`.
import core from './core/index.js';
import context from './context/index.js';
import triage from './triage/index.js';
import insights from './insights/index.js';
import agent from './agent/index.js';
import pluginsV2 from './pluginsv2/index.js';

export const MODULES = [core, context, triage, insights, agent, pluginsV2];
