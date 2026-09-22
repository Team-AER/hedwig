// Daily insight cards. Each builder looks at one kind of evidence and returns at most one card
// carrying the message ids it is based on. Cards are keyed per local day, so regenerating during
// the day updates a card in place instead of duplicating it, and a dismissed card stays dismissed
// until its evidence changes.
import { createHash } from 'crypto';
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { getState, setState } from '../state.js';
import { collectHedwigHook, HEDWIG_HOOKS } from '../hooks.js';
import { ADDRS_CTE, userMessagesCte } from './scope.js';
import { responseSamples, responseTrend } from './stats.js';
import { responseRows } from './overview.js';
import { validTimezone, startOfLocalDay, localDay } from './time.js';
import { toInsight, ownedMessageIds } from './store.js';

export const CARD_RULES = Object.freeze({
  oweReplyDays: 3,          // an unanswered direct message older than this is a reply you owe
  lookbackDays: 30,         // ignore threads quieter than this
  spikeMinCount: 5,         // a sender needs at least this many messages this week to "spike"
  spikeFactor: 3,           // … and this many times their usual weekly volume
  newsletterShare: 0.3,     // mention newsletters once they are this share of incoming mail
  newsletterMinUnread: 3,   // a newsletter unopened this many times in a row is worth unsubscribing
  trendRatio: 1.5,          // reply-time change worth mentioning
  dismissQuietDays: 7,      // a dismissed card with the same evidence stays away this long
  maxSources: 10,
  maxPluginCards: 5,
});

const DAY = 86400_000;
const SEVERITIES = new Set(['info', 'warn', 'alert']);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const who = (r) => r.from_name || r.from_email || 'someone';
const ageDays = (date, now) => Math.max(0, Math.floor((now - new Date(date).getTime()) / DAY));
const cleanLine = (s, max = 120) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/([[\]*_`])/g, '\\$1').slice(0, max);

export function fingerprint(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** Markdown bullet list citing sources as [n] (1-based into `sources`). */
function itemsBody(intro, items) {
  const lines = items.map((it, i) => `- ${it.text} [${i + 1}]`);
  return [intro, '', ...lines].join('\n');
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** Threads active in the lookback window, newest message per thread, with triage state. */
async function latestPerThread(userId, lookbackDays) {
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte("NOW() - make_interval(days => $2::int)", { extraColumns: ', m.snippet' })},
     latest AS (
       SELECT DISTINCT ON (account_id, thread_key) * FROM um WHERE thread_key IS NOT NULL
        ORDER BY account_id, thread_key, date DESC
     )
     SELECT l.*, t.needs_you, t.resolved_at, COALESCE(t.override_category, t.category) AS category
       FROM latest l LEFT JOIN hedwig_triage t ON t.message_id = l.id
      ORDER BY l.date DESC`,
    [userId, lookbackDays],
  );
  return rows;
}

function isDirectTo(row, addrs) {
  const to = Array.isArray(row.to_addresses) ? row.to_addresses : [];
  return to.some((a) => addrs.has(String(typeof a === 'string' ? a : a?.address || a?.email || '').toLowerCase()));
}

async function userAddressSet(userId) {
  const { rows } = await query(`WITH ${ADDRS_CTE} SELECT e FROM addrs`, [userId]);
  return new Set(rows.map((r) => r.e).filter(Boolean));
}

// ── Builders (exported for tests; each takes plain rows) ───────────────────────

export function oweRepliesCard(threads, addrs, { now = Date.now() } = {}) {
  const cutoff = now - CARD_RULES.oweReplyDays * DAY;
  const owed = threads.filter((r) => {
    if (r.outgoing || r.bulk || r.resolved_at) return false;
    if (new Date(r.date).getTime() > cutoff) return false;
    if (r.category) return r.needs_you === true;
    return isDirectTo(r, addrs);
  });
  if (!owed.length) return null;
  const items = owed.slice(0, CARD_RULES.maxSources);
  const oldest = Math.max(...owed.map((r) => ageDays(r.date, now)));
  return {
    key: 'owe_replies',
    title: `You owe ${plural(owed.length, 'reply', 'replies')} older than ${CARD_RULES.oweReplyDays} days`,
    body: itemsBody('These threads end with a message to you that has no answer yet:', items.map((r) => ({
      text: `**${cleanLine(who(r), 60)}** — ${cleanLine(r.subject || '(no subject)')} (${plural(ageDays(r.date, now), 'day')})`,
    }))),
    severity: oldest >= 7 ? 'alert' : 'warn',
    sources: items.map((r) => r.id),
    data: { count: owed.length, oldest_days: oldest },
  };
}

export function staleWaitingCard(threads, { now = Date.now(), waitingOnDays = 3 } = {}) {
  const staleAfter = Math.max(waitingOnDays * 2, 5);
  const cutoff = now - staleAfter * DAY;
  const stale = threads.filter((r) => {
    if (!r.outgoing || r.resolved_at) return false;
    if (new Date(r.date).getTime() > cutoff) return false;
    if (r.category) return r.category === 'waiting_on';
    // Without triage, only count messages that asked something.
    return /\?/.test(`${r.subject || ''} ${r.snippet || ''}`);
  });
  if (!stale.length) return null;
  const items = stale.slice(0, CARD_RULES.maxSources);
  const recipient = (r) => {
    const to = Array.isArray(r.to_addresses) ? r.to_addresses : [];
    const first = to[0];
    return (typeof first === 'string' ? first : first?.name || first?.address || first?.email) || 'them';
  };
  return {
    key: 'stale_waiting',
    title: `${plural(stale.length, 'thread')} you are waiting on went quiet`,
    body: itemsBody(`No reply for more than ${staleAfter} days. A nudge might help:`, items.map((r) => ({
      text: `**${cleanLine(recipient(r), 60)}** — ${cleanLine(r.subject || '(no subject)')} (sent ${plural(ageDays(r.date, now), 'day')} ago)`,
    }))),
    severity: 'info',
    sources: items.map((r) => r.id),
    data: { count: stale.length, stale_after_days: staleAfter },
  };
}

export function overdueCommitmentsCard(commitments, { now = Date.now() } = {}) {
  const overdue = commitments.filter((c) => c.direction === 'i_owe' && c.due_at && new Date(c.due_at).getTime() < now);
  if (!overdue.length) return null;
  const items = overdue.slice(0, CARD_RULES.maxSources);
  const withSource = items.filter((c) => c.source_message_id);
  const lines = items.map((c) => {
    const n = withSource.indexOf(c);
    const cite = n >= 0 ? ` [${n + 1}]` : '';
    const to = c.counterparty ? ` to ${cleanLine(c.counterparty, 60)}` : '';
    return `- ${cleanLine(c.what, 160)}${to} — due ${plural(ageDays(c.due_at, now), 'day')} ago${cite}`;
  });
  return {
    key: 'overdue_commitments',
    title: `${plural(overdue.length, 'promise')} you made ${overdue.length === 1 ? 'is' : 'are'} overdue`,
    body: ['Commitments you made in mail that are past their due date:', '', ...lines].join('\n'),
    severity: 'alert',
    sources: withSource.map((c) => c.source_message_id),
    data: { count: overdue.length, commitment_ids: items.map((c) => c.id) },
  };
}

/** rows: [{ from_email, from_name, this_week, prior_weeks_avg, sample_id }] */
export function senderSpikeCard(rows) {
  const spikes = rows.filter((r) => r.this_week >= CARD_RULES.spikeMinCount
    && r.this_week >= CARD_RULES.spikeFactor * Math.max(1, Number(r.prior_weeks_avg) || 0));
  if (!spikes.length) return null;
  const top = spikes.sort((a, b) => b.this_week - a.this_week)[0];
  const usual = Number(top.prior_weeks_avg) || 0;
  return {
    key: `sender_spike:${top.from_email}`,
    title: `${cleanLine(top.from_name || top.from_email, 60)} sent ${top.this_week} messages this week`,
    body: `That is ${usual < 0.5 ? 'far more than usual (normally almost none)' : `about ${Math.round(top.this_week / usual)}× their usual ${Math.round(usual * 10) / 10} a week`}. Latest [1].`,
    severity: 'info',
    sources: [top.sample_id],
    data: { email: top.from_email, this_week: top.this_week, usual_per_week: Math.round(usual * 10) / 10 },
  };
}

/** stats: { incoming, bulk }, senders: [{ from_email, from_name, count, opened, sample_id }] */
export function newsletterCard(stats, senders) {
  const share = stats.incoming ? stats.bulk / stats.incoming : 0;
  const neverOpened = senders.filter((s) => s.count >= CARD_RULES.newsletterMinUnread && Number(s.opened) === 0)
    .sort((a, b) => b.count - a.count).slice(0, 5);
  if (share < CARD_RULES.newsletterShare && !neverOpened.length) return null;
  const pct = Math.round(share * 100);
  const intro = `Newsletters and bulk mail were ${pct}% of what reached you in the last ${CARD_RULES.lookbackDays} days (${stats.bulk} of ${stats.incoming}).`;
  const body = neverOpened.length
    ? itemsBody(`${intro} You never opened these — consider unsubscribing:`, neverOpened.map((s) => ({
      text: `**${cleanLine(s.from_name || s.from_email, 60)}** — ${plural(s.count, 'message')}, none opened`,
    })))
    : intro;
  return {
    key: 'newsletters',
    title: neverOpened.length ? `${plural(neverOpened.length, 'newsletter')} you never read` : `${pct}% of your mail is bulk`,
    body,
    severity: 'info',
    sources: neverOpened.map((s) => s.sample_id),
    data: { share: Math.round(share * 100) / 100, bulk: stats.bulk, incoming: stats.incoming, unsubscribe: neverOpened.map((s) => s.from_email) },
  };
}

export function responseTrendCard(trend) {
  if (!trend || !trend.ratio) return null;
  const slower = trend.ratio >= CARD_RULES.trendRatio;
  const faster = trend.ratio <= 1 / CARD_RULES.trendRatio;
  if (!slower && !faster) return null;
  const fmt = (h) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`);
  return {
    key: 'response_trend',
    title: slower ? 'You are replying more slowly' : 'You are replying faster',
    body: `Median time to reply over the last two weeks: **${fmt(trend.recent_hours)}** (${trend.recent_n} replies), against ${fmt(trend.previous_hours)} the two weeks before (${trend.previous_n} replies).`,
    severity: slower ? 'warn' : 'info',
    sources: [],
    data: trend,
  };
}

/** Validate plugin-contributed cards. Anything malformed is dropped, never trusted. */
export function normalisePluginCards(results) {
  const flat = (Array.isArray(results) ? results : []).flatMap((r) => (Array.isArray(r) ? r : [r]));
  const out = [];
  for (const c of flat) {
    if (!c || typeof c !== 'object' || typeof c.title !== 'string' || !c.title.trim()) continue;
    const title = c.title.trim().slice(0, 200);
    out.push({
      key: `plugin:${fingerprint([c.pluginId || '', c.key || title])}`,
      title,
      body: typeof c.body === 'string' ? c.body.slice(0, 4000) : '',
      severity: SEVERITIES.has(c.severity) ? c.severity : 'info',
      sources: Array.isArray(c.sources) ? c.sources.filter((s) => typeof s === 'string').slice(0, CARD_RULES.maxSources) : [],
      data: { ...(c.data && typeof c.data === 'object' && !Array.isArray(c.data) ? c.data : {}), plugin: c.pluginId || null },
    });
    if (out.length >= CARD_RULES.maxPluginCards) break;
  }
  return out;
}

// ── Evidence queries ─────────────────────────────────────────────────────────

async function openCommitments(userId, minConfidence) {
  const { rows } = await query(
    `SELECT id, direction, counterparty, what, due_at, source_message_id FROM hedwig_commitments
      WHERE user_id = $1 AND status = 'open' AND due_at IS NOT NULL AND due_at < NOW()
        AND (user_edited OR confidence IS NULL OR confidence >= $2)
      ORDER BY due_at LIMIT 50`,
    [userId, minConfidence],
  );
  return rows;
}

async function senderVolumes(userId) {
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte("NOW() - INTERVAL '63 days'")}
     SELECT from_email, (ARRAY_AGG(from_name ORDER BY date DESC))[1] AS from_name,
            COUNT(*) FILTER (WHERE date >= NOW() - INTERVAL '7 days')::int AS this_week,
            (COUNT(*) FILTER (WHERE date < NOW() - INTERVAL '7 days'))::float / 8 AS prior_weeks_avg,
            (ARRAY_AGG(id ORDER BY date DESC))[1] AS sample_id
       FROM um WHERE NOT outgoing AND from_email IS NOT NULL
      GROUP BY from_email
     HAVING COUNT(*) FILTER (WHERE date >= NOW() - INTERVAL '7 days') >= $2`,
    [userId, CARD_RULES.spikeMinCount],
  );
  return rows;
}

async function newsletterEvidence(userId) {
  const sinceExpr = `NOW() - make_interval(days => ${CARD_RULES.lookbackDays})`;
  const [{ rows: totals }, { rows: senders }] = await Promise.all([
    query(
      `WITH ${ADDRS_CTE}, ${userMessagesCte(sinceExpr)}
       SELECT COUNT(*)::int AS incoming, COUNT(*) FILTER (WHERE bulk)::int AS bulk FROM um WHERE NOT outgoing`,
      [userId],
    ),
    query(
      `WITH ${ADDRS_CTE}, ${userMessagesCte(sinceExpr)}
       SELECT from_email, (ARRAY_AGG(from_name ORDER BY date DESC))[1] AS from_name, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE is_read)::int AS opened, (ARRAY_AGG(id ORDER BY date DESC))[1] AS sample_id
         FROM um WHERE NOT outgoing AND bulk AND from_email IS NOT NULL
        GROUP BY from_email HAVING COUNT(*) >= $2`,
      [userId, CARD_RULES.newsletterMinUnread],
    ),
  ]);
  return { stats: totals[0] || { incoming: 0, bulk: 0 }, senders };
}

// ── Generation ───────────────────────────────────────────────────────────────

/** Every deterministic card for a user right now. Each builder failing is logged and skipped. */
export async function buildCards(userId, { now = Date.now() } = {}) {
  const cfg = await getConfig(userId);
  const safe = async (name, fn) => {
    try { return await fn(); } catch (err) {
      console.warn(`[hedwig] insight card ${name} failed for ${userId}:`, err.message);
      return null;
    }
  };
  const threadsP = latestPerThread(userId, CARD_RULES.lookbackDays);
  const addrsP = userAddressSet(userId);
  const cards = await Promise.all([
    safe('owe_replies', async () => oweRepliesCard(await threadsP, await addrsP, { now })),
    safe('stale_waiting', async () => staleWaitingCard(await threadsP, { now, waitingOnDays: cfg['triage.waitingOnDays'] })),
    safe('overdue_commitments', async () => overdueCommitmentsCard(await openCommitments(userId, cfg['context.extractMinConfidence']), { now })),
    safe('sender_spike', async () => senderSpikeCard(await senderVolumes(userId))),
    safe('newsletters', async () => {
      const { stats, senders } = await newsletterEvidence(userId);
      return newsletterCard(stats, senders);
    }),
    safe('response_trend', async () => responseTrendCard(responseTrend(responseSamples(await responseRows(userId, 28)), { now: new Date(now) }))),
  ]);
  const plugin = await safe('plugins', async () => {
    const results = await collectHedwigHook(HEDWIG_HOOKS.collectInsights, { userId });
    const list = normalisePluginCards(results);
    const owned = await ownedMessageIds(userId, list.flatMap((c) => c.sources));
    return list.map((c) => ({ ...c, sources: c.sources.filter((s) => owned.has(s)) }));
  });
  return [...cards.filter(Boolean), ...(plugin || [])];
}

const cardsStateKey = (userId) => `insights.cards.${userId}`;

/**
 * Build today's cards and store them. Idempotent per local day: a card key already stored today is
 * updated in place (unless dismissed), cards whose evidence disappeared are withdrawn, and a card
 * dismissed within CARD_RULES.dismissQuietDays is not re-created while its evidence is unchanged.
 */
export async function generateCards(userId, { now = Date.now() } = {}) {
  const cfg = await getConfig(userId);
  const tz = validTimezone(cfg['insights.timezone']);
  return storeCards(userId, await buildCards(userId, { now }), { now, tz });
}

/** Store one day's cards (see generateCards). Exported for tests. */
export async function storeCards(userId, cards, { now = Date.now(), tz = 'UTC' } = {}) {
  const periodStart = startOfLocalDay(new Date(now), tz);
  const periodEnd = new Date(periodStart.getTime() + DAY);

  const { rows: quiet } = await query(
    `SELECT data->>'key' AS key, data->>'fingerprint' AS fp FROM hedwig_insights
      WHERE user_id = $1 AND kind = 'card' AND dismissed_at > NOW() - make_interval(days => $2::int)`,
    [userId, CARD_RULES.dismissQuietDays],
  );
  const suppressed = new Set(quiet.map((r) => `${r.key}|${r.fp}`));

  const kept = [];
  for (const card of cards) {
    const fp = fingerprint([card.key, [...card.sources].sort(), card.title]);
    if (suppressed.has(`${card.key}|${fp}`)) continue;
    const data = { ...card.data, key: card.key, fingerprint: fp };
    await query(
      `INSERT INTO hedwig_insights (user_id, kind, period_start, period_end, title, body, data, sources, severity)
       VALUES ($1, 'card', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, (data->>'key'), period_start) WHERE kind = 'card'
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data,
                     sources = EXCLUDED.sources, severity = EXCLUDED.severity
        WHERE hedwig_insights.dismissed_at IS NULL`,
      [userId, periodStart, periodEnd, card.title, card.body, JSON.stringify(data), JSON.stringify(card.sources), card.severity],
    );
    kept.push(card.key);
  }
  await query(
    `DELETE FROM hedwig_insights
      WHERE user_id = $1 AND kind = 'card' AND period_start = $2 AND dismissed_at IS NULL
        AND NOT ((data->>'key') = ANY($3::text[]))`,
    [userId, periodStart, kept],
  );
  await setState(cardsStateKey(userId), { day: localDay(new Date(now), tz), periodStart: periodStart.toISOString() });
  return listCardsFor(userId, periodStart);
}

async function listCardsFor(userId, periodStart) {
  const { rows } = await query(
    `SELECT * FROM hedwig_insights
      WHERE user_id = $1 AND kind = 'card' AND period_start = $2 AND dismissed_at IS NULL
      ORDER BY CASE severity WHEN 'alert' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, created_at`,
    [userId, periodStart],
  );
  return rows.map(toInsight);
}

/** Today's undismissed cards, generating them first if today has not been generated yet. */
export async function listCards(userId, { now = Date.now() } = {}) {
  const cfg = await getConfig(userId);
  const tz = validTimezone(cfg['insights.timezone']);
  const state = await getState(cardsStateKey(userId), null);
  if (!state || state.day !== localDay(new Date(now), tz)) return generateCards(userId, { now });
  return listCardsFor(userId, new Date(state.periodStart));
}
