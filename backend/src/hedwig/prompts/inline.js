// Inline prompts: model calls that do not (yet) go through runPrompt with a registered prompt file.
//
// Upstream's summarize/categorize/assistant, the context engine's summaries, topic labels and
// extraction, triage stage 3, briefings, the agent loop and the plugin facade build their messages
// in place and call chat()/chatStream() directly. Their hedwig_ai_calls rows used to carry no
// prompt id, version or tier, so usage could not be told apart by feature or tier, and the routing
// table could not reach them. llm.js now resolves every such call to one of the entries below:
//
//   id        prompt id and X-Workflow header (plugin calls keep X-Workflow plugin.<id>)
//   version   'inline': the text lives in the calling file; prompt_hash is a hash of the system
//             message actually sent, so a change to the text shows up as a new hash
//   tier      the tier the call runs on under routing 'auto'. null = whatever role the caller asked
//             for. routing.<feature>.tier (admin) overrides it, as it does for registered prompts.
//   callerTier  the tier the calling code asks for today (its role), shown in the routing table
//   feature   the budget/usage feature the caller charges (for the routing table)
//
// Resolution order: an explicit `workflow` that names an entry; the calling file (first stack
// frame outside llm.js, prompts/ and services/aiProvider.js); then `<feature>.inline`.
// A caller can always opt in explicitly by passing `workflow: '<id>'`, or better, by moving its
// prompt into a prompts/<id>.js file and calling runPrompt (see prompts/index.js).
import { createHash } from 'node:crypto';

export const INLINE_VERSION = 'inline';

/** @type {Array<{ id: string, file?: RegExp, feature: string, tier: 'reflex'|'reasoning'|null, callerTier?: string|null, hidden?: boolean, when?: (c: object) => boolean, note: string }>} */
export const INLINE_PROMPTS = [
  // Upstream MailFlow features, through services/aiProvider.js hedwigComplete/hedwigStream.
  // A one-line per-message TL;DR and a five-way category are Tier 1 work (PRD: thread summary on
  // Reflex); upstream asked for the 'long' role, so each paid the Tier 2 wait.
  { id: 'upstream.summarize', file: /services\/summarize\.js$/, feature: 'assistant', tier: 'reflex', note: 'one-line message summary (upstream list view)' },
  { id: 'upstream.categorize', file: /services\/categorizer\.js$/, feature: 'assistant', tier: 'reflex', note: 'Primary/Newsletter/Promotion/Automated/Social (upstream classic shell)' },
  { id: 'upstream.chat', file: /routes\/ai\.js$/, feature: 'assistant', tier: 'reasoning', note: 'compose assistant chat (upstream /api/ai/chat)' },
  { id: 'upstream.test', file: /services\/aiProvider\.js$/, feature: 'assistant', tier: null, callerTier: 'reasoning', hidden: true, note: 'upstream AI provider connection test' },
  // Hedwig modules that build messages in place.
  { id: 'context.summary', file: /hedwig\/context\/summaries\.js$/, feature: 'summary', tier: null, callerTier: 'reasoning', note: 'person and topic summaries' },
  { id: 'context.topicLabel', file: /hedwig\/context\/topics\.js$/, feature: 'summary', tier: null, callerTier: 'reflex', note: 'topic cluster label and summary' },
  { id: 'context.extract', file: /hedwig\/context\/extract\.js$/, feature: 'extraction', tier: null, callerTier: 'reflex', note: 'commitments and facts' },
  { id: 'triage.stage3', file: /hedwig\/triage\/stage3\.js$/, feature: 'triage', tier: null, callerTier: 'reflex', note: 'triage stage 3' },
  { id: 'insights.brief', file: /hedwig\/insights\/briefing\.js$/, feature: 'insights', tier: null, callerTier: 'reasoning', note: 'daily and weekly briefing prose' },
  { id: 'agent.step', file: /hedwig\/agent\/runner\.js$/, feature: 'agent', tier: null, callerTier: 'reasoning', note: 'agent tool loop' },
  { id: 'admin.testLlm', file: /hedwig\/core\/index\.js$/, feature: 'admin', tier: null, callerTier: null, hidden: true, note: 'admin model test' },
  { id: 'plugin.summarize', file: /hedwig\/pluginsv2\/facade\.js$/, feature: 'plugin', tier: null, callerTier: 'reasoning', when: (c) => c.feature === 'summary', note: 'plugin llm.summarize' },
  { id: 'plugin.extract', file: /hedwig\/pluginsv2\/facade\.js$/, feature: 'plugin', tier: null, callerTier: 'reasoning', when: (c) => c.feature === 'extraction', note: 'plugin llm.extract' },
  { id: 'plugin.chat', file: /hedwig\/pluginsv2\/facade\.js$/, feature: 'plugin', tier: null, callerTier: 'reasoning', note: 'plugin llm.chat' },
];

const BY_ID = new Map(INLINE_PROMPTS.map((p) => [p.id, p]));
const SKIP_FRAME = /[\\/]hedwig[\\/]llm\.js|[\\/]hedwig[\\/]prompts[\\/]|node:internal|node_modules/;
const FRAME_FILE = /\(?((?:file:\/\/)?[^\s()]+?):\d+:\d+\)?\s*$/;

/** A stack with enough frames to get past llm.js and aiProvider.js (async frames included). */
export function captureStack() {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const s = new Error().stack || '';
  Error.stackTraceLimit = prev;
  return s;
}

/**
 * The calling source files, innermost first, with Hedwig's own plumbing skipped. aiProvider.js is
 * skipped as plumbing except when nothing else is on the stack (its connection test).
 */
export function callerFiles(stack) {
  const files = [];
  let provider = null;
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = FRAME_FILE.exec(line.trim());
    if (!m) continue;
    const file = m[1].replace(/^file:\/\//, '');
    if (/[\\/]services[\\/]aiProvider\.js$/.test(file)) { provider = provider || file; continue; }
    if (SKIP_FRAME.test(line)) continue;
    files.push(file);
  }
  if (!files.length && provider) files.push(provider);
  return files;
}

function hashSystem(messages) {
  const system = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  if (!system) return null;
  return createHash('sha256').update(system).digest('hex').slice(0, 16);
}

/**
 * Resolve an unregistered call to its inline prompt.
 * @param {{ feature: string, pluginId?: string, workflow?: string, messages?: Array, stack?: string }} call
 * @returns {{ id: string, version: string, hash: string|null, tier: 'reflex'|'reasoning'|null, feature: string, inline: true }}
 */
export function resolveInline(call = {}) {
  let entry = call.workflow ? BY_ID.get(call.workflow) : null;
  if (!entry && call.stack) {
    const files = callerFiles(call.stack);
    for (const file of files) {
      entry = INLINE_PROMPTS.find((p) => p.file && p.file.test(file) && (!p.when || p.when(call)));
      if (entry) break;
    }
  }
  const id = entry?.id || `${String(call.feature || 'hedwig').replace(/[^a-zA-Z0-9_-]/g, '_')}.inline`;
  return { id, version: INLINE_VERSION, hash: hashSystem(call.messages), tier: entry ? entry.tier : null, feature: entry?.feature || call.feature || null, inline: true };
}

/** For the admin prompt list and the routing table. */
export function listInlinePrompts() {
  return INLINE_PROMPTS.filter((p) => !p.hidden).map((p) => ({
    id: p.id, version: INLINE_VERSION, hash: null, tier: p.tier || p.callerTier || 'reasoning', feature: p.feature, inline: true, note: p.note,
  }));
}
