// Bundles: groups inside Reading and Records, each with a delivery schedule. Default bundles are
// seeded per user; custom ones are made from a description (sort.bundleDescribe). Messages in a
// scheduled bundle are held (hedwig_sort.held) until the bundle is delivered by the worker.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { validTimezone, zonedParts, zonedToUtc, addDays, parseClock } from '../insights/time.js';
import { runSortPrompt } from './deps.js';
import { writeLog } from './log.js';

export const DEFAULT_BUNDLES = Object.freeze([
  { key: 'purchases', name: 'Purchases', stream: 'records', schedule: { mode: 'instant' },
    hint: 'Receipts, order confirmations and invoices for things you bought',
    keywords: ['receipt', 'order confirmation', 'order #', 'invoice', 'purchase', 'thanks for your order', 'payment received', 'total paid'] },
  { key: 'finance', name: 'Finance', stream: 'records', schedule: { mode: 'instant' },
    hint: 'Bank, card and investment statements, bills, tax and payment notices',
    keywords: ['statement', 'bank', 'balance', 'direct debit', 'payment due', 'bill', 'tax', 'credit card', 'transaction', 'pension', 'hmrc'] },
  { key: 'travel', name: 'Travel', stream: 'records', schedule: { mode: 'instant' },
    hint: 'Flights, trains, hotels, car hire, boarding passes and itineraries',
    keywords: ['flight', 'boarding pass', 'itinerary', 'booking', 'reservation', 'hotel', 'check-in', 'train', 'e-ticket', 'airline'] },
  { key: 'deliveries', name: 'Deliveries', stream: 'records', schedule: { mode: 'instant' },
    hint: 'Shipping and delivery updates for parcels',
    keywords: ['shipped', 'dispatched', 'out for delivery', 'delivered', 'tracking', 'parcel', 'package', 'courier', 'arriving'] },
  { key: 'social', name: 'Social', stream: 'records', schedule: { mode: 'daily', at: '17:00' },
    hint: 'Notifications from social networks and community sites',
    keywords: ['linkedin', 'facebook', 'instagram', 'mentioned you', 'new follower', 'connection request', 'appeared in', 'liked your'] },
  { key: 'updates', name: 'Updates', stream: 'reading', schedule: { mode: 'daily', at: '08:00' },
    hint: 'Newsletters, product news and digests from services you use',
    keywords: ['newsletter', 'digest', "what's new", 'weekly', 'this week', 'product update', 'release notes', 'roundup'] },
  { key: 'promotions', name: 'Promotions', stream: 'reading', schedule: { mode: 'weekly', day: 6, at: '09:00' },
    hint: 'Marketing, offers, sales and discounts',
    keywords: ['% off', 'sale', 'offer', 'discount', 'deal', 'limited time', 'promo', 'coupon', 'free shipping', 'auction'] },
  { key: 'forums', name: 'Forums', stream: 'reading', schedule: { mode: 'daily', at: '17:00' },
    hint: 'Mailing lists, forums, issue trackers and group discussions',
    keywords: ['mailing list', 'forum', 'thread', 'discussion', 'new issue', 'pull request', 'commented', 'ci failed', 'digest for'] },
  { key: 'calendar', name: 'Calendar', stream: 'records', schedule: { mode: 'instant' },
    hint: 'Meeting invitations, event updates and calendar notifications',
    keywords: ['invitation', 'invite', 'accepted', 'declined', 'meeting', 'event', 'calendar', 'rsvp', '.ics'] },
]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Normalise a schedule; throws 400 on nonsense. */
export function normaliseSchedule(s) {
  const mode = s?.mode || 'instant';
  if (mode === 'instant') return { mode };
  const clock = parseClock(s?.at);
  if (!clock) throw httpError(400, 'schedule.at must be HH:MM');
  const at = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  if (mode === 'daily') return { mode, at };
  if (mode === 'weekly') {
    const day = Number(s?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw httpError(400, 'schedule.day must be 0 (Sunday) to 6');
    return { mode, day, at };
  }
  throw httpError(400, 'schedule.mode must be instant, daily or weekly');
}

export const isScheduled = (schedule) => Boolean(schedule && schedule.mode && schedule.mode !== 'instant');

/**
 * The most recent delivery slot at or before `now` for a scheduled bundle, in the user's zone.
 * Null for instant bundles.
 */
export function lastSlot(schedule, now = new Date(), tz = 'UTC') {
  if (!isScheduled(schedule)) return null;
  const zone = validTimezone(tz);
  const clock = parseClock(schedule.at) || { hour: 8, minute: 0 };
  const p = zonedParts(now, zone);
  let day = { year: p.year, month: p.month, day: p.day };
  for (let i = 0; i < 8; i++) {
    const at = zonedToUtc({ ...day, hour: clock.hour, minute: clock.minute }, zone);
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    if (at <= now && (schedule.mode === 'daily' || weekday === schedule.day)) return at;
    day = addDays(day, -1);
  }
  return null;
}

/** Due for delivery: a slot has passed since the last delivery. */
export function isDue(schedule, lastDeliveredAt, now = new Date(), tz = 'UTC') {
  const slot = lastSlot(schedule, now, tz);
  if (!slot) return false;
  return !lastDeliveredAt || new Date(lastDeliveredAt) < slot;
}

const kwCache = new Map();
/** Whole-word keyword test ("this week" must not match "this weekend"). */
export function hasKeyword(hay, keyword) {
  const k = String(keyword || '').toLowerCase();
  if (!k) return false;
  let re = kwCache.get(k);
  if (!re) {
    const body = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pre = /^[\p{L}\p{N}]/u.test(k) ? '(?<![\\p{L}\\p{N}])' : '';
    const post = /[\p{L}\p{N}]$/u.test(k) ? '(?![\\p{L}\\p{N}])' : '';
    re = new RegExp(`${pre}${body}${post}`, 'u');
    if (kwCache.size < 5000) kwCache.set(k, re);
  }
  return re.test(hay);
}

/**
 * The bundle a message most likely belongs to, by keyword hits in sender, subject and text.
 * @returns {string|null} bundle key
 */
export function guessBundle({ row, text = '', stream = null, prior = null }, bundles) {
  if (prior?.bundle && bundles.some((b) => b.key === prior.bundle)) return prior.bundle;
  const hay = `${row?.from_name || ''} ${row?.from_email || ''} ${row?.subject || ''} ${String(text).slice(0, 1500)}`.toLowerCase();
  let best = null;
  for (const b of bundles) {
    if (b.enabled === false) continue;
    if (stream && b.stream && b.stream !== stream) continue;
    const kws = Array.isArray(b.keywords) ? b.keywords : [];
    const hits = kws.filter((k) => hasKeyword(hay, k)).length;
    if (hits && (!best || hits > best.hits)) best = { key: b.key, hits };
  }
  return best?.key || null;
}

// ── Storage ─────────────────────────────────────────────────────────────────

const BUNDLE_COLUMNS = 'id, key, name, description, hint, keywords, stream, schedule, builtin, enabled, position, last_delivered_at';

/** Seed the default bundles for a user (idempotent). */
export async function ensureBundles(userId) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM hedwig_bundles WHERE user_id = $1 AND builtin', [userId]);
  if (rows[0].n >= DEFAULT_BUNDLES.length) return;
  for (const [i, b] of DEFAULT_BUNDLES.entries()) {
    await query(
      `INSERT INTO hedwig_bundles (user_id, key, name, description, hint, keywords, stream, schedule, builtin, position, last_delivered_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, true, $8, NOW()) ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, b.key, b.name, b.hint, JSON.stringify(b.keywords), b.stream, JSON.stringify(b.schedule), (i + 1) * 10],
    );
  }
}

export async function loadBundles(userId) {
  await ensureBundles(userId);
  const { rows } = await query(`SELECT ${BUNDLE_COLUMNS} FROM hedwig_bundles WHERE user_id = $1 ORDER BY position, name`, [userId]);
  return rows;
}

export async function listBundles(userId) {
  const bundles = await loadBundles(userId);
  const { rows: counts } = await query(
    `SELECT bundle, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE held)::int AS held
       FROM hedwig_sort WHERE user_id = $1 AND bundle IS NOT NULL AND NOT own GROUP BY bundle`,
    [userId],
  );
  const by = new Map(counts.map((c) => [c.bundle, c]));
  return { bundles: bundles.map((b) => ({ ...b, count: by.get(b.key)?.total || 0, held: by.get(b.key)?.held || 0 })) };
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);
}

/**
 * Create a custom bundle from a description. The Reflex model turns the description into a hint
 * and keywords; without a model the description itself becomes the hint.
 */
export async function createBundle(userId, { name, description, schedule, stream }) {
  const n = String(name || '').trim().slice(0, 60);
  const d = String(description || '').trim().slice(0, 500);
  if (!n) throw httpError(400, 'name is required');
  if (!d) throw httpError(400, 'description is required: say what mail belongs in this bundle');
  const sched = normaliseSchedule(schedule || { mode: 'instant' });
  const existing = await loadBundles(userId);
  if (existing.length >= 50) throw httpError(409, 'At most 50 bundles');
  let described = null;
  let provenance = null;
  try {
    const out = await runSortPrompt('sort.bundleDescribe', { name: n, description: d, existing: existing.map((b) => b.key) }, { userId, lane: 'interactive' });
    described = out.data;
    provenance = out.provenance;
  } catch (err) {
    console.warn(`[hedwig] sort: bundle description model call failed, using the description as the hint: ${err.message}`);
  }
  let key = slugify(described?.key) || slugify(n) || `bundle-${existing.length + 1}`;
  const taken = new Set(existing.map((b) => b.key));
  for (let i = 2; taken.has(key); i++) key = `${slugify(described?.key || n)}-${i}`;
  const keywords = (Array.isArray(described?.keywords) ? described.keywords : d.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))
    .map((k) => String(k).toLowerCase().trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  const hint = String(described?.hint || d).slice(0, 200);
  const st = ['reading', 'records'].includes(stream) ? stream : (['reading', 'records'].includes(described?.stream) ? described.stream : 'records');
  const position = Math.max(0, ...existing.map((b) => b.position)) + 10;
  const { rows } = await query(
    `INSERT INTO hedwig_bundles (user_id, key, name, description, hint, keywords, stream, schedule, builtin, position, last_delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, NOW()) RETURNING ${BUNDLE_COLUMNS}`,
    [userId, key, n, d, hint, JSON.stringify(keywords), st, JSON.stringify(sched), position],
  );
  return { bundle: rows[0], promptId: provenance?.promptId || null, promptVersion: provenance?.promptVersion || null, model: provenance?.model || null };
}

export async function updateBundle(userId, id, { name, schedule, enabled, hint, keywords }) {
  const sets = [];
  const params = [id, userId];
  const set = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (name !== undefined) set('name', String(name).trim().slice(0, 60));
  if (schedule !== undefined) set('schedule', JSON.stringify(normaliseSchedule(schedule)));
  if (enabled !== undefined) set('enabled', Boolean(enabled));
  if (hint !== undefined) set('hint', String(hint).slice(0, 200));
  if (keywords !== undefined) set('keywords', JSON.stringify((Array.isArray(keywords) ? keywords : []).map((k) => String(k).slice(0, 40)).slice(0, 20)));
  if (!sets.length) throw httpError(400, 'nothing to change');
  const { rows } = await query(`UPDATE hedwig_bundles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING ${BUNDLE_COLUMNS}`, params);
  if (!rows[0]) throw httpError(404, 'Bundle not found');
  // Switching to instant releases whatever was waiting.
  if (!isScheduled(rows[0].schedule)) await deliverBundle(userId, rows[0]);
  return rows[0];
}

/** Release every held message of one bundle and record the delivery. */
export async function deliverBundle(userId, bundle, now = new Date()) {
  const { rows } = await query(
    `UPDATE hedwig_sort SET held = false WHERE user_id = $1 AND bundle = $2 AND held RETURNING message_id`,
    [userId, bundle.key],
  );
  await query('UPDATE hedwig_bundles SET last_delivered_at = $2 WHERE id = $1', [bundle.id, now]);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.message_id);
  await query('INSERT INTO hedwig_bundle_deliveries (bundle_id, user_id, delivered_at, message_ids) VALUES ($1, $2, $3, $4::uuid[])', [bundle.id, userId, now, ids]);
  await writeLog(userId, { action: 'deliver', to: { bundle: bundle.key, name: bundle.name, count: ids.length }, by: 'auto' });
  return ids.length;
}

/** Worker tick: deliver every scheduled bundle whose slot has passed. */
export async function releaseDueBundles(now = new Date()) {
  const { rows } = await query(
    `SELECT b.id, b.user_id, b.key, b.name, b.schedule, b.last_delivered_at
       FROM hedwig_bundles b
      WHERE b.enabled AND b.schedule->>'mode' IN ('daily','weekly')
        AND EXISTS (SELECT 1 FROM hedwig_sort s WHERE s.user_id = b.user_id AND s.bundle = b.key AND s.held)`,
  );
  let delivered = 0;
  const tzCache = new Map();
  for (const b of rows) {
    if (!tzCache.has(b.user_id)) tzCache.set(b.user_id, (await getConfig(b.user_id))['insights.timezone']);
    if (!isDue(b.schedule, b.last_delivered_at, now, tzCache.get(b.user_id))) continue;
    try {
      delivered += await deliverBundle(b.user_id, b, now);
    } catch (err) {
      console.warn(`[hedwig] sort: delivering bundle ${b.key} for ${b.user_id} failed:`, err.message);
    }
  }
  return delivered;
}
