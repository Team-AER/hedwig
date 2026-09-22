// aer.digest — files newsletters under Digest and composes a daily paper: one row per newsletter
// issue with a one-line summary. Tier-1 v2 plugin: facade only, no core imports.
import { isNewsletter, selectForPaper, localParts, shouldBuild, snippetLine } from './select.js';

export const manifest = {
  id: 'aer.digest',
  name: 'Newsletter digest',
  version: '1.0.0',
  api: '^1.0.0',
  tier: 1,
  description: 'Keeps newsletters out of your way in Digest and writes a daily paper with a one-line summary of each issue.',
  author: 'Team AER',
  permissions: [
    { name: 'triage.hook', reason: 'File newsletters under Digest as they arrive' },
    { name: 'mail.read', reason: 'Read the newsletters that go into the paper' },
    { name: 'storage', reason: 'Keep your daily papers' },
    { name: 'schedule', reason: 'Write the paper every morning' },
    { name: 'views', reason: 'Show the daily paper' },
    { name: 'llm.summarize', optional: true, reason: 'Summarize each issue in one line (without it the paper uses the opening lines)' },
  ],
  hooks: ['beforeTriage'],
  settings: {
    type: 'object',
    properties: {
      forceDigest: { type: 'boolean', default: true, title: 'Always file newsletters under Digest' },
      paperHour: { type: 'integer', default: 7, minimum: 0, maximum: 23, title: 'Hour to write the paper', description: 'In your Hedwig time zone.' },
      maxItems: { type: 'integer', default: 40, minimum: 5, maximum: 100, title: 'Most issues per paper' },
    },
  },
  views: ['aer.digest.paper'],
  commands: ['aer.digest.open'],
};

const PAPER = (date) => `paper:${date}`;

export default function activate(hedwig) {
  const { PermissionError } = hedwig;

  async function candidates(userId, since) {
    const seen = new Map();
    const add = (list) => { for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m); };
    add(await hedwig.mail.search(userId, { bulk: true, after: since, limit: 200 }));
    add(await hedwig.mail.search(userId, { category: 'newsletter', after: since, limit: 200 }));
    try { add(await hedwig.mail.search(userId, { triage: 'digest', after: since, limit: 200 })); } catch { /* triage tables may be empty */ }
    return [...seen.values()];
  }

  async function oneLine(userId, message) {
    const full = await hedwig.mail.getMessage(userId, message.id);
    const text = full?.text || message.snippet || '';
    if (text.trim().length > 80) {
      try {
        const line = await hedwig.llm.summarize(userId, `${message.subject || ''}\n\n${text.slice(0, 6000)}`, {
          maxWords: 30, role: 'fast', instructions: 'Say what this newsletter issue is about in one plain sentence.',
        });
        if (line) return { summary: line.split('\n')[0].slice(0, 300), source: 'model' };
      } catch (err) {
        if (!(err instanceof PermissionError)) hedwig.logger.debug('summary failed:', err.message);
      }
    }
    return { summary: snippetLine(text || message.snippet), source: 'snippet' };
  }

  async function buildPaper(userId, date) {
    const settings = await hedwig.settings.get(userId);
    const last = (await hedwig.storage.get(userId, 'last-paper')) || null;
    const since = last?.builtAt && Date.now() - Date.parse(last.builtAt) < 3 * 86400_000
      ? last.builtAt : new Date(Date.now() - 86400_000).toISOString();
    const picked = selectForPaper(await candidates(userId, since), { since, max: settings.maxItems });
    const items = [];
    for (const m of picked) {
      const { summary, source } = await oneLine(userId, m);
      items.push({ messageId: m.id, from_name: m.from_name, from_email: m.from_email, subject: m.subject, date: m.date, summary, summarySource: source });
    }
    const paper = { date, builtAt: new Date().toISOString(), since, items };
    await hedwig.storage.set(userId, PAPER(date), paper);
    await hedwig.storage.set(userId, 'last-paper', { date, builtAt: paper.builtAt });
    return paper;
  }

  const router = hedwig.router();

  router.get('/paper', async (req) => {
    const tz = await hedwig.user.timezone(req.userId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localParts(tz).date;
    return { date, paper: await hedwig.storage.get(req.userId, PAPER(date)) };
  });

  router.get('/papers', async (req) => {
    const rows = await hedwig.storage.list(req.userId, { prefix: 'paper:', limit: 60, values: false });
    return { dates: rows.map((r) => r.key.slice(6)).sort().reverse() };
  });

  router.post('/paper/build', async (req) => {
    const tz = await hedwig.user.timezone(req.userId);
    return { paper: await buildPaper(req.userId, localParts(tz).date) };
  });

  return {
    hooks: {
      beforeTriage: async (ctx) => {
        const settings = await hedwig.settings.get(ctx.userId);
        if (!settings.forceDigest) return undefined;
        let msg = ctx.message || ctx.row || null;
        if (!msg && ctx.messageId) {
          try { msg = await hedwig.mail.getMessage(ctx.userId, ctx.messageId); } catch { msg = null; }
        }
        if (!msg || !isNewsletter(msg)) return undefined;
        return { verdict: { category: 'digest', reason: 'Newsletter' }, features: { newsletter: 1 } };
      },
    },
    router,
    schedules: [{
      name: 'paper',
      everySec: 900,
      run: async ({ userId }) => {
        const settings = await hedwig.settings.get(userId);
        const { date, hour } = localParts(await hedwig.user.timezone(userId));
        const exists = Boolean(await hedwig.storage.get(userId, PAPER(date)));
        if (shouldBuild({ hour, paperHour: settings.paperHour, exists })) await buildPaper(userId, date);
      },
    }],
  };
}
