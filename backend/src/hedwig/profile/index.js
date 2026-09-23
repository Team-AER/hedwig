// profile module (v2 stream I): the memory profile — a short, versioned, second-person description
// of how the user handles mail, rebuilt weekly from behaviour, edited by the user (pinned lines),
// read by drafting (work/voice.js) and Reflex sorting (sort/reflex.js). See docs/hedwig/API.md.
import { getConfig } from '../config.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getProfile, saveProfileEdit, enqueueRebuild, profileHistory, runRebuildJob, weeklyTick } from './service.js';

export { profileLines } from './lines.js';

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[hedwig] profile route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

const handle = (fn) => async (req, res) => {
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled) return res.status(403).json({ error: 'Hedwig intelligence is turned off' });
    await fn(req, res, cfg);
  } catch (err) {
    sendError(res, err);
  }
};

export default {
  name: 'profile',

  routes(r) {
    r.get('/profile', handle(async (req, res) => res.json(await getProfile(req.session.userId))));
    r.put('/profile', handle(async (req, res) => res.json(await saveProfileEdit(req.session.userId, req.body || {}))));
    r.post('/profile/rebuild', handle(async (req, res, cfg) => {
      if (!cfg['profile.enabled']) return res.status(409).json({ error: 'The profile is off in your settings' });
      res.status(202).json(await enqueueRebuild(req.session.userId, { reason: 'manual' }));
    }));
    r.get('/profile/history', handle(async (req, res) => res.json(await profileHistory(req.session.userId, { limit: req.query.limit }))));
  },

  worker() {
    defineJob('profile.rebuild', runRebuildJob, { timeoutMs: 15 * 60_000, needsGateway: true });
    defineSchedule({ name: 'profile.weekly', everySec: 600, run: () => weeklyTick() });
  },
};
