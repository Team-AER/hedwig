// "Sort the past": how far history is indexed and sorted per account, what sorting found, and the
// senders waiting in the Screener with Hedwig's proposal, so a new user can accept them in one go.
// Reads A's coverage ledger, C's hedwig_sort and Screener proposals (sort/senders.js), and the spam
// rescue candidates. Writes nothing except through C's decide and the user's onboarding.done flag.
import { query } from '../../services/db.js';
import { getConfig, saveUserConfig } from '../config.js';
import { screenerList } from '../sort/senders.js';
import { decide } from '../sort/service.js';

/**
 * Pure assembly of the status from the query results.
 * @param {{ accounts: object[], sorted: Map<string, number>|object, summary: object, senders: object[],
 *           readyShare?: number, topSenders?: number, done?: boolean }} parts
 */
export function assembleStatus({ accounts, sorted, summary, senders, readyShare = 0.9, topSenders = 20, done = false }) {
  const sortedOf = (id) => (sorted instanceof Map ? sorted.get(id) : sorted?.[id]) || 0;
  const list = accounts.map((a) => {
    const indexed = Number(a.indexed) || 0;
    const total = Number(a.total) || 0;
    const n = sortedOf(a.account_id);
    const enabled = a.enabled !== false;
    const accountDone = enabled && Number(a.folders) > 0
      && (total === 0 || indexed >= total * readyShare)
      && (indexed === 0 || n >= indexed * readyShare);
    return {
      accountId: a.account_id,
      name: a.name || a.email_address || null,
      email: a.email_address || null,
      enabled,
      indexed,
      total,
      sorted: n,
      bodies: Number(a.bodies) || 0,
      done: accountDone,
    };
  });
  const top = [...senders]
    .sort((x, y) => (y.count - x.count) || String(x.key).localeCompare(String(y.key)))
    .slice(0, topSenders)
    .map((s) => ({
      key: s.key,
      scope: s.scope,
      display: s.display || s.address || s.key,
      count: s.count,
      proposed: s.proposed,
      reason: s.reason || null,
      confidence: s.confidence ?? null,
      inSpam: Boolean(s.inSpam),
    }));
  return {
    accounts: list,
    summary: {
      people: Number(summary?.people) || 0,
      reading: Number(summary?.reading) || 0,
      records: Number(summary?.records) || 0,
      spam: Number(summary?.spam) || 0,
      rescueCandidates: Number(summary?.rescue_candidates) || 0,
      senders: senders.length,
    },
    topSenders: top,
    // Disabled accounts are listed but do not hold "ready" back (they do not sync).
    ready: list.some((a) => a.enabled) && list.filter((a) => a.enabled).every((a) => a.done),
    done: Boolean(done),
  };
}

/** GET /onboarding/status */
export async function onboardingStatus(userId) {
  const cfg = await getConfig(userId);
  const [accounts, sorted, summary, screener] = await Promise.all([
    query(
      `SELECT a.id AS account_id, a.name, a.email_address, a.enabled,
              COALESCE(SUM(c.seen), 0)::int AS indexed, COALESCE(SUM(c.total), 0)::int AS total,
              COALESCE(SUM(c.bodies), 0)::int AS bodies, COUNT(c.folder)::int AS folders
         FROM email_accounts a LEFT JOIN hedwig_index_coverage c ON c.account_id = a.id
        WHERE a.user_id = $1
        GROUP BY a.id, a.name, a.email_address, a.enabled, a.sort_order, a.created_at
        ORDER BY a.sort_order NULLS LAST, a.created_at`,
      [userId],
    ),
    query('SELECT account_id, COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 GROUP BY account_id', [userId]),
    query(
      `SELECT COUNT(*) FILTER (WHERE s.stream = 'people')::int AS people,
              COUNT(*) FILTER (WHERE s.stream = 'reading')::int AS reading,
              COUNT(*) FILTER (WHERE s.stream = 'records')::int AS records,
              COUNT(*) FILTER (WHERE s.stream = 'spam')::int AS spam,
              COUNT(*) FILTER (WHERE s.spam = 'rescued' AND s.in_spam_folder)::int AS rescue_candidates
         FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
        WHERE s.user_id = $1 AND NOT s.own AND NOT m.is_deleted`,
      [userId],
    ),
    screenerList(userId),
  ]);
  return assembleStatus({
    accounts: accounts.rows,
    sorted: new Map(sorted.rows.map((r) => [r.account_id, Number(r.n) || 0])),
    summary: summary.rows[0] || {},
    senders: screener.senders || [],
    readyShare: cfg['onboarding.readyShare'],
    topSenders: cfg['onboarding.topSenders'],
    done: cfg['onboarding.done'],
  });
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * POST /onboarding/accept. `{ all: true }` accepts every current Screener proposal (C's decide);
 * `{ senders: [{ key, scope, decision }] }` decides the listed ones.
 */
export async function acceptProposals(userId, body = {}) {
  if (body.all === true || body.all === 'true') return decide(userId, { all: true });
  const senders = Array.isArray(body.senders) ? body.senders : null;
  if (!senders?.length) throw bad('all: true or senders: [{ key, scope, decision }] is required');
  if (senders.length > 500) throw bad('at most 500 senders at a time');
  let decided = 0; let moved = 0;
  const logIds = [];
  for (const s of senders) {
    const out = await decide(userId, { key: s?.key, scope: s?.scope || 'address', decision: s?.decision });
    decided += out.decided || 0;
    moved += out.moved || 0;
    if (out.logId) logIds.push(out.logId);
  }
  return { decided, moved, logIds };
}

/** POST /onboarding/dismiss: "Sort the past" is done for this user (`{ done: false }` reopens it). */
export async function dismissOnboarding(userId, body = {}) {
  const done = body.done !== false;
  await saveUserConfig(userId, { 'onboarding.done': done ? true : null });
  return { ok: true, done };
}
