// Agent tools for triage. None of them touch mail: set_triage changes which Hedwig list a message
// shows in (and teaches the classifier), and never pushes to the provider's Junk folder.
import { registerTool, getTool } from '../agent/toolRegistry.js';
import { listTriage, getTriage, overrideTriage, CATEGORIES } from './service.js';

function compact({ message, triage, thread }) {
  return {
    messageId: message.id,
    subject: message.subject,
    from: message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email,
    date: message.date,
    account: message.account?.name || null,
    reason: triage.reason_label,
    priority: triage.priority,
    threadCount: thread?.count,
  };
}

const LIST_PARAMS = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum items (default 20)' },
    accountId: { type: 'string', description: 'Only this account (uuid)' },
  },
};

export function registerTriageTools() {
  if (getTool('list_needs_you')) return;
  registerTool({
    name: 'list_needs_you',
    description: 'List the messages Hedwig triage says need the user (unresolved), most important first, each with the short reason it was flagged.',
    parameters: LIST_PARAMS,
    handler: async (args, { userId }) => {
      const { items, counts } = await listTriage(userId, { view: 'needs_you', limit: args?.limit ?? 20, accountId: args?.accountId || null });
      return { total: counts.needs_you, items: items.map(compact) };
    },
  });
  registerTool({
    name: 'list_waiting_on',
    description: 'List messages the user sent that asked something and have had no reply, oldest wait first by priority.',
    parameters: LIST_PARAMS,
    handler: async (args, { userId }) => {
      const { items, counts } = await listTriage(userId, { view: 'waiting_on', limit: args?.limit ?? 20, accountId: args?.accountId || null });
      return { total: counts.waiting_on, items: items.map((i) => ({ ...compact(i), to: i.thread?.participants })) };
    },
  });
  registerTool({
    name: 'explain_triage',
    description: 'Explain why Hedwig triaged a message the way it did: its list, priority, which stage decided (1 rules, 2 learned model, 3 language model), the signals that fired, and the user\'s history with the sender.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'Message id (uuid)' } },
      required: ['messageId'],
    },
    handler: async (args, { userId }) => {
      const out = await getTriage(userId, String(args?.messageId || ''));
      if (!out) return { error: 'That message has not been triaged.' };
      return out;
    },
  });
  registerTool({
    name: 'set_triage',
    description: `Move a message to a different Hedwig triage list (${CATEGORIES.join(', ')}). This changes what the user sees in their Hedwig lists and trains their triage model; it does not move, flag or delete the email itself.`,
    mutates: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message id (uuid)' },
        category: { type: 'string', enum: CATEGORIES },
        reason: { type: 'string', description: 'Short reason, shown to the user' },
      },
      required: ['messageId', 'category'],
    },
    summarize: (args) => `Move message to ${args?.category}`,
    handler: async (args, { userId }) => overrideTriage(userId, String(args?.messageId || ''), { category: args?.category, reason: args?.reason }, { pushJunk: false }),
  });
}
