// Insights module: mail statistics, daily insight cards and briefings. See docs/hedwig/API.md.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { defineJob, enqueue } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getState, setState } from '../state.js';
import { overview, listCards, generateCards, latestBriefing, listBriefings, generateBriefing, dismissCard } from './service.js';
import { generateBriefing as generateStored, hasScheduled } from './briefing.js';
import { validTimezone, zonedParts, localDay, parseClock } from './time.js';
import { recentAutomationResults } from './store.js';

const DEFAULT_CLOCK = { hour: 7, minute: 0 };

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[hedwig] insights route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

async function insightsEnabled(userId) {
  const cfg = await getConfig(userId);
  return Boolean(cfg.enabled && cfg['features.insights']);
}

/** Express handler wrapper: feature gate + error mapping. */
const handle = (fn) => async (req, res) => {
  try {
    if (!(await insightsEnabled(req.session.userId))) return res.status(403).json({ error: 'Insights are turned off' });
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * Who is due for their daily run at `now`: local time at or past insights.briefingTime and no run
 * recorded for this local day yet. Exported for tests.
 */
export function isDue({ now, tz, briefingTime, lastDay }) {
  const clock = parseClock(briefingTime) || DEFAULT_CLOCK;
  const p = zonedParts(now, tz);
  const day = localDay(now, tz);
  if (lastDay === day) return { due: false, day };
  const reached = p.hour > clock.hour || (p.hour === clock.hour && p.minute >= clock.minute);
  return { due: reached, day, weekday: p.weekday };
}

const dailyStateKey = (userId) => `insights.daily.${userId}`;

async function tickDaily(now = new Date()) {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts');
  for (const { user_id: userId } of rows) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['features.insights']) continue;
      const tz = validTimezone(cfg['insights.timezone']);
      const last = await getState(dailyStateKey(userId), null);
      const { due, day, weekday } = isDue({ now, tz, briefingTime: cfg['insights.briefingTime'], lastDay: last?.day });
      if (!due) continue;
      await enqueue('insights.daily', { userId, day, weekly: weekday === cfg['insights.weeklyDay'] }, {
        userId, dedupeKey: `insights.daily:${userId}:${day}`, priority: 4, maxAttempts: 3,
      });
      await setState(dailyStateKey(userId), { day, enqueuedAt: now.toISOString() });
    } catch (err) {
      console.warn(`[hedwig] insights tick failed for ${userId}:`, err.message);
    }
  }
}

/** The once-a-day job: cards, then the briefing, then (on weeklyDay) the weekly review. */
export async function runDaily({ userId, day, weekly }) {
  if (!userId || !day) return;
  await generateCards(userId);
  if (!(await hasScheduled(userId, 'briefing', day))) await generateStored(userId, { period: 'day', scheduledDay: day });
  if (weekly && !(await hasScheduled(userId, 'weekly', day))) await generateStored(userId, { period: 'week', scheduledDay: day });
}

export default {
  name: 'insights',

  worker() {
    defineJob('insights.daily', runDaily, { timeoutMs: 5 * 60_000 });
    defineSchedule({ name: 'insights.daily', everySec: 300, run: () => tickDaily() });
  },

  routes(r) {
    r.get('/insights/overview', handle(async (req, res) => {
      res.json(await overview(req.session.userId, { days: req.query.days ?? 30 }));
    }));

    // Today's cards, then recent automation results (kind 'automation'), which are dismissed the same way.
    r.get('/insights/cards', handle(async (req, res) => {
      const [cards, automations] = await Promise.all([listCards(req.session.userId), recentAutomationResults(req.session.userId)]);
      res.json([...cards, ...automations]);
    }));

    r.post('/insights/cards/:id/dismiss', handle(async (req, res) => {
      const ok = await dismissCard(req.session.userId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Insight not found' });
      res.json({ ok: true });
    }));

    r.get('/insights/briefing', handle(async (req, res) => {
      res.json(await latestBriefing(req.session.userId));
    }));

    r.get('/insights/briefings', handle(async (req, res) => {
      res.json(await listBriefings(req.session.userId, { limit: req.query.limit }));
    }));

    r.post('/insights/briefing/generate', handle(async (req, res) => {
      res.json(await generateBriefing(req.session.userId));
    }));
  },
};
