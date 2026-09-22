// Agent tools backed by the context engine. All read the caller's own data; update_commitment edits
// Hedwig's own records (not mail), so it does not need confirmation.
import { query } from '../../services/db.js';
import { registerTool } from '../agent/toolRegistry.js';
import {
  findEntities, getEntityCard, getTopicCard, listCommitments, listTopics, resolveEntityByEmail,
  searchMessages, updateCommitment,
} from './service.js';
import { clampInt, isUuid } from './util.js';

function requireUuid(v, name) {
  if (!isUuid(v)) throw new Error(`${name} must be a message/record id (UUID)`);
  return v;
}

const brief = (m) => ({
  id: m.id,
  date: m.date,
  from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email,
  subject: m.subject,
  snippet: m.snippet,
  thread_key: m.thread_key,
  account: m.account?.name,
});

const commitmentBrief = (c) => ({
  id: c.id, direction: c.direction, counterparty: c.counterparty, what: c.what, due_at: c.due_at,
  status: c.status, overdue: c.overdue, source_message_id: c.source_message_id,
});

function cardEssentials(card) {
  if (!card) return null;
  return {
    entity: {
      id: card.entity.id, kind: card.entity.kind, name: card.entity.display_name, email: card.entity.primary_email,
      addresses: card.entity.addresses.map((a) => a.email), org: card.entity.org?.display_name || null,
    },
    summary: card.summary?.text || null,
    stats: { messages: card.stats.messages, you_sent: card.stats.you_sent, they_sent: card.stats.they_sent, first_seen: card.stats.first_seen, last_seen: card.stats.last_seen },
    open_commitments: card.commitments.filter((c) => c.status === 'open').map(commitmentBrief),
    facts: card.facts.map((f) => ({ key: f.key, value: f.value })),
    recent: card.recent.slice(0, 6).map(brief),
    topics: card.topics.map((t) => ({ id: t.id, label: t.label })),
  };
}

export function registerContextTools() {
  registerTool({
    name: 'search_mail',
    description: "Search the user's email across all accounts (keyword and meaning). Returns matching messages newest-relevant first with ids to pass to read_message or get_thread.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in words' },
        person: { type: 'string', description: 'Only mail with this email address' },
        after: { type: 'string', description: 'ISO date; only mail on or after it' },
        before: { type: 'string', description: 'ISO date; only mail before it' },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      },
      required: ['query'],
    },
    handler: async (args, { userId }) => {
      let entityId = null;
      if (args.person) {
        const { rows } = await query(
          'SELECT entity_id FROM hedwig_entity_addresses WHERE user_id = $1 AND email = $2',
          [userId, String(args.person).trim().toLowerCase()],
        );
        if (!rows.length) return { results: [], note: `no mail found with ${args.person}` };
        entityId = rows[0].entity_id;
      }
      const { results } = await searchMessages(userId, {
        q: String(args.query || ''), limit: clampInt(args.limit, 1, 30, 10), entityId, after: args.after, before: args.before,
      });
      return { results: results.map(brief) };
    },
  });

  // read_message and get_thread are owned by the agent module (agent/tools/read.js).

  registerTool({
    name: 'get_person',
    description: 'Look up a person or organisation the user corresponds with, by email address or name: summary, stats, open commitments, known facts, recent mail.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address' },
        name: { type: 'string', description: 'Name or part of a name, used when no email is given' },
      },
    },
    handler: async (args, { userId }) => {
      if (args.email) return cardEssentials(await resolveEntityByEmail(userId, args.email)) || { found: false };
      if (!args.name) throw new Error('give an email or a name');
      const [best, ...others] = await findEntities(userId, String(args.name), 5);
      if (!best) return { found: false };
      return {
        ...cardEssentials(await getEntityCard(userId, best.id)),
        other_matches: others.map((e) => ({ id: e.id, name: e.display_name, email: e.primary_email })),
      };
    },
  });

  registerTool({
    name: 'list_topics',
    description: "List the user's ongoing matters (clusters of related mail across threads), most recently active first.",
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 } },
    },
    handler: async (args, { userId }) => ({
      topics: (await listTopics(userId, { limit: clampInt(args.limit, 1, 50, 15) }))
        .map((t) => ({ id: t.id, label: t.label, summary: t.summary, messages: t.message_count, last_seen: t.last_seen, open_commitments: t.open_commitments })),
    }),
  });

  registerTool({
    name: 'get_topic',
    description: 'Get one matter: summary, timeline of messages with one-line gists, people involved, commitments and facts.',
    parameters: {
      type: 'object',
      properties: { topic_id: { type: 'string', description: 'Topic id from list_topics' } },
      required: ['topic_id'],
    },
    handler: async (args, { userId }) => {
      const card = await getTopicCard(userId, requireUuid(args.topic_id, 'topic_id'));
      if (!card) throw new Error('topic not found');
      return {
        topic: { id: card.topic.id, label: card.topic.label, summary: card.topic.summary, messages: card.topic.message_count },
        timeline: card.timeline.slice(-25).map((t) => ({ ...brief(t.message), gist: t.gist, marker: t.marker })),
        people: card.people.map((p) => ({ id: p.id, name: p.display_name, email: p.primary_email })),
        commitments: card.commitments.map(commitmentBrief),
        facts: card.facts.map((f) => ({ key: f.key, value: f.value })),
      };
    },
  });

  registerTool({
    name: 'list_commitments',
    description: 'List things the user owes others (i_owe) and things others owe the user (they_owe), extracted from mail. Overdue items come first.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'dismissed', 'all'], default: 'open' },
        direction: { type: 'string', enum: ['i_owe', 'they_owe'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
    },
    handler: async (args, { userId }) => ({
      commitments: (await listCommitments(userId, {
        status: args.status || 'open', direction: args.direction || null, limit: clampInt(args.limit, 1, 100, 30),
      })).map(commitmentBrief),
    }),
  });

  registerTool({
    name: 'update_commitment',
    description: "Update a tracked commitment in Hedwig: mark it done or dismissed, reopen it, reword it, or change its due date. Changes Hedwig's records only, never mail.",
    mutates: false,
    parameters: {
      type: 'object',
      properties: {
        commitment_id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'dismissed'] },
        what: { type: 'string' },
        due_at: { type: ['string', 'null'], description: 'ISO date or datetime; null clears it' },
      },
      required: ['commitment_id'],
    },
    summarize: (args) => `Update commitment${args.status ? ` → ${args.status}` : ''}${args.what ? `: ${args.what}` : ''}`,
    handler: async (args, { userId }) => {
      const patch = {};
      for (const k of ['status', 'what', 'due_at']) if (args[k] !== undefined) patch[k] = args[k];
      const c = await updateCommitment(userId, requireUuid(args.commitment_id, 'commitment_id'), patch);
      if (!c) throw new Error('commitment not found');
      return commitmentBrief(c);
    },
  });
}
