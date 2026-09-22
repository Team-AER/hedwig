// aer.receipts — finds receipts, invoices and order confirmations in new mail and keeps a ledger.
// Tier-1 v2 plugin: it imports nothing from core and works only through the `hedwig` facade.
import {
  scoreReceipt, heuristicExtract, normaliseReceipt, summarise, toCsv, filterReceipts, EXTRACT_SCHEMA,
} from './heuristics.js';

export const manifest = {
  id: 'aer.receipts',
  name: 'Receipts',
  version: '1.0.0',
  api: '^1.0.0',
  tier: 1,
  description: 'Spots receipts, invoices and order confirmations in new mail and keeps a ledger with monthly totals and CSV export.',
  author: 'Team AER',
  permissions: [
    { name: 'mail.read', reason: 'Read new messages to spot receipts and invoices' },
    { name: 'storage', reason: 'Keep your receipts ledger' },
    { name: 'views', reason: 'Show the receipts ledger' },
    { name: 'llm.extract', optional: true, reason: 'Read vendor, amount and date from a receipt when the simple rules are unsure' },
    { name: 'agent.tools', optional: true, reason: 'Let the agent answer questions about your receipts' },
  ],
  hooks: ['onMessageIndexed'],
  settings: {
    type: 'object',
    properties: {
      useModel: { type: 'boolean', default: true, title: 'Use the model to read receipts' },
      minScore: { type: 'integer', default: 4, minimum: 2, maximum: 9, title: 'Detection threshold', description: 'Higher finds fewer, surer receipts.' },
    },
  },
  views: ['aer.receipts.ledger'],
};

const KEY = (messageId) => `r:${messageId}`;

export default function activate(hedwig) {
  const { PermissionError } = hedwig;

  async function ledger(userId) {
    const rows = await hedwig.storage.list(userId, { prefix: 'r:', limit: 1000 });
    return rows.map((r) => r.value).filter((r) => r && !r.dismissed)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }

  /** Examine one message; store it when it reads as a receipt. Returns the stored record or null. */
  async function examine(userId, messageId, { force = false } = {}) {
    if (!force && (await hedwig.storage.get(userId, KEY(messageId)))) return null;
    const msg = await hedwig.mail.getMessage(userId, messageId);
    if (!msg) return null;
    const settings = await hedwig.settings.get(userId);
    const { score, signals } = scoreReceipt(msg);
    if (score < settings.minScore) return null;
    let data = heuristicExtract(msg);
    let source = 'rules';
    if (settings.useModel) {
      try {
        const raw = await hedwig.llm.extract(userId, {
          text: `Subject: ${msg.subject || ''}\nFrom: ${msg.from_name || ''} <${msg.from_email || ''}>\nDate: ${msg.date || ''}\n\n${(msg.text || '').slice(0, 8000)}`,
          instructions: 'This email is probably a receipt, invoice or order confirmation. Extract the merchant (vendor), the total actually charged (amount, a number), its ISO currency code, the purchase date (YYYY-MM-DD), the order or invoice reference, and a category.',
          schema: EXTRACT_SCHEMA,
        });
        if (raw) { data = normaliseReceipt(raw, data); source = 'model'; }
      } catch (err) {
        if (!(err instanceof PermissionError)) hedwig.logger.debug('model extraction failed:', err.message);
      }
    }
    // Without an amount, only keep strong detections: the ledger is only useful with totals.
    if (!Number.isFinite(data.amount) && score < settings.minScore + 2) return null;
    const record = {
      ...data,
      messageId,
      subject: msg.subject || '',
      from_email: msg.from_email || '',
      score,
      signals,
      source,
      detectedAt: new Date().toISOString(),
    };
    await hedwig.storage.set(userId, KEY(messageId), record);
    return record;
  }

  const router = hedwig.router();

  router.get('/receipts', async (req) => {
    const all = filterReceipts(await ledger(req.userId), { month: req.query.month, vendor: req.query.vendor });
    return { receipts: all.slice(0, Math.min(1000, Number(req.query.limit) || 500)), count: all.length };
  });

  router.get('/summary', async (req) => summarise(filterReceipts(await ledger(req.userId), { month: req.query.month, vendor: req.query.vendor })));

  router.get('/export.csv', async (req, res) => {
    const rows = filterReceipts(await ledger(req.userId), { month: req.query.month, vendor: req.query.vendor });
    res.attachment(`receipts${req.query.month ? `-${req.query.month}` : ''}.csv`, toCsv(rows), 'text/csv; charset=utf-8');
  });

  // Not a receipt: keep a tombstone so the message is not detected again.
  router.delete('/receipts/:messageId', async (req) => {
    const existing = await hedwig.storage.get(req.userId, KEY(req.params.messageId));
    if (!existing) return { ok: false };
    await hedwig.storage.set(req.userId, KEY(req.params.messageId), { ...existing, dismissed: true });
    return { ok: true };
  });

  // Look back over recent mail (the hook only sees mail indexed after activation).
  router.post('/scan', async (req) => {
    const days = Math.max(1, Math.min(90, Number(req.body?.days) || 30));
    const after = new Date(Date.now() - days * 86400_000).toISOString();
    const candidates = await hedwig.mail.search(req.userId, { after, limit: 200 });
    let found = 0;
    for (const m of candidates) {
      if (scoreReceipt({ subject: m.subject, from_email: m.from_email, text: m.snippet, folder: m.folder }).score < 2) continue;
      if (await examine(req.userId, m.id)) found++;
    }
    return { scanned: candidates.length, found };
  });

  return {
    hooks: {
      onMessageIndexed: async (ctx) => { await examine(ctx.userId, ctx.messageId); },
    },
    router,
    tools: [{
      name: 'list_receipts',
      description: 'List receipts and invoices found in the user\'s mail, with totals. Filter by month (YYYY-MM) or vendor.',
      permission: 'storage',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'YYYY-MM' },
          vendor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      handler: async (args, { userId }) => {
        const rows = filterReceipts(await ledger(userId), { month: args.month, vendor: args.vendor });
        return {
          receipts: rows.slice(0, Math.min(100, Number(args.limit) || 25)).map((r) => ({
            date: r.date, vendor: r.vendor, amount: r.amount, currency: r.currency, category: r.category, order_ref: r.order_ref, messageId: r.messageId,
          })),
          totals: summarise(rows).byMonth.slice(0, 12),
        };
      },
    }],
  };
}
