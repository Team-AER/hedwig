// Hedwig's entry point inside the API process. index.js calls installHedwig() after the upstream
// routes are mounted and upstream migrations have run. Failure here is loud but never takes mail
// down: the API keeps serving MailFlow and /api/hedwig/status reports what broke.
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { runHedwigMigrations } from './migrate.js';
import { MODULES } from './modules.js';
import { claim, runJob, definedJobs } from './jobs.js';

import { hedwigStatus } from './status.js';
export { hedwigStatus };

/**
 * Mount Hedwig's routers. Must be called before the upstream 404/error middleware.
 * Routers are mounted synchronously so route order is stable; start() does the async work.
 */
export function mountHedwig(app) {
  const userRouter = Router();
  userRouter.use(requireAuth);
  const adminRouter = Router();
  adminRouter.use(requireAuth, requireAdmin);
  for (const m of MODULES) {
    if (m.routes) m.routes(userRouter);
    if (m.adminRoutes) m.adminRoutes(adminRouter);
  }
  // Admin first so /admin/* is not swallowed by a user route with a param.
  app.use('/api/hedwig/admin', adminRouter);
  app.use('/api/hedwig', userRouter);
}

let apiLoopStarted = false;

/** Run migrations, register tools and API-side jobs, start the API job loop. */
export async function startHedwig({ imapManager }) {
  hedwigStatus.startedAt = new Date().toISOString();
  try {
    await runHedwigMigrations();
    for (const m of MODULES) if (m.tools) await m.tools();
    for (const m of MODULES) if (m.api) await m.api({ imapManager });
    hedwigStatus.ready = true;
    if (!apiLoopStarted && definedJobs().length) {
      apiLoopStarted = true;
      apiJobLoop();
    }
    console.log('Hedwig: ready');
  } catch (err) {
    hedwigStatus.error = err.message;
    console.error('Hedwig: FAILED to start — mail keeps working, intelligence features are off:', err);
  }
}

// The API process only defines jobs that need the live mail engine (body fetches, approved agent
// actions). Everything else runs in hedwig-worker.
async function apiJobLoop() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      const jobs = await claim(2);
      if (!jobs.length) { await sleep(2000); continue; }
      await Promise.all(jobs.map(runJob));
    } catch (err) {
      console.warn('Hedwig API job loop:', err.message);
      await sleep(5000);
    }
  }
}
