// ask2 module (v2 stream G): Ask on the chunk index. The streaming route stays POST /context/ask
// (context/routes.js → context/ask.js, which delegates here); this module adds the saved-answer and
// feedback routes next to it.
import { getConfig } from '../config.js';
import { isUuid } from '../context/util.js';
import { getAnswer, answerFeedback } from './history.js';

function sendError(res, err) {
  const status = err?.status || 500;
  if (status >= 500) console.error('[hedwig] ask route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

// Only answer ids reach these handlers; anything else (e.g. /context/ask/history) falls through.
const handle = (fn) => async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled) return res.status(403).json({ error: 'Hedwig intelligence is turned off' });
    return await fn(req, res);
  } catch (err) {
    return sendError(res, err);
  }
};

export default {
  name: 'ask2',

  routes(r) {
    r.get('/context/ask/:id', handle(async (req, res) => {
      const out = await getAnswer(req.session.userId, req.params.id);
      if (!out) return res.status(404).json({ error: 'Answer not found' });
      return res.json(out);
    }));

    r.post('/context/ask/:id/feedback', handle(async (req, res) => {
      const { wrong = true, note = null } = req.body || {};
      if (note != null && typeof note !== 'string') return res.status(400).json({ error: 'note must be text' });
      return res.json(await answerFeedback(req.session.userId, req.params.id, { wrong: wrong !== false, note }));
    }));
  },
};
