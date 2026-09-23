// Body and attachment acquisition. Every included message gets its body fetched, not only the ones
// someone opens, through the existing API-side `mail.fetchBody` job (core/bodies.js), newest first
// and spaced per mail host at `index.bodyRatePerSec` (or `index.bodyRateByProvider`, 0.5/s for
// Yahoo by default). imapflow fetches body parts with BODY.PEEK, so this never marks mail as read.
// Attachment text goes through Apache Tika from an API-side job that fetches the parts with
// imapManager.fetchMultipleAttachments (same PEEK path). Both fetches yield to mail sync
// (core/mailYield.js): deferred while the account syncs or cools down, one in flight per account,
// per-account backoff on refusals; accounts in that backoff get no new requests here. Failures are
// recorded per message (hedwig_index_msg) and summed into the coverage row.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { BODY_JOB, ATTACHMENT_JOB, FETCH_KINDS, bodyRateFor, providerOf, fetchBackoffs, guardedFetch } from '../core/mailYield.js';

export { ATTACHMENT_JOB };
const RATE_KINDS = FETCH_KINDS;
const HORIZON_SEC = 60; // never schedule more than a minute of fetches ahead per host
const LIVE_MS = 3 * 86400_000;

// ── Per-host rate slots ──────────────────────────────────────────────────────

/**
 * Plan run times for new fetches on one host: `rate` per second, after whatever is already queued,
 * at most `horizonSec` ahead. Pure; exported for tests.
 * @returns {Date[]} one run time per granted request (possibly fewer than `want`)
 */
export function planSlots({ now = Date.now(), queuedUntil = null, queuedCount = 0, rate, want, horizonSec = HORIZON_SEC }) {
  const step = 1000 / Math.max(0.01, rate);
  // If nothing is consuming the queue (API process down), stop adding once two horizons are waiting.
  want = Math.min(want, Math.max(0, Math.ceil(rate * horizonSec * 2) - queuedCount));
  let at = Math.max(now, queuedUntil ? new Date(queuedUntil).getTime() + step : now);
  const limit = now + horizonSec * 1000;
  const out = [];
  while (out.length < want && at <= limit) {
    out.push(new Date(at));
    at += step;
  }
  return out;
}

/** Accounts whose per-account fetch backoff is still running: Set of account ids. */
async function accountsBackingOff(now) {
  const out = new Set();
  for (const [accountId, b] of await fetchBackoffs()) {
    if (b?.until && new Date(b.until).getTime() > now) out.add(accountId);
  }
  return out;
}

/** Rows grouped by host, with each host's fetch rate. */
function groupByHost(rows, cfg) {
  const byHost = new Map();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, { rate: bodyRateFor(cfg, { host: r.host, provider: providerOf(r) }), list: [] });
    byHost.get(r.host).list.push(r);
  }
  return byHost;
}

async function queuedUntilByHost() {
  const { rows } = await query(
    `SELECT payload->>'host' AS host, MAX(run_at) AS until, COUNT(*)::int AS n FROM hedwig_jobs
      WHERE kind = ANY($1::text[]) AND done_at IS NULL AND failed_at IS NULL AND payload ? 'host'
      GROUP BY 1`,
    [RATE_KINDS],
  );
  return new Map(rows.map((r) => [r.host, { until: r.until, n: r.n }]));
}

// ── Bodies ───────────────────────────────────────────────────────────────────

/** Settle 'requested' rows from the outcome of their job: body arrived, empty, or failed. */
export async function reconcileBodies() {
  const { rows } = await query(
    `SELECT x.message_id, x.body_attempts,
            (m.body_text IS NOT NULL OR m.body_html IS NOT NULL) AS has_body,
            j.done_at, j.failed_at, j.last_error, x.body_requested_at
       FROM hedwig_index_msg x
       JOIN messages m ON m.id = x.message_id
       LEFT JOIN LATERAL (SELECT done_at, failed_at, last_error FROM hedwig_jobs
                           WHERE dedupe_key = 'body:' || x.message_id::text ORDER BY id DESC LIMIT 1) j ON true
      WHERE x.body_state = 'requested' AND x.body_requested_at < NOW() - INTERVAL '30 seconds'
      LIMIT 1000`,
  );
  const ok = [];
  const empty = [];
  const failed = [];
  const lost = [];
  for (const r of rows) {
    if (r.has_body) ok.push(r.message_id);
    else if (r.failed_at) failed.push({ id: r.message_id, error: r.last_error || 'body fetch failed' });
    else if (r.done_at) empty.push(r.message_id);
    else if (!r.done_at && !r.failed_at && r.body_requested_at < new Date(Date.now() - 86400_000)) lost.push(r.message_id);
  }
  if (ok.length) await query('UPDATE hedwig_index_msg SET body_state = NULL, body_error = NULL, updated_at = NOW() WHERE message_id = ANY($1::uuid[])', [ok]);
  if (empty.length) {
    await query(
      `UPDATE hedwig_index_msg SET body_state = 'empty', body_error = 'the server returned no body', updated_at = NOW()
        WHERE message_id = ANY($1::uuid[])`,
      [empty],
    );
  }
  for (const f of failed) {
    await query("UPDATE hedwig_index_msg SET body_state = 'failed', body_error = LEFT($2, 500), updated_at = NOW() WHERE message_id = $1", [f.id, f.error]);
  }
  // A request whose job vanished (pruned, or deduplicated into a job that finished long ago) is asked again.
  if (lost.length) await query('UPDATE hedwig_index_msg SET body_state = NULL, updated_at = NOW() WHERE message_id = ANY($1::uuid[])', [lost]);
  return { ok: ok.length, empty: empty.length, failed: failed.length, lost: lost.length };
}

/**
 * Request bodies for included messages that have none, newest first, spaced per host. Messages the
 * server returned empty are retried up to three times with growing gaps.
 */
export async function requestBodies({ now = Date.now(), candidates = 500 } = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled) return 0;
  const maxAge = cfg['index.bodyMaxAgeDays'];
  const { rows: found } = await query(
    `SELECT m.id, m.account_id, a.user_id, m.date, m.thread_key, lower(COALESCE(a.imap_host, a.id::text)) AS host, a.imap_host, a.oauth_provider, x.body_attempts
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.enabled = true
       JOIN hedwig_index_coverage c ON c.account_id = m.account_id AND c.folder = m.folder AND c.state <> 'paused'
       LEFT JOIN hedwig_index_msg x ON x.message_id = m.id
      WHERE m.is_deleted = false AND m.body_text IS NULL AND m.body_html IS NULL
        AND (x.message_id IS NULL OR x.body_state IS NULL
             OR (x.body_state = 'empty' AND x.body_attempts < 3
                 AND x.body_requested_at < NOW() - make_interval(hours => x.body_attempts)))
        AND ($2::int = 0 OR m.date >= NOW() - make_interval(days => $2::int))
      ORDER BY m.date DESC NULLS LAST
      LIMIT $1`,
    [candidates, maxAge],
  );
  if (!found.length) return 0;
  const backingOff = await accountsBackingOff(now);
  const rows = found.filter((r) => !backingOff.has(String(r.account_id)));
  if (!rows.length) return 0;
  const queued = await queuedUntilByHost();
  const granted = [];
  for (const [host, { rate, list }] of groupByHost(rows, cfg)) {
    const slots = planSlots({ now, queuedUntil: queued.get(host)?.until, queuedCount: queued.get(host)?.n || 0, rate, want: list.length });
    list.slice(0, slots.length).forEach((r, i) => granted.push({ ...r, runAt: slots[i] }));
  }
  for (const r of granted) {
    const live = r.date && now - new Date(r.date).getTime() < LIVE_MS;
    await enqueue(BODY_JOB, { messageId: r.id, host: r.host }, {
      userId: r.user_id, dedupeKey: `body:${r.id}`, priority: live ? 6 : 8, maxAttempts: 3, runAt: r.runAt,
    });
  }
  if (granted.length) {
    await query(
      `INSERT INTO hedwig_index_msg (message_id, user_id, account_id, thread_key, msg_date, body_state, body_requested_at, body_attempts)
       SELECT x.id, x.uid, x.aid, x.tk, x.d, 'requested', NOW(), 1
         FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[]) AS x(id, uid, aid, tk, d)
       ON CONFLICT (message_id) DO UPDATE SET body_state = 'requested', body_requested_at = NOW(),
         body_attempts = hedwig_index_msg.body_attempts + 1, updated_at = NOW()`,
      [granted.map((r) => r.id), granted.map((r) => r.user_id), granted.map((r) => r.account_id),
        granted.map((r) => r.thread_key), granted.map((r) => r.date)],
    );
  }
  return granted.length;
}

// ── Attachments ──────────────────────────────────────────────────────────────

const TIKA_MIME = /^(application\/(pdf|msword|rtf|vnd\.openxmlformats-officedocument\.[\w.-]+|vnd\.ms-(excel|powerpoint|word)[\w.-]*|vnd\.oasis\.opendocument\.[\w.-]+|epub\+zip|xhtml\+xml)|text\/(plain|csv|html|markdown|rtf|tab-separated-values)|message\/rfc822)$/i;
const TIKA_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|tsv|md|html?|eml|epub|pages|numbers|key)$/i;

/**
 * Attachments worth sending to Tika: document types by MIME or extension, not inline images,
 * within the size limit. Pure; exported for tests.
 * @returns {{ index: number, part: string, filename: string, mime: string, size: number, encoding: string }[]}
 */
export function extractableAttachments(attachments, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const list = typeof attachments === 'string' ? safeJson(attachments) : attachments;
  return (Array.isArray(list) ? list : [])
    .map((a, index) => ({ index, part: a?.part, filename: a?.filename || '', mime: String(a?.type || a?.mime || '').toLowerCase(), size: Number(a?.size) || 0, encoding: a?.encoding }))
    .filter((a) => a.part && (TIKA_MIME.test(a.mime) || TIKA_EXT.test(a.filename)))
    .filter((a) => !(a.size > maxBytes));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

/**
 * Queue Tika extraction for messages whose body (and so attachment list) is in. Mail in a spam
 * folder is never sent to Tika: its attachments are the least trustworthy documents there are,
 * and nothing shows their text (retrieval and the Brief exclude spam).
 */
export async function requestAttachments({ now = Date.now(), candidates = 200 } = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg['index.tikaEnabled'] || !cfg['index.tikaUrl']) return 0;
  // Stuck 'queued' rows (job failed for good or vanished) and 'retry' rows come back after a while.
  await query(
    `UPDATE hedwig_index_msg SET attach_state = NULL, updated_at = NOW()
      WHERE (attach_state = 'queued' AND attach_requested_at < NOW() - INTERVAL '1 day')
         OR (attach_state = 'retry' AND attach_requested_at < NOW() - INTERVAL '30 minutes')`,
  );
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.attachments, m.date, lower(COALESCE(a.imap_host, a.id::text)) AS host, a.imap_host, a.oauth_provider, a.user_id
       FROM hedwig_index_msg x
       JOIN messages m ON m.id = x.message_id
       JOIN email_accounts a ON a.id = m.account_id AND a.enabled = true
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE x.attach_state IS NULL AND m.has_attachments = true AND m.is_deleted = false
        AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL)
        AND NOT x.spam AND COALESCE(f.special_use, '') <> '\\Junk'
        AND m.folder !~* '(^|[/.])(spam|junk|junk e-?mail|bulk mail)$'
      ORDER BY x.msg_date DESC NULLS LAST
      LIMIT $1`,
    [candidates],
  );
  if (!rows.length) return 0;
  const maxBytes = cfg['index.tikaMaxBytes'];
  const skip = rows.filter((r) => !extractableAttachments(r.attachments, { maxBytes }).length).map((r) => r.id);
  if (skip.length) await query("UPDATE hedwig_index_msg SET attach_state = 'skipped', updated_at = NOW() WHERE message_id = ANY($1::uuid[])", [skip]);
  const backingOff = await accountsBackingOff(now);
  const todo = rows.filter((r) => !skip.includes(r.id) && !backingOff.has(String(r.account_id)));
  const queued = await queuedUntilByHost();
  let n = 0;
  for (const [host, { rate, list }] of groupByHost(todo, cfg)) {
    const slots = planSlots({ now, queuedUntil: queued.get(host)?.until, queuedCount: queued.get(host)?.n || 0, rate, want: list.length });
    for (let i = 0; i < slots.length; i++) {
      const r = list[i];
      await enqueue(ATTACHMENT_JOB, { messageId: r.id, host }, { userId: r.user_id, dedupeKey: `attach:${r.id}`, priority: 9, maxAttempts: 3, runAt: slots[i] });
      await query("UPDATE hedwig_index_msg SET attach_state = 'queued', attach_requested_at = NOW(), updated_at = NOW() WHERE message_id = $1", [r.id]);
      n++;
    }
  }
  return n;
}

export class TikaUnavailable extends Error {}

/** Send bytes to Tika and return plain text. Throws TikaUnavailable when Tika cannot be reached. */
export async function tikaExtract(buffer, { url, mime, filename, timeoutMs = 60_000, fetchFn = fetch }) {
  let res;
  try {
    res = await fetchFn(`${String(url).replace(/\/+$/, '')}/tika`, {
      method: 'PUT',
      headers: {
        Accept: 'text/plain; charset=UTF-8',
        'Content-Type': mime || 'application/octet-stream',
        ...(filename ? { 'Content-Disposition': `attachment; filename="${String(filename).replace(/["\r\n]/g, '')}"` } : {}),
      },
      body: buffer,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TikaUnavailable(`tika unreachable: ${err.message}`);
  }
  if ([502, 503, 504].includes(res.status)) throw new TikaUnavailable(`tika ${res.status}`);
  if (!res.ok) throw new Error(`tika ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.text()).replace(/\0/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** API-process job: fetch a message's document attachments over IMAP and extract their text. */
export function makeAttachmentHandler(imapManager, { fetchFn = fetch } = {}) {
  return async ({ messageId }) => {
    const cfg = await getConfig();
    const setState = (state, error) => query(
      `UPDATE hedwig_index_msg SET attach_state = $2, attach_error = $3, attach_requested_at = NOW(),
              chunk_version = CASE WHEN $2 = 'done' THEN NULL ELSE chunk_version END, updated_at = NOW()
        WHERE message_id = $1`,
      [messageId, state, error ? String(error).slice(0, 500) : null],
    );
    if (!cfg['index.tikaEnabled']) { await query('UPDATE hedwig_index_msg SET attach_state = NULL WHERE message_id = $1', [messageId]); return; }
    const { rows } = await query(
      `SELECT m.id, m.uid, m.folder, m.attachments, a.*, m.account_id
         FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND m.is_deleted = false`,
      [messageId],
    );
    const row = rows[0];
    if (!row) return;
    const account = { ...row, id: row.account_id };
    const maxBytes = cfg['index.tikaMaxBytes'];
    const maxChars = cfg['index.attachmentMaxChars'];
    const list = extractableAttachments(row.attachments, { maxBytes });
    if (!list.length) { await setState('skipped', null); return; }
    const buffers = await guardedFetch(
      { imapManager, account, kind: ATTACHMENT_JOB, messageId },
      () => imapManager.fetchMultipleAttachments(account, row.uid, row.folder, list.map((a) => ({ part: a.part, encoding: a.encoding }))),
    );
    let failures = 0;
    let lastError = null;
    for (const a of list) {
      const buf = buffers.get(a.part);
      let text = null;
      let error = null;
      if (!buf) error = 'attachment part not returned by the server';
      else if (buf.length > maxBytes) error = `larger than index.tikaMaxBytes (${buf.length} bytes)`;
      else {
        try {
          text = (await tikaExtract(buf, { url: cfg['index.tikaUrl'], mime: a.mime, filename: a.filename, fetchFn })).slice(0, maxChars);
        } catch (err) {
          if (err instanceof TikaUnavailable) { await setState('retry', err.message); return; }
          error = err.message;
        }
      }
      if (error) { failures++; lastError = error; }
      await query(
        `INSERT INTO hedwig_attachment_text (message_id, attachment_index, filename, mime, part, bytes, chars, text, error, extracted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (message_id, attachment_index) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, part = EXCLUDED.part,
           bytes = EXCLUDED.bytes, chars = EXCLUDED.chars, text = EXCLUDED.text, error = EXCLUDED.error, extracted_at = NOW()`,
        [messageId, a.index, a.filename, a.mime, a.part, buf?.length ?? null, text?.length ?? 0, text, error],
      );
    }
    if (failures === list.length) await setState('failed', lastError);
    else await setState('done', failures ? `${failures} of ${list.length}: ${lastError}` : null);
  };
}
