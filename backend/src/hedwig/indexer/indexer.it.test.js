// Coverage, chunking, embedding and retrieval over the seeded demo mailbox (scripts/hedwig-seed.mjs).
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/indexer
// Uses the built-in hash embeddings (HEDWIG_EMBEDDINGS_PROVIDER=hash in .env.hedwig-dev); no model,
// gateway or Tika calls. Resets only the demo user's index rows; removes the messages it adds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe.skipIf(!process.env.HEDWIG_IT)('index over the demo mailbox', () => {
  let query; let pool; let userId; let accountIds; let rows;
  let coverage; let store; let retrieveMod; let pipeline; let search;
  const added = [];

  const one = async (sql, params = [userId]) => (await query(sql, params)).rows[0];
  const addMessage = async ({ account = 'work', folder = 'INBOX', subject, body, daysAgo, from = 'someone@example.test' }) => {
    const acc = accountIds[account];
    const { rows: r } = await query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email, sender_email, to_addresses, date, snippet, body_text)
       VALUES ($1, (SELECT COALESCE(MAX(uid), 0) + 1 FROM messages WHERE account_id = $1), $2, $3, $4, 'Test Sender', $5, $5, '[]', NOW() - make_interval(days => $6), LEFT($7, 100), $7)
       RETURNING id`,
      [acc, folder, `<it-${Date.now()}-${Math.random()}@hedwig.test>`, subject, from, daysAgo, body],
    );
    added.push(r[0].id);
    return r[0].id;
  };
  const loadRows = async (where = '', params = []) => {
    const { rows: r } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS}, (f.special_use = '\\Junk' OR m.folder ~* '(^|/)(spam|junk)$') AS coverage_spam
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND m.is_deleted = false ${where} ORDER BY m.date DESC`,
      [userId, ...params],
    );
    return pipeline.decorate(r);
  };
  const markSeen = (list) => query(
    `INSERT INTO hedwig_msg (message_id, user_id, account_id, skip_reason)
     SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[]) ON CONFLICT (message_id) DO NOTHING`,
    [list.map((r) => r.id), list.map((r) => r.user_id), list.map((r) => r.account_id), list.map((r) => (r.coverage_spam ? 'spam' : null))],
  );
  const coverageRow = (folder, account = 'work') => one('SELECT * FROM hedwig_index_coverage WHERE account_id = $1 AND folder = $2', [accountIds[account], folder]);

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    const { invalidateConfigCache } = await import('../config.js');
    invalidateConfigCache();
    pipeline = await import('../pipeline.js');
    coverage = await import('./coverage.js');
    store = await import('./store.js');
    retrieveMod = await import('./retrieve.js');
    search = await import('../context/search.js');
    const u = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u.rows[0].id;
    const { rows: accs } = await query('SELECT id, email_address FROM email_accounts WHERE user_id = $1', [userId]);
    accountIds = {
      personal: accs.find((a) => a.email_address.includes('gmail')).id,
      work: accs.find((a) => a.email_address.includes('vantage')).id,
      domain: accs.find((a) => a.email_address.includes('prafiles')).id,
    };
    await query('DELETE FROM hedwig_index_coverage WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_index_msg WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_chunks WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_state WHERE key = $1', [`index.recipe.${userId}`]);
    // A spam-folder message, to check it is indexed but hidden from retrieval by default.
    await addMessage({ account: 'domain', folder: 'Junk', subject: 'Claim your crypto prize', body: 'Your wallet prize of 2.4 BTC is waiting. Verify your wallet now.', daysAgo: 1, from: 'prize@fast-crypto-win.example' });
    rows = await loadRows();
    await markSeen(rows);
  }, 60_000);

  afterAll(async () => {
    if (added.length) await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [added]);
    await query('DELETE FROM hedwig_index_coverage WHERE user_id = $1', [userId]).catch(() => {});
    await pool?.end();
  });

  it('creates one coverage row per included folder, flags the spam folder, and starts pending', async () => {
    await coverage.refreshCoverage({ accountIds: Object.values(accountIds) });
    const { rows: cov } = await query('SELECT folder, spam, state FROM hedwig_index_coverage WHERE account_id = $1 ORDER BY folder', [accountIds.domain]);
    expect(cov.map((r) => [r.folder, r.spam])).toEqual([['INBOX', false], ['Junk', true], ['Sent', false], ['Sent Items', false]]);
    const inbox = await coverageRow('INBOX');
    expect(inbox.state).toBe('running'); // seen, not chunked yet
    expect(inbox.total).toBeGreaterThan(10);
  });

  it('chunks every message (history included) with header lines and weighted tsvectors', async () => {
    const res = await store.indexMessages(rows);
    expect(res.messages).toBe(rows.length);
    const counts = await one(
      `SELECT COUNT(DISTINCT message_id)::int AS msgs, COUNT(*) FILTER (WHERE kind = 'header')::int AS headers,
              COUNT(*) FILTER (WHERE kind = 'body')::int AS bodies, COUNT(*) FILTER (WHERE kind = 'thread')::int AS threads,
              COUNT(*) FILTER (WHERE tsv IS NULL)::int AS no_tsv
         FROM hedwig_chunks WHERE user_id = $1`,
    );
    expect(counts.headers).toBe(rows.length);
    expect(counts.bodies).toBeGreaterThanOrEqual(rows.length - 1);
    expect(counts.no_tsv).toBe(0);
    expect(counts.threads).toBeGreaterThanOrEqual(3); // visa, marta, … threads with 2+ messages
    const oldest = await one(
      `SELECT c.text FROM hedwig_chunks c JOIN messages m ON m.id = c.message_id
        WHERE c.user_id = $1 AND c.kind = 'body' ORDER BY m.date ASC LIMIT 1`,
    );
    expect(oldest.text.split('\n')[0]).toMatch(/ · \d{4}-\d{2}-\d{2} · /);
    // Subject carries weight A, so a subject word ranks above the same word only in a body.
    const w = await one(
      "SELECT tsv::text AS tsv FROM hedwig_chunks WHERE user_id = $1 AND kind = 'body' AND text LIKE 'Invoice 2041%' LIMIT 1",
    );
    expect(w.tsv).toMatch(/'2041':\d+A/);
    // Signature split off Thomas Reed's mail and kept in the header chunk.
    const reedHeader = await one("SELECT text FROM hedwig_chunks WHERE user_id = $1 AND kind = 'header' AND text LIKE 'Sponsorship application – fees and timeline%' LIMIT 1");
    expect(reedHeader.text).toContain('Signature: Thomas Reed Reed Immigration Law');
  });

  it('embeds every chunk under the current recipe and reports the folder done', async () => {
    const n = await store.drain(() => store.embedPending({ maxChunks: 256 }), { budgetMs: 30_000, maxRounds: 50 });
    expect(n).toBeGreaterThan(0);
    const missing = await one(
      `SELECT COUNT(*)::int AS n FROM hedwig_chunks c WHERE c.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM hedwig_chunk_vectors v WHERE v.chunk_id = c.id)`,
    );
    expect(missing.n).toBe(0);
    await coverage.refreshCoverage({ accountIds: Object.values(accountIds) });
    const inbox = await coverageRow('INBOX');
    expect(inbox).toMatchObject({ state: 'done', error: null });
    expect(inbox.chunked).toBe(inbox.total - inbox.dupes);
    expect(inbox.embedded).toBe(inbox.chunked);
    const status = await retrieveMod.indexStatus(userId);
    expect(status.pending).toBe(0);
    expect(status.recipe).toMatchObject({ active: 'v1:hash-1024', target: 'v1:hash-1024', vectors: true });
    expect(status.coverage.find((c) => c.folder === 'INBOX' && c.accountId === accountIds.work).pct.embedded).toBe(100);
  });

  it('flips a done folder back when an old message syncs late (the pipeline.backfill bug)', async () => {
    const id = await addMessage({ subject: 'Pension statement 2024', body: 'Your annual pension statement is enclosed. Transfer value £12,400.', daysAgo: 800 });
    await coverage.refreshCoverage({ accountIds: Object.values(accountIds) });
    const inbox = await coverageRow('INBOX');
    expect(inbox.state).toBe('running');
    expect(inbox.seen).toBe(inbox.total - 1);
    // The scanner finds it by absence: no hedwig_msg row, in a folder with work, whatever its age.
    const due = await one(
      `SELECT m.id FROM messages m JOIN hedwig_index_coverage c ON c.account_id = m.account_id AND c.folder = m.folder
        LEFT JOIN hedwig_msg h ON h.message_id = m.id
        WHERE c.user_id = $1 AND c.state IN ('pending','running') AND h.message_id IS NULL AND m.is_deleted = false
        ORDER BY m.date DESC NULLS LAST LIMIT 1`,
    );
    expect(due.id).toBe(id);
    const fresh = await loadRows('AND m.id = $2', [id]);
    await markSeen(fresh);
    expect(await store.chunkPending({ limit: 50 })).toBeGreaterThanOrEqual(1);
    await store.embedPending({ maxChunks: 64 });
    await coverage.refreshCoverage({ accountIds: Object.values(accountIds) });
    expect((await coverageRow('INBOX')).state).toBe('done');
  });

  it('re-chunks a message when its body arrives after a header-only sync', async () => {
    const id = await addMessage({ subject: 'Boiler service booking', body: 'x', daysAgo: 2 });
    await query('UPDATE messages SET body_text = NULL, snippet = $2 WHERE id = $1', [id, 'Engineer visit confirmed']);
    const r1 = await loadRows('AND m.id = $2', [id]);
    await markSeen(r1);
    await store.indexMessages(r1);
    expect((await one('SELECT had_body FROM hedwig_index_msg WHERE message_id = $1', [id])).had_body).toBe(false);
    await query("UPDATE messages SET body_text = 'The engineer will arrive Thursday between 8 and 12 to service the boiler.' WHERE id = $1", [id]);
    expect(await store.chunkPending({ limit: 50 })).toBeGreaterThanOrEqual(1);
    const body = await one("SELECT text FROM hedwig_chunks WHERE message_id = $1 AND kind = 'body'", [id]);
    expect(body.text).toContain('Thursday between 8 and 12');
  });

  it('retrieves by meaning and keywords with filters, hides spam unless asked, and expands threads', async () => {
    const res = await retrieveMod.retrieve({ userId, query: 'visa sponsorship documents', limit: 8 });
    expect(res.chunks.length).toBeGreaterThan(0);
    const top = await one('SELECT subject, thread_key FROM messages WHERE id = $1', [res.chunks[0].messageId]);
    expect(top.subject).toMatch(/visa|sponsorship/i);
    expect(res.chunks[0]).toMatchObject({ kind: expect.any(String), score: expect.any(Number) });
    expect(res.chunks.some((c) => c.ftsRank && c.vecRank)).toBe(true);

    const reed = await retrieveMod.retrieve({ userId, query: 'fee timeline', filters: { people: ['thomas@reedlaw.example'] }, limit: 5, expandThreads: false });
    expect(reed.chunks.length).toBeGreaterThan(0);
    const senders = await query('SELECT DISTINCT from_email FROM messages WHERE id = ANY($1::uuid[])', [reed.chunks.map((c) => c.messageId)]);
    expect(senders.rows.map((r) => r.from_email)).toEqual(['thomas@reedlaw.example']);

    const att = await retrieveMod.retrieve({ userId, query: 'passport degree', filters: { hasAttachment: true }, limit: 5, expandThreads: false });
    const hasAtt = await query('SELECT bool_and(has_attachments) AS all FROM messages WHERE id = ANY($1::uuid[])', [att.chunks.map((c) => c.messageId)]);
    expect(hasAtt.rows[0].all).toBe(true);

    const inThread = await retrieveMod.retrieve({ userId, query: 'passport', filters: { threadId: top.thread_key }, limit: 5, expandThreads: false });
    expect(inThread.chunks.every((c) => c.threadId === top.thread_key)).toBe(true);

    const spam = await retrieveMod.retrieve({ userId, query: 'crypto wallet prize', limit: 10, expandThreads: false });
    const spamRescue = await retrieveMod.retrieve({ userId, query: 'crypto wallet prize', filters: { includeSpam: true, folders: ['Junk'] }, limit: 10, expandThreads: false });
    expect(spam.chunks.some((c) => c.messageId === added[0])).toBe(false);
    expect(spamRescue.chunks.some((c) => c.messageId === added[0])).toBe(true);

    const expanded = await retrieveMod.retrieve({ userId, query: 'passport scan degree certificate attached', limit: 3, expandThreads: true });
    expect(expanded.chunks.some((c) => c.expandedFrom)).toBe(true);

    const stranger = await retrieveMod.retrieve({ userId: '00000000-0000-4000-8000-000000000000', query: 'visa sponsorship' });
    expect(stranger.chunks).toEqual([]);
  });

  it('context search and the search_mail tool go through the index', async () => {
    const { results } = await search.searchMessages(userId, { q: 'visa sponsorship documents', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].subject).toMatch(/visa|sponsorship/i);
    const { registerContextTools } = await import('../context/tools.js');
    const { getTool, _resetTools } = await import('../agent/toolRegistry.js');
    _resetTools?.();
    try { registerContextTools(); } catch { /* already registered */ }
    const out = await getTool('search_mail').handler({ query: 'fees and timeline', person: 'thomas@reedlaw.example', limit: 5 }, { userId });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].from).toContain('thomas@reedlaw.example');
    expect(out.results[0].excerpt).toBeTruthy();
  });

  it("the body reconcile finds each message's job through an index, not a scan of hedwig_jobs", async () => {
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off'); // the dev tables are tiny; ask whether an index is usable at all
      const { rows: plan } = await client.query(
        `EXPLAIN SELECT x.message_id, j.done_at FROM hedwig_index_msg x
           LEFT JOIN LATERAL (SELECT done_at, failed_at, last_error FROM hedwig_jobs
                               WHERE dedupe_key = 'body:' || x.message_id::text ORDER BY id DESC LIMIT 1) j ON true
          WHERE x.body_state = 'requested'`,
      );
      const text = plan.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('hedwig_jobs_dedupe_key_idx');
      expect(text).not.toMatch(/Seq Scan on hedwig_jobs/);
    } finally {
      await client.query('RESET enable_seqscan').catch(() => {});
      client.release();
    }
  });
});
