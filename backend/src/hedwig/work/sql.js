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
