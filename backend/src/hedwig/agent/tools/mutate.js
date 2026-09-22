// Mutating agent tools. The agent loop never calls these handlers: it records a pending action
// (after `prepare` has checked the arguments against the user's own mail) and the handler runs only
// when the user approves, in the API process. None of them sends mail or deletes anything.
import {
  ToolError, loadOwnedMessage, checkMoveTarget, checkSnoozeUntil, checkDraftReply,
  archiveMessage, moveMessage, markRead, starMessage, snoozeMessage, draftReply,
} from '../mailOps.js';

const ID = { type: 'string', format: 'uuid', description: 'message id from a tool result' };
const label = (m) => {
  const subject = String(m.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 80);
  const who = m.from_name || m.from_email || 'unknown sender';
  return `“${subject}” from ${who}`;
};

export const mutatingTools = [
  {
    name: 'archive_message',
    description: "Archive a message (move it to its account's Archive folder).",
    mutates: true,
    parameters: { type: 'object', properties: { messageId: ID }, required: ['messageId'] },
    summarize: () => 'Archive a message',
    async prepare({ messageId }, { userId }) {
      return { summary: `Archive ${label(await loadOwnedMessage(userId, messageId))}` };
    },
    handler: (args, { userId }) => archiveMessage(userId, args),
  },
  {
    name: 'move_message',
    description: 'Move a message to another folder of the same account (not Trash, Junk or Drafts).',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { messageId: ID, folder: { type: 'string', maxLength: 255, description: 'destination folder path exactly as the account names it' } },
      required: ['messageId', 'folder'],
    },
    summarize: (a) => `Move a message to ${a.folder}`,
    async prepare(args, { userId }) {
      const m = await checkMoveTarget(userId, args);
      return { summary: `Move ${label(m)} to ${args.folder}` };
    },
    handler: (args, { userId }) => moveMessage(userId, args),
  },
  {
    name: 'mark_read',
    description: 'Mark a message read (read: true) or unread (read: false).',
    mutates: true,
    parameters: { type: 'object', properties: { messageId: ID, read: { type: 'boolean', default: true } }, required: ['messageId'] },
    summarize: (a) => `Mark a message ${a.read === false ? 'unread' : 'read'}`,
    async prepare({ messageId, read = true }, { userId }) {
      return { summary: `Mark ${label(await loadOwnedMessage(userId, messageId))} as ${read ? 'read' : 'unread'}` };
    },
    handler: (args, { userId }) => markRead(userId, args),
  },
  {
    name: 'star_message',
    description: 'Star (starred: true) or unstar (starred: false) a message.',
    mutates: true,
    parameters: { type: 'object', properties: { messageId: ID, starred: { type: 'boolean', default: true } }, required: ['messageId'] },
    summarize: (a) => (a.starred === false ? 'Unstar a message' : 'Star a message'),
    async prepare({ messageId, starred = true }, { userId }) {
      return { summary: `${starred ? 'Star' : 'Unstar'} ${label(await loadOwnedMessage(userId, messageId))}` };
    },
    handler: (args, { userId }) => starMessage(userId, args),
  },
  {
    name: 'snooze_message',
    description: 'Snooze a message (and its conversation) until a time within the next 30 days; it returns to its folder then. Call `today` first to resolve relative dates.',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { messageId: ID, until: { type: 'string', format: 'date-time', description: 'ISO 8601 date-time with timezone offset' } },
      required: ['messageId', 'until'],
    },
    summarize: (a) => `Snooze a message until ${a.until}`,
    async prepare({ messageId, until }, { userId }) {
      const when = checkSnoozeUntil(until);
      const m = await loadOwnedMessage(userId, messageId);
      if (!m.message_id) throw new ToolError('this message has no Message-ID header and cannot be snoozed');
      return { summary: `Snooze ${label(m)} until ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` };
    },
    handler: (args, { userId }) => snoozeMessage(userId, args),
  },
  {
    name: 'draft_reply',
    description: "Save a reply to a message as a draft in that account's Drafts folder for the user to review and send. It is never sent automatically. The body is plain text; the quoted original and the signature are added for you.",
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        messageId: ID,
        body: { type: 'string', minLength: 1, maxLength: 20000, description: 'the reply text only' },
        replyAll: { type: 'boolean', default: false },
      },
      required: ['messageId', 'body'],
    },
    summarize: () => 'Save a reply draft',
    async prepare({ messageId, body }, { userId }) {
      const m = await checkDraftReply(userId, { messageId });
      const preview = String(body).replace(/\s+/g, ' ').trim();
      return { summary: `Save a draft reply to ${label(m)}: “${preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}”` };
    },
    handler: (args, { userId }) => draftReply(userId, args),
  },
];
