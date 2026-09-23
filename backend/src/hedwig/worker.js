// hedwig-worker: runs the intelligence pipeline, jobs and schedules in its own process so model
// calls, embedding batches and retraining never block the API's event loop or IMAP sync.
// Same image as the backend; started with `node src/hedwig/worker.js`.
import 'dotenv/config';
import { pool } from '../services/db.js';
import { hedwigSchemaReady } from './migrate.js';
import { MODULES } from './modules.js';
import { claim, runJob, definedJobs } from './jobs.js';
import { tick } from './schedule.js';
import { scanOnce, definedSteps } from './pipeline.js';
import { getConfig } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

async function waitForSchema() {
  for (let i = 0; ; i++) {
    if (await hedwigSchemaReady().catch(() => false)) return;
    if (i % 10 === 0) console.log('[hedwig-worker] waiting for the API to apply migrations…');
    await sleep(3000);
  }
}

async function jobLoop() {
  const inflight = new Set();
  while (!stopping) {
    const cfg = await getConfig().catch(() => null);
    const limit = cfg ? cfg['pipeline.workerConcurrency'] : 2;
    const free = limit - inflight.size;
    if (free > 0) {
      const jobs = await claim(free).catch((err) => { console.warn('[hedwig-worker] claim failed:', err.message); return []; });
      for (const job of jobs) {
        const p = runJob(job).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      if (!jobs.length) await sleep(1000);
    } else {
      await Promise.race(inflight);
    }
  }
  await Promise.allSettled(inflight);
}

async function scanLoop() {
  while (!stopping) {
    let waitSec = 15;
    try {
      const cfg = await getConfig();
      waitSec = cfg['pipeline.scanIntervalSec'];
      const res = await scanOnce();
      if (res.realtime || res.backfill) console.log(`[hedwig-worker] indexed ${res.realtime} new, ${res.backfill} history`);
      // Keep going without a pause while there is backlog.
      if (res.backfill > 0 || res.realtime >= cfg['pipeline.batchSize']) waitSec = 1;
    } catch (err) {
      console.warn('[hedwig-worker] scan failed:', err.message);
    }
    await sleep(waitSec * 1000);
  }
}

async function scheduleLoop() {
  while (!stopping) {
    await tick().catch((err) => console.warn('[hedwig-worker] schedule tick failed:', err.message));
    await sleep(5000);
  }
}

async function main() {
  pool.on('error', (err) => console.error('[hedwig-worker] idle pg error:', err.message));
  await waitForSchema();
  for (const phase of ['tools', 'worker']) {
    for (const m of MODULES) {
      if (!m[phase]) continue;
      try {
        await (phase === 'worker' ? m.worker({}) : m.tools());
      } catch (err) {
        console.error(`[hedwig-worker] module ${m.name} failed during ${phase}:`, err);
      }
    }
  }
  console.log(`[hedwig-worker] ready — steps: ${definedSteps().map((s) => s.name).join(', ')}; jobs: ${definedJobs().join(', ')}`);
  await Promise.all([jobLoop(), scanLoop(), scheduleLoop()]);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[hedwig-worker] ${sig} — finishing in-flight jobs`);
    stopping = true;
    setTimeout(() => process.exit(0), 20_000).unref();
  });
}
process.on('unhandledRejection', (reason) => console.error('[hedwig-worker] unhandled rejection:', reason));

main().then(() => process.exit(0)).catch((err) => {
  console.error('[hedwig-worker] fatal:', err);
  process.exit(1);
});

// --- v2 runtime audit ---
// Connect the shared Redis client at start-up. The API connects it at boot; the worker used to
// connect only on its first model call, which then ran on a per-process lane limit and logged
// "lanes: redis not connected". Lanes and model health (llm.js) share this client.
import('./prompts/lanes.js')
  .then(({ connectRuntimeRedis }) => connectRuntimeRedis())
  .then((ok) => { if (!ok && process.env.REDIS_URL) console.warn('[hedwig-worker] redis not reachable yet; lane limits are per process until it is'); })
  .catch((err) => console.warn('[hedwig-worker] redis connect failed:', err?.message || err));
// --- end v2 runtime audit ---
