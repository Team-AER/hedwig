// cards module (v2 stream G): Records cards from mail — receipts, invoices, subscriptions, deliveries,
// travel, events, one-time codes, and deadlines (the commitments view). Deterministic detectors
// first, the Reflex model for sorted Records mail they miss; routes for the list, one message's
// cards, edits (corrections), dismissals, "Not a subscription" / "Not a <kind>" and their undo, the
// owner's feedback, ledger views, the Brief's "Today" figures and card actions.
import { getConfig } from '../config.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { validTimezone } from '../insights/time.js';
import { isUuid } from '../context/util.js';
import { CARD_KINDS } from './kinds.js';
import { listCards, getCard, patchCard, dismissCard, restoreCard, cardsForMessages } from './store.js';
import { listFeedback, feedbackCount } from './feedback.js';
import { ledger, LEDGERS } from './ledger.js';
import { cardsToday } from './today.js';
import { cardActions } from './actions.js';
import { CARDS_JOB, ICS_JOB, runCardsJob, scanTick, pendingPayloads, makeIcsHandler } from './extract.js';

function sendError(res, err) {
  const status = err?.status || 500;
  if (status >= 500) console.error('[hedwig] cards route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

const handle = (fn, { idParam = null } = {}) => async (req, res) => {
  if (idParam && !isUuid(req.params[idParam])) return res.status(400).json({ error: `invalid ${idParam}` });
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled) return res.status(403).json({ error: 'Hedwig intelligence is turned off' });
    const out = await fn(req, res, cfg);
    if (res.headersSent) return undefined;
    if (out == null) return res.status(404).json({ error: 'Card not found' });
    return res.json(out);
  } catch (err) {
    return sendError(res, err);
  }
};

function parseKinds(v) {
  if (v == null || v === '') return null;
  const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((k) => !CARD_KINDS.includes(k));
  if (bad.length) throw Object.assign(new Error(`unknown kind ${bad[0]}`), { status: 400 });
  return list;
}

function parseSince(v) {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error('invalid since'), { status: 400 });
  return d;
}

let lastScan = 0;

export default {
  name: 'cards',

  routes(r) {
    r.get('/cards', handle(async (req) => ({
      cards: await listCards(req.session.userId, {
        kinds: parseKinds(req.query.kinds), since: parseSince(req.query.since), limit: req.query.limit,
        includeDismissed: req.query.dismissed === '1' || req.query.dismissed === 'true',
      }),
    })));

    // An array of figures (the Brief's shape). ?feedback=1 wraps it with how much feedback the owner
    // has given: { figures, feedback: { count, recent } } (recent: the last 7 days).
    r.get('/cards/today', handle(async (req) => {
      const figures = await cardsToday(req.session.userId);
      if (req.query.feedback !== '1' && req.query.feedback !== 'true') return figures;
      return { figures, feedback: await feedbackCount(req.session.userId) };
    }));

    // The owner's corrections, dismissals and "Not a …" verdicts, newest first: { count, recent, feedback: [...] }.
    r.get('/cards/feedback', handle(async (req) => listFeedback(req.session.userId, { limit: req.query.limit })));

    r.get('/cards/ledger/:kind', handle(async (req, res) => {
      if (!LEDGERS[req.params.kind]) return res.status(400).json({ error: `ledger must be one of ${Object.keys(LEDGERS).join(', ')}` });
      return ledger(req.session.userId, req.params.kind, { sort: req.query.sort, dir: req.query.dir, since: req.query.since, limit: req.query.limit });
    }));

    // --- v2 cards audit --- cards for list and bundle rows in one call: GET /cards/messages?ids=<uuid>,<uuid>
    r.get('/cards/messages', handle(async (req) => {
      const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(isUuid);
      return { cards: Object.fromEntries(await cardsForMessages(req.session.userId, ids)) };
    }));

    r.get('/cards/message/:id', handle(async (req) => ({
      cards: await listCards(req.session.userId, { messageId: req.params.id, includeDismissed: true }),
    }), { idParam: 'id' }));

    r.get('/cards/:id', handle((req) => getCard(req.session.userId, req.params.id), { idParam: 'id' }));

    r.get('/cards/:id/actions', handle(async (req, _res, cfg) => {
      const card = await getCard(req.session.userId, req.params.id);
      if (!card) return null;
      return { cardId: card.id, actions: cardActions(card, { tz: validTimezone(cfg['insights.timezone']) }) };
    }, { idParam: 'id' }));

    r.patch('/cards/:id', handle(async (req) => {
      const { fields } = req.body || {};
      return patchCard(req.session.userId, req.params.id, fields);
    }, { idParam: 'id' }));

    r.post('/cards/:id/dismiss', handle((req) => dismissCard(req.session.userId, req.params.id), { idParam: 'id' }));
    // A subscription that is not one: hidden, and its merchant is never derived as a subscription again.
    r.post('/cards/:id/not-recurring', handle((req) => dismissCard(req.session.userId, req.params.id, 'not_recurring'), { idParam: 'id' }));
    // "Not a receipt / an event / …": hidden, and that kind is not made again for its merchant.
    r.post('/cards/:id/not-kind', handle((req) => dismissCard(req.session.userId, req.params.id, 'not_this_kind'), { idParam: 'id' }));
    // The undo of the three above.
    r.post('/cards/:id/restore', handle((req) => restoreCard(req.session.userId, req.params.id), { idParam: 'id' }));
  },

  api({ imapManager }) {
    if (imapManager) defineJob(ICS_JOB, makeIcsHandler(imapManager), { timeoutMs: 2 * 60_000 });
  },

  worker() {
    defineJob(CARDS_JOB, (payload) => runCardsJob(payload), { timeoutMs: 10 * 60_000, rebuild: pendingPayloads });
    defineSchedule({
      name: 'cards.scan',
      everySec: 15,
      run: async () => {
        const cfg = await getConfig();
        if (Date.now() - lastScan < cfg['cards.scanEverySec'] * 1000) return;
        lastScan = Date.now();
        await scanTick();
      },
    });
  },
};
