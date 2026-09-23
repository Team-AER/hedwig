// In-memory stand-in for the hedwig_jobs statements jobs.js issues, for unit tests that mock
// services/db.js. Not a SQL engine: each branch matches one statement. The real SQL is exercised by
// ledger/runtime.it.test.js against the dev database.
export function createFakeJobsDb() {
  const state = { rows: [], nextId: 1, now: Date.now(), calls: [] };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const active = (r) => !r.done_at && !r.failed_at;
  const iso = (ms) => ms;

  async function query(sql, params = []) {
    const s = norm(sql);
    state.calls.push({ sql: s, params });
    const now = state.now;
    const byId = (id) => state.rows.find((r) => r.id === Number(id));

    if (s.startsWith('INSERT INTO hedwig_jobs')) {
      const [kind, payload, userId, dedupeKey, runAt, priority, maxAttempts] = params;
      if (dedupeKey && state.rows.some((r) => r.dedupe_key === dedupeKey && active(r))) return { rows: [] };
      const row = {
        id: state.nextId++, kind, payload: JSON.parse(payload), user_id: userId, dedupe_key: dedupeKey,
        run_at: runAt ?? now, priority, max_attempts: maxAttempts, attempts: 0, locked_at: null, locked_by: null,
        last_error: null, created_at: now, done_at: null, failed_at: null, status: 'queued', tokens_in: 0, tokens_out: 0, note: null,
      };
      state.rows.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (s.startsWith('UPDATE hedwig_jobs j SET locked_at = NOW()')) {
      const [kinds, limit, worker, lockSecs] = params;
      const lock = JSON.parse(lockSecs);
      const ready = state.rows
        .filter((r) => active(r) && r.run_at <= now && kinds.includes(r.kind) && (!r.locked_at || r.locked_at < now - lock[r.kind] * 1000))
        .sort((a, b) => a.priority - b.priority || a.run_at - b.run_at)
        .slice(0, limit);
      for (const r of ready) Object.assign(r, { locked_at: now, locked_by: worker, attempts: r.attempts + 1, status: 'running' });
      return { rows: ready.map((r) => ({ ...r })) };
    }
    if (s.startsWith('UPDATE hedwig_jobs SET locked_at = locked_at + make_interval')) {
      const [id, sec] = params;
      const r = byId(id);
      if (r && r.locked_at && active(r)) { r.locked_at += Number(sec) * 1000; return { rowCount: 1 }; }
      return { rowCount: 0 };
    }
    if (s.startsWith('UPDATE hedwig_jobs SET done_at = NOW()')) {
      const [id, status, note, tin, tout] = params;
      Object.assign(byId(id), { done_at: now, locked_at: null, last_error: null, status, note });
      byId(id).tokens_in += tin; byId(id).tokens_out += tout;
      return { rowCount: 1 };
    }
    if (s.includes("status = 'queued', tokens_in = tokens_in + $3") && s.includes('date_trunc')) { // budget
      const [id, msg, tin, tout] = params;
      const r = byId(id);
      Object.assign(r, { locked_at: null, attempts: Math.max(r.attempts - 1, 0), last_error: msg, status: 'queued', run_at: now + 86_400_000 });
      r.tokens_in += tin; r.tokens_out += tout;
      return { rowCount: 1 };
    }
    if (s.startsWith('UPDATE hedwig_jobs SET failed_at = NOW(), locked_at = NULL')) {
      const [id, msg, tin, tout] = params;
      const r = byId(id);
      Object.assign(r, { failed_at: now, locked_at: null, last_error: msg, status: 'failed' });
      r.tokens_in += tin; r.tokens_out += tout;
      return { rowCount: 1 };
    }
    if (s.startsWith("UPDATE hedwig_jobs SET locked_at = NULL, last_error = $2, status = 'queued', run_at = NOW() + ($3 || ' seconds')")) {
      const [id, msg, sec, tin, tout] = params;
      const r = byId(id);
      Object.assign(r, { locked_at: null, last_error: msg, status: 'queued', run_at: now + Number(sec) * 1000 });
      r.tokens_in += tin; r.tokens_out += tout;
      return { rowCount: 1 };
    }
    if (s.startsWith("UPDATE hedwig_jobs SET locked_at = NULL, attempts = GREATEST(attempts - 1, 0), status = 'queued', last_error = $2, run_at = NOW() + ($3 || ' minutes')")) {
      const [id, msg, min] = params;
      const r = byId(id);
      Object.assign(r, { locked_at: null, attempts: Math.max(r.attempts - 1, 0), status: 'queued', last_error: msg, run_at: now + Number(min) * 60_000 });
      return { rowCount: 1 };
    }
    if (s.startsWith("UPDATE hedwig_jobs SET run_at = NOW() + ($2 || ' minutes')::interval, last_error = $3")) {
      const [kinds, min, msg] = params;
      const until = now + Number(min) * 60_000;
      const hit = state.rows.filter((r) => active(r) && !r.locked_at && r.run_at <= until && kinds.includes(r.kind));
      for (const r of hit) Object.assign(r, { run_at: until, last_error: msg });
      return { rowCount: hit.length };
    }
    if (s.startsWith("UPDATE hedwig_jobs f SET status = 'resolved', note = 'a later run succeeded'")) {
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const hit = state.rows.filter((f) => f.status === 'failed' && state.rows.some((o) => o.kind === f.kind && o.id !== f.id
        && ['done', 'partial'].includes(o.status) && o.done_at > f.failed_at
        && ((f.dedupe_key && o.dedupe_key === f.dedupe_key) || ((o.user_id ?? null) === (f.user_id ?? null) && same(o.payload, f.payload)))));
      for (const r of hit) Object.assign(r, { status: 'resolved', note: 'a later run succeeded' });
      return { rowCount: hit.length };
    }
    if (s.startsWith('SELECT id, kind, payload, user_id, dedupe_key, priority, max_attempts, failed_at FROM hedwig_jobs WHERE status = \'failed\'')) {
      const [kind] = params;
      return { rows: state.rows.filter((r) => r.status === 'failed' && (kind == null || r.kind === kind)).map((r) => ({ ...r })) };
    }
    if (s.startsWith('UPDATE hedwig_jobs SET status = $2, note = COALESCE($3, note) WHERE id = ANY($1::bigint[])')) {
      const [ids, status, note] = params;
      const hit = state.rows.filter((r) => ids.includes(r.id) && r.status === 'failed');
      for (const r of hit) Object.assign(r, { status, note: note ?? r.note });
      return { rowCount: hit.length };
    }
    if (s.startsWith('UPDATE hedwig_jobs SET locked_at = NULL, locked_by = NULL, status = CASE')) {
      const [timeouts, reapMin] = params;
      const t = JSON.parse(timeouts);
      const hit = state.rows.filter((r) => active(r) && r.locked_at && r.locked_at < now - (t[r.kind] ?? reapMin * 60) * 1000);
      for (const r of hit) {
        const dead = r.attempts >= r.max_attempts;
        Object.assign(r, { locked_at: null, locked_by: null, status: dead ? 'failed' : 'queued', failed_at: dead ? now : null, last_error: 'stuck: running past its timeout; requeued by the reaper' });
      }
      return { rowCount: hit.length };
    }
    if (/hedwig_ai_calls|system_settings|hedwig_user_settings/.test(s)) return { rows: [] };
    throw new Error(`fakeJobsDb: unhandled statement: ${s.slice(0, 120)}`);
  }

  return { state, query, iso, advance(ms) { state.now += ms; }, row: (id) => state.rows.find((r) => r.id === id) };
}
