// Core Hedwig routes: status, configuration, layouts, usage. Also defines the API-side body fetch.
import { query } from '../../services/db.js';
import { getConfig, describeConfig, saveSystemConfig, saveUserConfig, SCHEMA } from '../config.js';
import { defineJob, queueStats, pruneJobs, enqueue } from '../jobs.js';
import { pipelineStats, resetBackfill, definedSteps } from '../pipeline.js';
import { getCatalog, llmAvailable, activeModels } from '../llm.js';
import { embeddingProfile, embed } from '../embeddings.js';
import { defineSchedule, definedSchedules } from '../schedule.js';
import { hedwigStatus } from '../status.js';
import { makeFetchBodyHandler } from './bodies.js';

const LAYOUT_DEVICES = ['desktop', 'tablet', 'phone'];

function validTree(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (node.type === 'view') return typeof node.id === 'string' && node.id.length < 128;
  if (node.type === 'split') {
    return ['row', 'column'].includes(node.dir) && Array.isArray(node.children)
      && node.children.length >= 1 && node.children.length <= 8
      && node.children.every((c) => validTree(c, depth + 1));
  }
  if (node.type === 'tabs') {
    return Array.isArray(node.children) && node.children.length >= 1 && node.children.length <= 12
      && node.children.every((c) => validTree(c, depth + 1));
  }
  return false;
}

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
}

export default {
  name: 'core',

  api({ imapManager }) {
    defineJob('mail.fetchBody', makeFetchBodyHandler(imapManager), { timeoutMs: 90_000 });
  },

  worker() {
    defineSchedule({ name: 'core.pruneJobs', everySec: 6 * 3600, run: () => pruneJobs(7) });
    defineSchedule({
      name: 'core.pruneAiCalls',
      everySec: 24 * 3600,
      run: () => query("DELETE FROM hedwig_ai_calls WHERE created_at < NOW() - INTERVAL '90 days'"),
    });
  },

  routes(r) {
    // Whole-app status the shell reads on load: which features are on for this user.
    r.get('/status', async (req, res) => {
      const cfg = await getConfig(req.session.userId);
      res.json({
        ready: hedwigStatus.ready,
        error: hedwigStatus.error,
        enabled: cfg.enabled,
        llm: await llmAvailable(req.session.userId),
        models: await activeModels(req.session.userId),
        embeddings: await embeddingProfile(),
        features: {
          context: cfg['features.context'],
          triage: cfg['features.triage'],
          insights: cfg['features.insights'],
          agent: cfg['features.agent'],
          extraction: cfg['features.extraction'],
        },
        ui: { defaultTemplate: cfg['ui.defaultTemplate'] },
      });
    });

    // Per-user settings (only scope:'user' keys are writable here).
    r.get('/settings', async (req, res) => {
      const all = await describeConfig(req.session.userId);
      res.json(all.filter((f) => f.scope === 'user'));
    });
    r.patch('/settings', async (req, res) => {
      try {
        await saveUserConfig(req.session.userId, req.body || {});
        const all = await describeConfig(req.session.userId);
        res.json(all.filter((f) => f.scope === 'user'));
      } catch (err) { sendError(res, err); }
    });

    // Layouts: pane trees per device.
    r.get('/layouts', async (req, res) => {
      const { rows } = await query(
        'SELECT id, name, device, tree, is_active, updated_at FROM hedwig_layouts WHERE user_id = $1 ORDER BY device, name',
        [req.session.userId],
      );
      res.json(rows);
    });
    r.put('/layouts', async (req, res) => {
      const { name, device = 'desktop', tree, active = false } = req.body || {};
      if (!name || typeof name !== 'string' || name.length > 80) return res.status(400).json({ error: 'name is required' });
      if (!LAYOUT_DEVICES.includes(device)) return res.status(400).json({ error: 'invalid device' });
      if (!validTree(tree)) return res.status(400).json({ error: 'invalid pane tree' });
      if (active) await query('UPDATE hedwig_layouts SET is_active = false WHERE user_id = $1 AND device = $2', [req.session.userId, device]);
      const { rows } = await query(
        `INSERT INTO hedwig_layouts (user_id, name, device, tree, is_active) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, device, name) DO UPDATE SET tree = $4, is_active = $5 OR hedwig_layouts.is_active, updated_at = NOW()
         RETURNING id, name, device, tree, is_active, updated_at`,
        [req.session.userId, name, device, JSON.stringify(tree), Boolean(active)],
      );
      res.json(rows[0]);
    });
    r.post('/layouts/:id/activate', async (req, res) => {
      const { rows } = await query('SELECT device FROM hedwig_layouts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
      if (!rows.length) return res.status(404).json({ error: 'Layout not found' });
      await query('UPDATE hedwig_layouts SET is_active = (id = $1) WHERE user_id = $2 AND device = $3', [req.params.id, req.session.userId, rows[0].device]);
      res.json({ ok: true });
    });
    r.delete('/layouts/:id', async (req, res) => {
      await query('DELETE FROM hedwig_layouts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
      res.json({ ok: true });
    });

    // This user's model usage.
    r.get('/usage', async (req, res) => {
      const { rows } = await query(
        `SELECT feature, COALESCE(plugin_id, '') AS plugin_id, COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE NOT ok)::int AS errors,
                COALESCE(SUM(prompt_tokens),0)::int AS prompt_tokens, COALESCE(SUM(completion_tokens),0)::int AS completion_tokens,
                COALESCE(AVG(latency_ms),0)::int AS avg_latency_ms
           FROM hedwig_ai_calls WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())
          GROUP BY feature, plugin_id ORDER BY calls DESC`,
        [req.session.userId],
      );
      const cfg = await getConfig(req.session.userId);
      const budgets = Object.fromEntries(SCHEMA.filter((f) => f.key.startsWith('llm.dailyBudget.')).map((f) => [f.key.split('.').pop(), cfg[f.key]]));
      res.json({ today: rows, budgets });
    });
  },

  adminRoutes(r) {
    r.get('/config', async (req, res) => res.json(await describeConfig(null)));
    r.patch('/config', async (req, res) => {
      try {
        await saveSystemConfig(req.body || {});
        res.json(await describeConfig(null));
      } catch (err) { sendError(res, err); }
    });
    r.get('/catalog', async (req, res) => res.json(await getCatalog({ force: req.query.refresh === '1' })));
    r.post('/test-llm', async (req, res) => {
      const { chat } = await import('../llm.js');
      const started = Date.now();
      try {
        const out = await chat({ userId: req.session.userId, feature: 'admin', role: req.body?.role || 'fast', messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 20 });
        res.json({ ok: true, model: out.model, reply: out.content, ms: Date.now() - started });
      } catch (err) { res.status(200).json({ ok: false, error: err.message, ms: Date.now() - started }); }
    });
    r.post('/test-embeddings', async (req, res) => {
      const started = Date.now();
      try {
        const out = await embed(['Hedwig embedding check']);
        res.json({ ok: Boolean(out), model: out?.model, dims: out?.dims, ms: Date.now() - started });
      } catch (err) { res.json({ ok: false, error: err.message, ms: Date.now() - started }); }
    });
    r.get('/health', async (req, res) => {
      const [jobs, pipeline, calls] = await Promise.all([
        queueStats(),
        pipelineStats(),
        query(`SELECT feature, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT ok)::int AS errors,
                      COALESCE(AVG(latency_ms),0)::int AS avg_latency_ms
                 FROM hedwig_ai_calls WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY feature ORDER BY calls DESC`),
      ]);
      res.json({ status: hedwigStatus, models: await activeModels(null), jobs, pipeline, aiCalls24h: calls.rows, steps: definedSteps(), schedules: definedSchedules() });
    });
    r.post('/reindex', async (req, res) => {
      // Re-run the pipeline over history: clears per-message state (derived data only).
      const scope = req.body?.scope || 'backfill';
      if (scope === 'all') await query('DELETE FROM hedwig_msg');
      await resetBackfill();
      res.json({ ok: true, scope });
    });
    r.post('/jobs/retry-failed', async (req, res) => {
      const { rowCount } = await query("UPDATE hedwig_jobs SET failed_at = NULL, attempts = 0, run_at = NOW() WHERE failed_at > NOW() - INTERVAL '7 days'");
      res.json({ retried: rowCount });
    });
    r.post('/jobs/enqueue', async (req, res) => {
      const { kind, payload, userId } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'kind is required' });
      res.json({ id: await enqueue(kind, payload || {}, { userId: userId || null }) });
    });
  },
};
