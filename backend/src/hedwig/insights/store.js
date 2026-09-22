// hedwig_insights rows ↔ the API's Insight shape, plus the ownership filter every stored source
// list passes through.
import { query } from '../../services/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

export function toInsight(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body || '',
    data: row.data || {},
    sources: Array.isArray(row.sources) ? row.sources : [],
    severity: row.severity || 'info',
    created_at: row.created_at,
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    dismissed_at: row.dismissed_at || null,
  };
}

/** The subset of `ids` that are messages in this user's accounts. */
export async function ownedMessageIds(userId, ids) {
  const wanted = [...new Set((ids || []).filter(isUuid))];
  if (!wanted.length) return new Set();
  const { rows } = await query(
    `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
    [userId, wanted],
  );
  return new Set(rows.map((r) => r.id));
}

export async function insertInsight(userId, { kind, title, body = '', data = {}, sources = [], severity = 'info', periodStart = null, periodEnd = null }) {
  const { rows } = await query(
    `INSERT INTO hedwig_insights (user_id, kind, period_start, period_end, title, body, data, sources, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, kind, periodStart, periodEnd, String(title).slice(0, 300), body, JSON.stringify(data), JSON.stringify(sources), severity],
  );
  return toInsight(rows[0]);
}

export async function dismissInsight(userId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await query(
    'UPDATE hedwig_insights SET dismissed_at = COALESCE(dismissed_at, NOW()) WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rowCount > 0;
}

/** Undismissed automation results from the last `days` days, newest first. */
export async function recentAutomationResults(userId, { days = 7, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT * FROM hedwig_insights
      WHERE user_id = $1 AND kind = 'automation' AND dismissed_at IS NULL AND created_at > NOW() - make_interval(days => $2::int)
      ORDER BY created_at DESC LIMIT $3`,
    [userId, days, limit],
  );
  return rows.map(toInsight);
}
