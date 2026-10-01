// SQL the People stream and the Brief share, in a module of its own so the Brief can use it
// without loading the work services (and the model calls behind them).

/**
 * SQL for C's People query: hide threads the user marked done (messages dated up to the moment
 * they did) and threads snoozed through Hedwig or sitting in upstream's Snoozed folder.
 * `m` is the messages alias, `s` the hedwig_sort alias (for user_id).
 */
export function peopleFilterSql(m = 'm', s = 's') {
  return `(COALESCE(${m}.folder, '') <> 'Snoozed' AND NOT EXISTS (
    SELECT 1 FROM hedwig_work_items w
     WHERE w.user_id = ${s}.user_id AND w.thread_key = ${m}.thread_key AND w.done_at IS NULL
       AND ((w.kind = 'done' AND (${m}.date IS NULL OR ${m}.date <= w.created_at)) OR (w.kind = 'snoozed' AND w.until > NOW()))))`;
}

/**
 * SQL: the thread is marked Done ($1 is the user id). With `date`, only when that message came
 * before the mark (newer mail shows the thread again even before the pipeline step reopens it).
 * Needs You, Waiting On and the Brief all ask this. The alias is its own, so a caller's `w`
 * (hedwig_work_waiting) cannot stand in for it.
 */
export const doneSql = (threadKey, date = null) => `EXISTS (SELECT 1 FROM hedwig_work_items dw
   WHERE dw.user_id = $1 AND dw.kind = 'done' AND dw.done_at IS NULL AND dw.thread_key = ${threadKey}${date ? `
     AND (${date} IS NULL OR ${date} <= dw.created_at)` : ''})`;

/**
 * Which items a Done mark on their thread takes away (doneSql with the item's date): $2 the items'
 * ids, $3 their thread keys, $4 their dates, $1 the user id. Rows of id.
 */
export const DONE_ITEMS_SQL = `SELECT x.id FROM UNNEST($2::text[], $3::text[], $4::timestamptz[]) AS x(id, thread_key, at)
  WHERE ${doneSql('x.thread_key', 'x.at')}`;
