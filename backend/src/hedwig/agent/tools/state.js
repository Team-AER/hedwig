// Agent tools over Hedwig's own state (not mail). They change nothing on the mail server, so they
// run directly; the source message of a commitment is still checked against the user's mail.
import { query } from '../../../services/db.js';
import { ToolError, loadOwnedMessage } from '../mailOps.js';

const toCommitment = (r) => ({
  id: r.id, direction: r.direction, counterparty: r.counterparty, what: r.what, due_at: r.due_at,
  status: r.status, source_message_id: r.source_message_id, created_at: r.created_at,
});

export const stateTools = [
  {
    name: 'create_commitment',
    description: 'Record a commitment the user wants tracked: something they owe someone (i_owe) or someone owes them (they_owe).',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['i_owe', 'they_owe'] },
        what: { type: 'string', minLength: 3, maxLength: 500 },
        counterparty: { type: 'string', maxLength: 200, description: 'who it is owed to or by' },
        due_at: { type: 'string', format: 'date-time' },
        source_message_id: { type: 'string', format: 'uuid', description: 'the message it came from, if any' },
      },
      required: ['direction', 'what'],
    },
    async handler(args, { userId }) {
      let threadKey = null;
      if (args.source_message_id) threadKey = (await loadOwnedMessage(userId, args.source_message_id)).thread_key;
      const { rows } = await query(
        `INSERT INTO hedwig_commitments (user_id, direction, counterparty, what, due_at, source_message_id, thread_key, confidence, user_edited)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true) RETURNING *`,
        [userId, args.direction, args.counterparty || null, args.what, args.due_at ? new Date(args.due_at) : null, args.source_message_id || null, threadKey],
      );
      return toCommitment(rows[0]);
    },
  },
  {
    name: 'complete_commitment',
    description: 'Mark an open commitment done (or dismissed when it no longer applies).',
    parameters: {
      type: 'object',
      properties: {
        commitmentId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['done', 'dismissed'], default: 'done' },
      },
      required: ['commitmentId'],
    },
    async handler({ commitmentId, status }, { userId }) {
      const { rows } = await query(
        `UPDATE hedwig_commitments SET status = $3, resolved_at = NOW(), user_edited = true, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING *`,
        [commitmentId, userId, status],
      );
      if (!rows.length) throw new ToolError('no open commitment with that id');
      return toCommitment(rows[0]);
    },
  },
];
