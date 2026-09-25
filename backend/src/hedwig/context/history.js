// Analysis catch-up: mail inside a user's analysis window (analysis.historyDays) that the context
// steps never ran on. History older than pipeline.backfillDays gets only the cheap steps when the
// scanner first sees it, and widening the window brings in mail that was seen long ago. Newest
// first, one batch per user per run; hedwig_msg.topic_at marks a message done.
import { query } from '../../services/db.js';
import { analysisDays } from '../config.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { contextEnabled } from './entities.js';
import { runEmbedStep } from './embed.js';
import { runTopicsStep } from './topics.js';
import { runExtractStep } from './extract.js';

export async function analysisCatchUp({ limit = 50 } = {}) {
  const { rows: users } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  let done = 0;
  for (const { user_id: userId } of users) {
    const cfg = await contextEnabled(userId);
    if (!cfg) continue;
    // The five-minute gap leaves messages the scanner is still stepping through to the scanner. A
    // row whose topics or extract step failed is left alone, as the scanner leaves it.
    const { rows } = await query(
      `SELECT ${MESSAGE_COLUMNS}, h.embedded_at AS h_embedded_at
         FROM hedwig_msg h
         JOIN messages m ON m.id = h.message_id
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE h.user_id = $1 AND h.skip_reason IS NULL AND h.topic_at IS NULL AND m.is_deleted = false
          AND h.seen_at < NOW() - INTERVAL '5 minutes'
          AND (h.error IS NULL OR h.error !~ '(^|; )(topics|extract):')
          AND ($3::int = 0 OR m.date >= NOW() - make_interval(days => $3::int))
        ORDER BY m.date DESC NULLS LAST
        LIMIT $2`,
      [userId, limit, analysisDays(cfg)],
    );
    if (!rows.length) continue;
    await decorate(rows);
    try {
      await runEmbedStep(rows.filter((r) => !r.h_embedded_at));
    } catch (err) {
      // Topics need the vectors; try the whole batch again next run.
      console.warn(`[hedwig] analysis catch-up: embedding failed for ${userId}, retrying later:`, err.message);
      continue;
    }
    for (const [name, run] of [['topics', runTopicsStep], ['extract', runExtractStep]]) {
      try {
        await run(rows);
      } catch (err) {
        console.warn(`[hedwig] analysis catch-up: ${name} failed for a batch of ${rows.length}:`, err.message);
        await query(
          `UPDATE hedwig_msg SET error = LEFT(COALESCE(error || '; ', '') || $2, 1000) WHERE message_id = ANY($1::uuid[])`,
          [rows.map((r) => r.id), `${name}: ${err.message}`],
        ).catch(() => {});
      }
    }
    done += rows.length;
  }
  return done;
}
