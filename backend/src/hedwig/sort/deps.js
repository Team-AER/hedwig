// What sorting uses from the other v2 streams, in one place:
//   B: prompts/index.js       runPrompt (sort's prompt files register themselves from prompts/)
//   B: ledger/corrections.js  recordCorrection / recentCorrections (hedwig_corrections)
//   A: indexer/parse.js       messageParts (new text, quoted context, attachment text)
import { runPrompt } from '../prompts/index.js';
import { recordCorrection as record, recentCorrections as recent } from '../ledger/corrections.js';
import { messageParts, splitBody } from '../indexer/parse.js';

/** Run one of sorting's prompts ('sort.reflex' | 'sort.screener' | 'spam.reflex' | 'sort.bundleDescribe'). */
export function runSortPrompt(id, vars, opts = {}) {
  return runPrompt(id, vars, { feature: 'sort', lane: 'background', ...opts });
}

export function recordCorrection(entry) {
  return record(entry);
}

/** The user's most recent corrections across `kinds`, newest first (B's function is per kind). */
export async function recentCorrections(userId, { kinds = ['sort', 'screener', 'spam'], limit = 5 } = {}) {
  if (!limit) return [];
  const lists = await Promise.all(kinds.map(async (kind) => ((await recent(userId, kind, limit)) || []).map((c) => ({ kind, ...c }))));
  return lists.flat().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, limit);
}

/** { newText, quoted, attachments } for a message: A's messageParts, else the row's own text. */
export async function messagePartsFor(messageId, row = null, { userId = null } = {}) {
  try {
    const parts = await messageParts(messageId, { userId });
    if (parts && (parts.newText || parts.quoted)) return parts;
  } catch (err) {
    console.warn(`[hedwig] sort: messageParts failed for ${messageId}, using the row text:`, err.message);
  }
  return { ...splitBody(row || {}), attachments: [] };
}
