// aer.pensieve — sends newsletters to Pensieve (Team AER's reader) as saved links, through
// Pensieve's saved-links API: POST <baseUrl>/api/v1/save with `Authorization: Bearer <token>`.
// Tier-1 v2 plugin: facade only; the only host it can reach is the one the user configures.
//
// Gap: Pensieve saves *links*. It has no API that creates an item from raw content, so a newsletter
// without a web version ("view in browser", or a post link on Substack-style platforms) is skipped
// with status no_link. When a link exists we also send the email's HTML as `html`, which Pensieve
// archives as the page "as you see it". Its Google Reader API is no substitute: quickadd subscribes
// to a feed and edit-tag only tags items that already exist.
import { looksLikeNewsletter, findWebVersionUrl, buildSavePayload, saveEndpoint, outcome } from './push.js';

export const manifest = {
  id: 'aer.pensieve',
  name: 'Pensieve bridge',
  version: '1.0.0',
  api: '^1.0.0',
  tier: 1,
  description: 'Saves newsletters to your Pensieve reading list so you can read them with the rest of your feeds.',
  author: 'Team AER',
  permissions: [
    { name: 'mail.read', reason: 'Read newsletters to find their web version' },
    { name: 'storage', reason: 'Remember what was already sent to Pensieve' },
    { name: 'views', reason: 'Show the sync status' },
    { name: 'net:$settings.baseUrl', reason: 'Send saved links to the Pensieve server you set up' },
    { name: 'triage.hook', optional: true, reason: 'Also send messages Hedwig filed under Digest' },
  ],
  hooks: ['onMessageIndexed'],
  net: ['$settings.baseUrl'],
  settings: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', format: 'url', default: 'https://pensieve.brainfc.uk', title: 'Pensieve address' },
      apiToken: { type: 'string', secret: true, default: '', maxLength: 400, title: 'API token', description: 'Create one in Pensieve under Manage > Saving and archive.' },
      autoPush: { type: 'boolean', default: true, title: 'Send new newsletters automatically' },
      sendHtml: { type: 'boolean', default: true, title: 'Send the newsletter as received', description: 'Pensieve keeps an exact copy of the email instead of fetching the web page.' },
      tags: { type: 'string', default: 'newsletter, hedwig', maxLength: 300, title: 'Tags' },
    },
  },
  views: ['aer.pensieve.status'],
};

const PUSHED = (id) => `pushed:${id}`;

export default function activate(hedwig) {
  const { PermissionError } = hedwig;

  async function isDigest(userId, msg) {
    if (looksLikeNewsletter(msg)) return true;
    try {
      const t = await hedwig.triage.get(userId, msg.id);
      return t?.category === 'digest';
    } catch (err) {
      if (!(err instanceof PermissionError)) hedwig.logger.debug('triage lookup failed:', err.message);
      return false;
    }
  }

  async function recordStatus(userId, patch) {
    const cur = (await hedwig.storage.get(userId, 'status')) || { saved: 0, failed: 0, skipped: 0 };
    const next = { ...cur, ...patch };
    if (patch.result === 'saved') next.saved = (cur.saved || 0) + 1;
    if (patch.result === 'failed') next.failed = (cur.failed || 0) + 1;
    if (patch.result === 'skipped') next.skipped = (cur.skipped || 0) + 1;
    delete next.result;
    await hedwig.storage.set(userId, 'status', next);
  }

  /** Send one message to Pensieve. Returns the stored outcome. */
  async function push(userId, messageId, { force = false } = {}) {
    if (!force) {
      const done = await hedwig.storage.get(userId, PUSHED(messageId));
      if (done && done.status === 'saved') return done;
    }
    const settings = await hedwig.settings.get(userId);
    if (!settings.apiToken || !settings.baseUrl) return { status: 'not_configured' };
    const msg = await hedwig.mail.getMessage(userId, messageId, { html: true });
    if (!msg) return { status: 'missing' };
    const base = { messageId, subject: msg.subject || '', from: msg.from_name || msg.from_email || '', at: new Date().toISOString() };
    const url = findWebVersionUrl(msg);
    if (!url && !msg.body_fetched) return { ...base, status: 'waiting_body' };
    if (!url) {
      const rec = { ...base, status: 'no_link', error: 'No web version link in this newsletter' };
      await hedwig.storage.set(userId, PUSHED(messageId), rec);
      await recordStatus(userId, { result: 'skipped' });
      return rec;
    }
    let rec;
    try {
      const res = await hedwig.net.fetch(userId, saveEndpoint(settings.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiToken}`, Accept: 'application/json' },
        body: buildSavePayload(msg, url, settings),
        timeoutMs: 20_000,
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      rec = { ...base, url, ...outcome(res.status, body) };
    } catch (err) {
      rec = { ...base, url, status: err instanceof PermissionError ? 'not_permitted' : 'error', error: String(err.message).slice(0, 300) };
    }
    await hedwig.storage.set(userId, PUSHED(messageId), rec);
    await recordStatus(userId, rec.status === 'saved'
      ? { result: 'saved', lastPushAt: rec.at, lastError: null }
      : { result: 'failed', lastError: rec.error || rec.status, lastErrorAt: rec.at });
    return rec;
  }

  const router = hedwig.router();

  router.get('/status', async (req) => {
    const settings = await hedwig.settings.get(req.userId);
    const recent = await hedwig.storage.list(req.userId, { prefix: 'pushed:', limit: 50 });
    return {
      configured: Boolean(settings.apiToken && settings.baseUrl),
      baseUrl: settings.baseUrl,
      autoPush: settings.autoPush,
      status: (await hedwig.storage.get(req.userId, 'status')) || { saved: 0, failed: 0, skipped: 0 },
      recent: recent.map((r) => r.value),
    };
  });

  // Check the address and token without saving anything: Pensieve answers 401 for a bad token and
  // 422 ("Enter a link to save.") for a good token with an empty body.
  router.post('/test', async (req) => {
    const settings = await hedwig.settings.get(req.userId);
    if (!settings.apiToken) return { ok: false, error: 'Add an API token first' };
    try {
      const res = await hedwig.net.fetch(req.userId, saveEndpoint(settings.baseUrl), {
        method: 'POST', headers: { Authorization: `Bearer ${settings.apiToken}` }, body: {}, timeoutMs: 10_000,
      });
      if (res.status === 401) return { ok: false, error: 'Pensieve rejected the API token' };
      if (res.status === 422 || res.ok) return { ok: true };
      return { ok: false, error: `Pensieve answered ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  router.post('/push', async (req) => {
    if (typeof req.body?.messageId !== 'string') return { status: 'missing' };
    return push(req.userId, req.body.messageId, { force: req.body.force === true });
  });

  // Send recent newsletters that were not sent yet (at most 25 per call).
  router.post('/sync', async (req) => {
    const days = Math.max(1, Math.min(30, Number(req.body?.days) || 3));
    const after = new Date(Date.now() - days * 86400_000).toISOString();
    const list = await hedwig.mail.search(req.userId, { bulk: true, after, limit: 200 });
    const results = [];
    for (const m of list) {
      if (results.length >= 25) break;
      if (!(await isDigest(req.userId, m))) continue;
      if (await hedwig.storage.get(req.userId, PUSHED(m.id))) continue;
      results.push(await push(req.userId, m.id));
    }
    return { checked: list.length, sent: results.filter((r) => r.status === 'saved').length, results };
  });

  return {
    hooks: {
      onMessageIndexed: async (ctx) => {
        const settings = await hedwig.settings.get(ctx.userId);
        if (!settings.autoPush || !settings.apiToken) return;
        const msg = await hedwig.mail.getMessage(ctx.userId, ctx.messageId);
        if (!msg || !(await isDigest(ctx.userId, msg))) return;
        const rec = await push(ctx.userId, ctx.messageId);
        // New mail is indexed before its body is fetched; try again once the body is likely there.
        if (rec.status === 'waiting_body') {
          await hedwig.jobs.enqueue(ctx.userId, 'retry', { messageId: ctx.messageId }, {
            runAt: new Date(Date.now() + 10 * 60_000).toISOString(), dedupeKey: ctx.messageId,
          });
        }
      },
    },
    jobs: {
      retry: async ({ messageId }, { userId }) => {
        const rec = await push(userId, messageId);
        if (rec.status === 'waiting_body') {
          await hedwig.storage.set(userId, PUSHED(messageId), { ...rec, status: 'no_link', error: 'The message body was never fetched' });
        }
      },
    },
    router,
  };
}
