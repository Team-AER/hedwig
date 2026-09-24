// Hedwig configuration.
//
// Every knob Hedwig has is declared once in SCHEMA below. A value resolves in this order:
//   1. per-user override   (hedwig_user_settings.settings, only for keys with scope 'user')
//   2. admin override      (system_settings key 'hedwig_config', edited in Settings → Hedwig)
//   3. environment         (HEDWIG_<KEY_IN_UPPER_SNAKE>, e.g. llm.baseUrl → HEDWIG_LLM_BASE_URL)
//   4. the schema default
//
// The schema is also what the settings UI renders, so adding a knob here is enough to make it
// editable. Values are validated and coerced on write; reads never throw.
import { query } from '../services/db.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';

const CACHE_TTL_MS = 30_000;

/**
 * @typedef {{ key: string, type: 'string'|'number'|'boolean'|'enum'|'json'|'secret',
 *   default: any, group: string, label: string, help?: string, scope?: 'system'|'user',
 *   options?: string[], min?: number, max?: number }} ConfigField
 */

/** @type {ConfigField[]} */
export const SCHEMA = [
  // ── Master switches ────────────────────────────────────────────────────────
  { key: 'enabled', type: 'boolean', default: true, group: 'general', label: 'Hedwig intelligence enabled', help: 'Off: Hedwig behaves exactly like upstream MailFlow.' },
  { key: 'features.context', type: 'boolean', default: true, group: 'general', label: 'Context engine (people, topics, commitments, facts)', scope: 'user' },
  { key: 'features.triage', type: 'boolean', default: true, group: 'general', label: 'Learning triage (Needs you, Waiting on)', scope: 'user' },
  { key: 'features.insights', type: 'boolean', default: true, group: 'general', label: 'Insights and briefings', scope: 'user' },
  { key: 'features.agent', type: 'boolean', default: true, group: 'general', label: 'Agent and automations', scope: 'user' },
  { key: 'features.extraction', type: 'boolean', default: true, group: 'general', label: 'Model-based extraction of commitments and facts', scope: 'user' },

  // ── Model gateway ──────────────────────────────────────────────────────────
  { key: 'llm.baseUrl', type: 'string', default: 'http://llm-proxy.cls/v1', group: 'models', label: 'OpenAI-compatible base URL', help: 'Leave empty to disable every model feature.' },
  { key: 'llm.apiKey', type: 'secret', default: '', group: 'models', label: 'API key (optional)' },
  { key: 'llm.catalogUrl', type: 'string', default: 'http://llm-proxy.cls/catalog.json', group: 'models', label: 'Model catalog URL', help: 'Optional. Used to list models and the reasoning levels each supports.' },
  { key: 'llm.models.fast', type: 'string', default: 'google/gemma-4-12B-it-qat-w4a16-ct', group: 'models', label: 'Fast model: the Reflex tier (sorting, triage, extraction, labels)', help: 'Small model that reads every message. JSON output only, no tool calls.' },
  { key: 'llm.models.long', type: 'string', default: 'Qwen/Qwen3.8-Flash-Next', group: 'models', label: 'Long model (summaries, ask, briefings)' },
  { key: 'llm.models.agent', type: 'string', default: 'Qwen/Qwen3.8-Flash-Next', group: 'models', label: 'Agent model (tool calling)' },
  { key: 'llm.fallbackModel', type: 'string', default: '', group: 'models', label: 'Fallback model (all roles)', help: 'Used when the primary model does not respond in time or errors. Empty = no fallback.' },
  { key: 'llm.fallbackAfterMs', type: 'number', default: 300000, min: 1000, max: 600000, group: 'models', label: 'Switch to the fallback after waiting (ms) for the primary' },
  { key: 'llm.fallbackCooldownSec', type: 'number', default: 300, min: 10, max: 86400, group: 'models', label: 'Keep using the fallback for (s) before retrying the primary' },
  { key: 'llm.reasoning.fast', type: 'enum', default: 'off', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Fast model reasoning effort' },
  { key: 'llm.reasoning.long', type: 'enum', default: 'low', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Long model reasoning effort' },
  { key: 'llm.reasoning.agent', type: 'enum', default: 'low', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Agent reasoning effort' },
  { key: 'llm.offSpelling', type: 'string', default: 'none', group: 'models', label: 'Wire value sent for "off"', help: 'LiteLLM accepts "none"; some servers want "off".' },
  { key: 'llm.timeoutMs', type: 'number', default: 300000, min: 5000, max: 1800000, group: 'models', label: 'Request timeout (ms)' },
  { key: 'llm.concurrency', type: 'number', default: 2, min: 1, max: 64, group: 'models', label: 'Concurrent requests per model' },
  { key: 'llm.dailyBudget.triage', type: 'number', default: 400, min: 0, max: 100000, group: 'budgets', label: 'Triage stage-3 calls per user per day' },
  { key: 'llm.dailyBudget.extraction', type: 'number', default: 600, min: 0, max: 100000, group: 'budgets', label: 'Extraction calls per user per day' },
  { key: 'llm.dailyBudget.summary', type: 'number', default: 300, min: 0, max: 100000, group: 'budgets', label: 'Summary calls per user per day' },
  { key: 'llm.dailyBudget.ask', type: 'number', default: 200, min: 0, max: 100000, group: 'budgets', label: 'Ask calls per user per day' },
  { key: 'llm.dailyBudget.agent', type: 'number', default: 400, min: 0, max: 100000, group: 'budgets', label: 'Agent model calls per user per day' },
  { key: 'llm.dailyBudget.insights', type: 'number', default: 40, min: 0, max: 10000, group: 'budgets', label: 'Insight calls per user per day' },
  { key: 'llm.dailyBudget.plugins', type: 'number', default: 300, min: 0, max: 100000, group: 'budgets', label: 'Calls per plugin per user per day' },

  // ── Embeddings ─────────────────────────────────────────────────────────────
  { key: 'embeddings.provider', type: 'enum', default: 'openai', options: ['openai', 'hash', 'off'], group: 'embeddings', label: 'Embedding provider', help: 'openai = any /v1/embeddings server (TEI, gateway). hash = built-in lexical vectors, no model.' },
  { key: 'embeddings.baseUrl', type: 'string', default: 'http://llm-proxy.cls/v1', group: 'embeddings', label: 'Embeddings base URL' },
  { key: 'embeddings.apiKey', type: 'secret', default: '', group: 'embeddings', label: 'Embeddings API key (optional)' },
  { key: 'embeddings.model', type: 'string', default: 'bge-m3', group: 'embeddings', label: 'Embedding model' },
  { key: 'embeddings.dims', type: 'number', default: 1024, min: 16, max: 4096, group: 'embeddings', label: 'Embedding dimensions' },
  { key: 'embeddings.batchSize', type: 'number', default: 16, min: 1, max: 256, group: 'embeddings', label: 'Batch size' },
  { key: 'embeddings.maxChars', type: 'number', default: 2000, min: 200, max: 20000, group: 'embeddings', label: 'Characters embedded per message' },

  // ── Pipeline ───────────────────────────────────────────────────────────────
  { key: 'pipeline.scanIntervalSec', type: 'number', default: 15, min: 2, max: 3600, group: 'pipeline', label: 'Scan for new mail every (s)' },
  { key: 'pipeline.batchSize', type: 'number', default: 50, min: 1, max: 1000, group: 'pipeline', label: 'Messages per scan batch' },
  { key: 'pipeline.backfillDays', type: 'number', default: 365, min: 0, max: 10000, group: 'pipeline', label: 'Backfill history (days)', help: 'Older mail is indexed for people but not embedded or extracted.' },
  { key: 'pipeline.workerConcurrency', type: 'number', default: 4, min: 1, max: 64, group: 'pipeline', label: 'Worker job concurrency' },
  { key: 'pipeline.excludeSpecialUse', type: 'json', default: ['\\Junk', '\\Trash', '\\Drafts', '\\All', '\\Flagged', '\\Important'], group: 'pipeline', label: 'Skip folders with these IMAP special-use flags' },
  { key: 'pipeline.excludeFolders', type: 'json', default: [], group: 'pipeline', label: 'Also skip these folder paths' },

  // ── Context engine ─────────────────────────────────────────────────────────
  { key: 'context.topicThreshold', type: 'number', default: 0.78, min: 0.3, max: 0.99, group: 'context', label: 'Topic join similarity' },
  { key: 'context.topicMinMessages', type: 'number', default: 3, min: 2, max: 100, group: 'context', label: 'Messages before a topic is labelled' },
  { key: 'context.askTopK', type: 'number', default: 12, min: 3, max: 60, group: 'context', label: 'Messages retrieved per question' },
  { key: 'context.summaryRefreshHours', type: 'number', default: 24, min: 1, max: 720, group: 'context', label: 'Refresh card summaries after (h)' },
  { key: 'context.extractMinConfidence', type: 'number', default: 0.6, min: 0, max: 1, group: 'context', label: 'Hide extractions below confidence' },
  { key: 'context.freemailDomains', type: 'json', default: ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'fastmail.com', 'aol.com', 'gmx.com', 'gmx.de', 'zoho.com', 'yandex.com', 'hey.com'], group: 'context', label: 'Personal mail domains (not organisations)' },

  // ── Triage ─────────────────────────────────────────────────────────────────
  { key: 'triage.llmLow', type: 'number', default: 0.35, min: 0, max: 1, group: 'triage', label: 'Ask the model above confidence', scope: 'user' },
  { key: 'triage.llmHigh', type: 'number', default: 0.65, min: 0, max: 1, group: 'triage', label: 'Ask the model below confidence', scope: 'user' },
  { key: 'triage.needsYouThreshold', type: 'number', default: 0.5, min: 0, max: 1, group: 'triage', label: 'Needs-you threshold', scope: 'user' },
  { key: 'triage.minSamples', type: 'number', default: 40, min: 5, max: 10000, group: 'triage', label: 'Labelled messages before the classifier takes over' },
  { key: 'triage.retrainHour', type: 'number', default: 3, min: 0, max: 23, group: 'triage', label: 'Nightly retrain hour (server time)' },
  { key: 'triage.implicitAfterHours', type: 'number', default: 48, min: 1, max: 720, group: 'triage', label: 'Learn from behaviour after (h)' },
  { key: 'triage.waitingOnDays', type: 'number', default: 3, min: 1, max: 60, group: 'triage', label: 'Waiting-on after no reply for (days)', scope: 'user' },
  { key: 'triage.modelWeight', type: 'number', default: 0.65, min: 0, max: 1, group: 'triage', label: 'Weight of your classifier vs rules once trained' },
  { key: 'triage.modelPromote', type: 'number', default: 0.8, min: 0, max: 1, group: 'triage', label: 'Classifier confidence needed to lift digest/notifications into Needs you' },
  { key: 'triage.llmMaxAgeDays', type: 'number', default: 14, min: 0, max: 365, group: 'triage', label: 'Ask the model only about mail newer than (days)' },
  { key: 'triage.waitingOnMaxDays', type: 'number', default: 60, min: 1, max: 365, group: 'triage', label: 'Stop tracking waiting-on after (days)' },
  { key: 'triage.implicitWindowDays', type: 'number', default: 30, min: 1, max: 365, group: 'triage', label: 'Learn from behaviour on mail up to (days) old' },
  { key: 'triage.pushJunkToProvider', type: 'boolean', default: false, group: 'triage', label: 'Move spam verdicts to the provider Junk folder', scope: 'user' },

  // ── Insights and agent ─────────────────────────────────────────────────────
  { key: 'insights.briefingTime', type: 'string', default: '07:00', group: 'insights', label: 'Daily briefing time (HH:MM, in your timezone)', scope: 'user' },
  { key: 'insights.weeklyDay', type: 'number', default: 1, min: 0, max: 6, group: 'insights', label: 'Weekly review day (0=Sun)', scope: 'user' },
  { key: 'insights.timezone', type: 'string', default: 'UTC', group: 'insights', label: 'Timezone (IANA)', scope: 'user' },
  { key: 'agent.maxSteps', type: 'number', default: 8, min: 1, max: 40, group: 'agent', label: 'Max tool steps per run' },
  { key: 'agent.requireConfirmation', type: 'boolean', default: true, group: 'agent', label: 'Confirm before any action that changes mail', scope: 'user' },
  { key: 'agent.systemPrompt', type: 'string', default: '', group: 'agent', label: 'Extra instructions for the agent', scope: 'user' },

  // ── Plugins ────────────────────────────────────────────────────────────────
  { key: 'plugins.dir', type: 'string', default: '/plugins', group: 'plugins', label: 'External plugin directory' },
  { key: 'plugins.allowGit', type: 'boolean', default: true, group: 'plugins', label: 'Allow installing plugins from git URLs' },
  { key: 'plugins.netAllowPrivate', type: 'boolean', default: false, group: 'plugins', label: 'Let plugins reach private/LAN hosts they declare' },
  { key: 'plugins.directoryUrl', type: 'string', default: 'https://raw.githubusercontent.com/Team-AER/hedwig/main/plugins/directory.json', group: 'plugins', label: 'Plugin directory index URL' },

  // ── UI ─────────────────────────────────────────────────────────────────────
  { key: 'ui.defaultTemplate', type: 'enum', default: 'streams', options: ['streams', 'triage', 'research', 'focused', 'compact', 'comfortable', 'wide', 'vertical'], group: 'ui', label: 'Default layout template', scope: 'user' },

  // --- v2 runtime ---
  { key: 'llm.lanes.interactive.concurrency', type: 'number', default: 2, min: 1, max: 64, group: 'models', label: 'Interactive lane: concurrent model calls (all processes)', help: 'Held in Redis so the API and worker share it; per-process when Redis is unavailable.' },
  { key: 'llm.lanes.background.concurrency', type: 'number', default: 1, min: 1, max: 64, group: 'models', label: 'Background lane: concurrent model calls (all processes)' },
  { key: 'llm.lanes.interactive.fallbackAfterMs', type: 'number', default: 60000, min: 500, max: 600000, group: 'models', label: 'Interactive lane: switch to the fallback after waiting (ms)', help: 'Replaces llm.fallbackAfterMs for calls a person is waiting on.' },
  { key: 'llm.lanes.leaseSec', type: 'number', default: 300, min: 10, max: 3600, group: 'models', label: 'Lane lease lifetime (s)', help: 'A slot held by a crashed process frees itself after this long.' },
  { key: 'llm.lanes.interactive.waitMs', type: 'number', default: 30_000, min: 1000, max: 600_000, group: 'models', label: 'Interactive lane: longest wait for a free slot (ms)', help: 'A person is waiting, so the call fails fast with "lane busy" (503) after this. The fallback model shares the lane, so it cannot help here.' },
  { key: 'llm.lanes.background.waitMs', type: 'number', default: 20 * 60_000, min: 1000, max: 6 * 3600_000, group: 'models', label: 'Background lane: longest wait for a free slot (ms)', help: 'Slots are handed out first come, first served. The wait does not count against the job timeout; a job still without a slot after this is deferred by jobs.laneDeferMin, attempts untouched.' },
  { key: 'llm.defaultMaxOutputTokens', type: 'number', default: 8192, min: 256, max: 262144, group: 'models', label: 'Output token cap when the catalog does not list one' },
  { key: 'llm.keepTranscripts', type: 'boolean', default: false, group: 'models', label: 'Keep prompt and output text of model calls', help: 'For debugging prompts. Stored in hedwig_ai_calls and pruned after llm.transcriptDays.' },
  { key: 'llm.transcriptDays', type: 'number', default: 14, min: 1, max: 365, group: 'models', label: 'Keep transcripts for (days)' },
  { key: 'llm.tokenBudget.triage', type: 'number', default: 400000, min: 0, max: 100000000, group: 'budgets', label: 'Triage tokens per user per day' },
  { key: 'llm.tokenBudget.extraction', type: 'number', default: 1500000, min: 0, max: 100000000, group: 'budgets', label: 'Extraction tokens per user per day' },
  { key: 'llm.tokenBudget.summary', type: 'number', default: 600000, min: 0, max: 100000000, group: 'budgets', label: 'Summary tokens per user per day' },
  { key: 'llm.tokenBudget.ask', type: 'number', default: 1000000, min: 0, max: 100000000, group: 'budgets', label: 'Ask tokens per user per day' },
  { key: 'llm.tokenBudget.agent', type: 'number', default: 2000000, min: 0, max: 100000000, group: 'budgets', label: 'Agent tokens per user per day' },
  { key: 'llm.tokenBudget.insights', type: 'number', default: 200000, min: 0, max: 100000000, group: 'budgets', label: 'Insight tokens per user per day' },
  { key: 'llm.tokenBudget.assistant', type: 'number', default: 500000, min: 0, max: 100000000, group: 'budgets', label: 'Compose assistant tokens per user per day' },
  { key: 'llm.tokenBudget.plugins', type: 'number', default: 500000, min: 0, max: 100000000, group: 'budgets', label: 'Tokens per plugin per user per day' },
  { key: 'llm.tokenBudget.sort', type: 'number', default: 2000000, min: 0, max: 100000000, group: 'budgets', label: 'Sorting (Reflex, Screener, spam) tokens per user per day' },
  { key: 'llm.tokenBudget.labels', type: 'number', default: 2000000, min: 0, max: 100000000, group: 'budgets', label: 'Label judge and question tokens per user per day' },
  { key: 'jobs.healthDeferMin', type: 'number', default: 10, min: 1, max: 1440, group: 'pipeline', label: 'Defer model jobs by (min) while the gateway is unreachable' },
  { key: 'jobs.reapAfterMin', type: 'number', default: 30, min: 1, max: 1440, group: 'pipeline', label: 'Requeue a running job with no timeout after (min)' },
  { key: 'jobs.healthGateSec', type: 'number', default: 60, min: 10, max: 3600, group: 'pipeline', label: 'Probe the gateway for the job health gate every (s)' },
  { key: 'jobs.reconcileEverySec', type: 'number', default: 900, min: 60, max: 86400, group: 'pipeline', label: 'Reconcile failed jobs every (s)' },
  { key: 'jobs.laneDeferMin', type: 'number', default: 5, min: 1, max: 1440, group: 'pipeline', label: 'Defer a job by (min) when its model lane stayed full for the whole wait', help: 'Deferred, not failed: attempts are untouched.' },
  // --- end v2 runtime ---
  // --- v2 runtime audit ---
  { key: 'llm.probe.enabled', type: 'boolean', default: true, group: 'models', label: 'Probe each configured model on a schedule', help: 'A tiny completion per model. A model that does not answer is marked degraded and its calls go straight to the fallback until it answers again, so no call pays the fallback wait.' },
  { key: 'llm.probe.everySec', type: 'number', default: 60, min: 15, max: 3600, group: 'models', label: 'Probe every (s)' },
  { key: 'llm.probe.timeoutMs', type: 'number', default: 60_000, min: 1000, max: 300_000, group: 'models', label: 'A probe that gets no answer within (ms) marks the model degraded', help: 'A one-token probe; a model that cannot start an answer within a minute is treated as unavailable until it answers again.' },
  { key: 'llm.probe.degradeAfter', type: 'number', default: 1, min: 1, max: 10, group: 'models', label: 'Failed probes in a row before a model is degraded' },
  { key: 'llm.probe.recoverAfter', type: 'number', default: 2, min: 1, max: 10, group: 'models', label: 'Answered probes in a row before traffic returns to a degraded model' },
  { key: 'llm.probe.degradedEverySec', type: 'number', default: 300, min: 60, max: 3600, group: 'models', label: 'Probe a degraded model only every (s)', help: 'A saturated model server may still queue and run a probe the client gave up on, so a degraded model is probed less often until it answers again.' },
  { key: 'llm.stream.firstToken', type: 'boolean', default: true, group: 'models', label: 'Measure the fallback wait to the first token', help: 'Calls that may fall back are streamed internally, so a slow but working answer is not cut off at the wait. Off: the wait bounds the whole answer.' },
  { key: 'routing.summary.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Summaries (people, topics, topic labels): model tier', help: 'auto = what each call site asks for (prompts/inline.js).' },
  { key: 'routing.extraction.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Commitments and facts extraction: model tier' },
  { key: 'routing.triage.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Triage stage 3: model tier' },
  { key: 'routing.insights.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Briefings: model tier' },
  { key: 'routing.assistant.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Upstream AI (message summaries, categories, compose assistant): model tier', help: 'auto = one-line summaries and categories on Reflex, the compose assistant on Reasoning.' },
  { key: 'jobs.retryEverySec', type: 'number', default: 3600, min: 600, max: 86400, group: 'pipeline', label: 'Retry failed jobs from their rebuild list every (s)', help: 'Only kinds that can rebuild their work from the data, and only rows that failed at least this long ago. Read when the worker starts: a change applies after a worker restart.' },
  { key: 'jobs.retryMaxPerRun', type: 'number', default: 200, min: 1, max: 10000, group: 'pipeline', label: 'Most jobs one scheduled retry enqueues' },
  // --- end v2 runtime audit ---

  // --- v2 labels ---
  { key: 'labels.questionsPerDay', type: 'number', default: 3, min: 0, max: 20, group: 'labels', label: 'Questions Hedwig may ask per day', scope: 'user' },
  { key: 'labels.judgeSample', type: 'number', default: 100, min: 0, max: 2000, group: 'labels', label: 'Messages the nightly judge reviews per user' },
  { key: 'labels.judgeHour', type: 'number', default: 3, min: 0, max: 23, group: 'labels', label: 'Nightly judge hour (server time)' },
  { key: 'labels.behaviourEverySec', type: 'number', default: 3600, min: 300, max: 86400, group: 'labels', label: 'Learn labels from behaviour every (s)' },
  { key: 'labels.judgeBatch', type: 'number', default: 5, min: 1, max: 12, group: 'labels', label: 'Messages per judge call' },
  { key: 'labels.judgeMinConfidence', type: 'number', default: 0.7, min: 0, max: 1, group: 'labels', label: 'Judge confidence needed for a silver label' },
  { key: 'labels.windowDays', type: 'number', default: 30, min: 1, max: 365, group: 'labels', label: 'Learn from behaviour on mail up to (days) old' },
  { key: 'labels.replyWithinHours', type: 'number', default: 24, min: 1, max: 168, group: 'labels', label: 'A reply within (h) means the message needed you' },
  { key: 'labels.archiveUnreadMin', type: 'number', default: 3, min: 2, max: 50, group: 'labels', label: 'Archived unread from one sender this often means not needs-you' },
  { key: 'labels.readEngagedSec', type: 'number', default: 30, min: 5, max: 600, group: 'labels', label: 'Reading longer than (s) counts as engaged' },
  { key: 'labels.bulkArchiveMin', type: 'number', default: 5, min: 2, max: 100, group: 'labels', label: 'Messages archived in the same second that count as skipped, not read' },
  { key: 'labels.askTriplesPerNight', type: 'number', default: 10, min: 0, max: 200, group: 'labels', label: 'Ask eval questions generated per user per night' },
  { key: 'eval.gatePoints', type: 'number', default: 2, min: 0, max: 50, group: 'labels', label: 'Eval gate: largest allowed drop in a gold metric (points)' },
  // --- end v2 labels ---

  // --- v2 sort ---
  { key: 'sort.enabled', type: 'boolean', default: true, group: 'sort', label: 'Sort mail into People, Reading and Records', scope: 'user' },
  { key: 'sort.autoScreen', type: 'boolean', default: true, group: 'sort', label: 'Screen new senders automatically when Hedwig is confident', help: 'Every automatic decision is logged in Hedwig today and can be undone.', scope: 'user' },
  { key: 'sort.autoScreenAbove', type: 'number', default: 0.75, min: 0, max: 1, group: 'sort', label: 'Auto-screen a sender at confidence above', scope: 'user' },
  { key: 'sort.escalateBelow', type: 'number', default: 0.6, min: 0, max: 1, group: 'sort', label: 'Ask the reasoning model when Reflex confidence is below' },
  { key: 'sort.bodyWaitSec', type: 'number', default: 120, min: 0, max: 86400, group: 'sort', label: 'Wait this long (s) for a message body before sorting from headers and snippet' },
  { key: 'sort.batchSize', type: 'number', default: 5, min: 1, max: 8, group: 'sort', label: 'Messages per Reflex call' },
  { key: 'sort.classifierDecideAbove', type: 'number', default: 0.85, min: 0.5, max: 1, group: 'sort', label: 'Let the classifier decide without Reflex at confidence above' },
  { key: 'sort.classifierMinSamples', type: 'number', default: 40, min: 5, max: 10000, group: 'sort', label: 'Labelled messages before the sorting classifier heads are used' },
  { key: 'sort.screenerHoldDays', type: 'number', default: 14, min: 0, max: 365, group: 'sort', label: 'Hold mail from undecided senders in the Screener when newer than (days)' },
  { key: 'sort.needsYouMaxAgeDays', type: 'number', default: 30, min: 0, max: 3650, group: 'sort', label: 'Needs you only for mail newer than (days)' },
  { key: 'sort.reflexMaxAgeDays', type: 'number', default: 14, min: 0, max: 3650, group: 'sort', label: 'Ask Reflex only about mail newer than (days)' },
  { key: 'sort.newTextChars', type: 'number', default: 2500, min: 200, max: 20000, group: 'sort', label: 'Characters of new text per message sent to Reflex' },
  { key: 'sort.quotedChars', type: 'number', default: 600, min: 0, max: 5000, group: 'sort', label: 'Characters of quoted context per message sent to Reflex' },
  { key: 'sort.correctionExamples', type: 'number', default: 5, min: 0, max: 20, group: 'sort', label: 'Recent corrections shown to Reflex as examples' },
  { key: 'sort.backfillBatch', type: 'number', default: 200, min: 0, max: 5000, group: 'sort', label: 'Unsorted history messages sorted per minute (cheap layers only)' },
  { key: 'spam.autoMove', type: 'boolean', default: false, group: 'sort', label: 'Move confident spam to the provider Junk folder', help: 'Opt-in. Every move is logged and undoable. Hedwig never deletes mail.', scope: 'user' },
  { key: 'spam.autoMoveAbove', type: 'number', default: 0.95, min: 0.5, max: 1, group: 'sort', label: 'Auto-move spam at confidence above', scope: 'user' },
  { key: 'spam.rescueAbove', type: 'number', default: 0.7, min: 0, max: 1, group: 'sort', label: 'Rescue mail from the spam folder at confidence above', scope: 'user' },
  { key: 'spam.suspectedDays', type: 'number', default: 30, min: 1, max: 365, group: 'sort', label: 'Check the spam folder and show suspected spam for (days)' },
  { key: 'spam.phishingEscalateBelow', type: 'number', default: 0.8, min: 0, max: 1, group: 'sort', label: 'Ask the reasoning model about suspected phishing below confidence' },
  // Same list as DEFAULT_TRUSTED_LINK_HOSTS in sort/spam.js (sort.test.js keeps them equal).
  { key: 'spam.trustedLinkHosts', type: 'json', group: 'sort', label: 'CDN and email-service link hosts that never count as a foreign link in phishing checks', default: [
    'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com', 'cloudfront.net', 'akamaized.net', 'akamaihd.net',
    'akamai.net', 'edgekey.net', 'fastly.net', 'jsdelivr.net', 'imgix.net', 'wikimedia.org', 'wikipedia.org',
    'googleusercontent.com', 'gstatic.com', 'ggpht.com', 'ytimg.com', 'twimg.com', 'fbcdn.net', 'licdn.com', 'gravatar.com',
    'w3.org', 'schema.org', 'sendgrid.net', 'list-manage.com', 'mailchimp.com', 'mcusercontent.com', 'mailchi.mp', 'hubspot.com',
    'hubspotemail.net', 'hubspotlinks.com', 'hs-sites.com', 'hsforms.com', 'hs-analytics.net', 'mailgun.org', 'mandrillapp.com',
    'sparkpostmail.com', 'exacttarget.com', 'sfmc-content.com', 'rs6.net', 'ctctcdn.com', 'klaviyo.com', 'klclick.com',
    'klclick1.com', 'createsend.com', 'createsend1.com', 'cmail19.com', 'cmail20.com', 'mailjet.com', 'mjt.lu', 'sendinblue.com',
    'brevo.com', 'amazonses.com', 'awstrack.me', 'substack.com', 'substackcdn.com', 'customeriomail.com', 'braze.com',
    'postmarkapp.com', 'mailerlite.com',
  ] },
  { key: 'rules.maxPerUser', type: 'number', default: 200, min: 1, max: 5000, group: 'sort', label: 'Sorting rules per user' },
  // --- end v2 sort ---
  // --- v2 sort audit ---
  { key: 'sort.reflexTriesPerDay', type: 'number', default: 3, min: 1, max: 24, group: 'sort', label: 'Reflex jobs per message a day before the Reflex sweep waits until tomorrow', help: 'The sweep re-enqueues mail still waiting for Reflex after its job failed or gave no answer.' },
  // --- end v2 sort audit ---
  // --- v2 index ---
  { key: 'index.tikaUrl', type: 'string', default: 'http://10.0.1.69:9998', group: 'index', label: 'Apache Tika URL (attachment text)' },
  { key: 'index.tikaEnabled', type: 'boolean', default: false, group: 'index', label: 'Extract attachment text with Tika', help: 'Off: attachments are indexed by name only. Never blocks the rest of indexing.' },
  { key: 'index.tikaMaxBytes', type: 'number', default: 20 * 1024 * 1024, min: 1024, max: 200 * 1024 * 1024, group: 'index', label: 'Largest attachment sent to Tika (bytes)' },
  { key: 'index.attachmentMaxChars', type: 'number', default: 100000, min: 1000, max: 2000000, group: 'index', label: 'Characters of attachment text kept' },
  { key: 'index.chunkTokens', type: 'number', default: 350, min: 64, max: 2000, group: 'index', label: 'Chunk size (tokens)' },
  { key: 'index.chunkOverlap', type: 'number', default: 50, min: 0, max: 500, group: 'index', label: 'Chunk overlap (tokens)' },
  { key: 'index.maxChunksPerMessage', type: 'number', default: 80, min: 4, max: 1000, group: 'index', label: 'Most chunks kept per message' },
  { key: 'index.recipe', type: 'string', default: 'v1', group: 'index', label: 'Chunker recipe version', help: 'Changing it re-chunks and re-embeds in the background; search keeps the old recipe until the new one is complete per user.' },
  { key: 'index.tsConfig', type: 'string', default: 'simple', group: 'index', label: 'Postgres text-search configuration' },
  { key: 'index.bodyRatePerSec', type: 'number', default: 1, min: 0.05, max: 100, group: 'index', label: 'Body/attachment fetches per second per mail host', help: 'Fractions allowed (0.5 = one every 2 s). Body fetching always yields to mail sync: it waits while the account is syncing, backfilling, connecting or in a provider cooldown, and backs off per account (1, 2, 4 … 15 min) when the server says "Connection not available" or "try again later".' },
  { key: 'index.bodyRateByProvider', type: 'json', default: { yahoo: 0.5 }, group: 'index', label: 'Body/attachment fetch rate per provider (fetches per second)', help: 'Replaces index.bodyRatePerSec for that provider: google, yahoo, apple, microsoft, purelymail, generic (same detection as the mail engine), or an exact IMAP host.' },
  { key: 'index.bodyConcurrency', type: 'number', default: 1, min: 1, max: 4, group: 'index', label: 'Body/attachment fetches in flight per account', help: 'Hedwig fetches share the account\'s IMAP connection pool with the mail app; keep this low.' },
  { key: 'index.bodyMaxAgeDays', type: 'number', default: 0, min: 0, max: 100000, group: 'index', label: 'Fetch bodies for mail up to (days) old', help: '0 = all mail.' },
  { key: 'index.indexSpamFolder', type: 'boolean', default: true, group: 'index', label: 'Index the server spam folder (hidden from search unless asked)' },
  { key: 'index.coverageEverySec', type: 'number', default: 60, min: 10, max: 3600, group: 'index', label: 'Recount index coverage every (s)' },
  { key: 'index.rrfWeights', type: 'json', default: { fts: 1, vec: 1, recency: 0.3 }, group: 'index', label: 'Retrieval fusion weights (full text, vectors, recency)' },
  { key: 'index.kindWeights', type: 'json', default: { header: 1, body: 1, attachment: 0.9, thread: 0.8, quote: 0.35 }, group: 'index', label: 'Retrieval weight per chunk kind' },
  { key: 'index.recencyHalfLifeDays', type: 'number', default: 180, min: 1, max: 36500, group: 'index', label: 'Recency prior half-life (days)' },
  { key: 'index.floor', type: 'number', default: 0.02, min: 0, max: 1, group: 'index', label: 'Fused-score cut (normalised fused score)', help: 'After fusion, drop chunks scoring below this (1.0 = first in both searches and brand new). Scores are ranks, so this only trims the tail; relevance is judged by the evidence gates below.' },
  { key: 'index.minCosine', type: 'number', default: 0.5, min: 0, max: 1, group: 'index', label: 'Evidence gate: least cosine similarity for a vector hit', help: 'Tuned on bge-m3 (unrelated questions top out near 0.49, related ones start near 0.52). Retune when changing the embedding model. 0 turns this gate off.' },
  { key: 'index.minCosineHash', type: 'number', default: 0.4, min: 0, max: 1, group: 'index', label: 'Evidence gate: least cosine similarity with hash embeddings', help: 'Used instead of the above with the lexical hash provider, whose cosines run much lower.' },
  { key: 'index.minTermCoverage', type: 'number', default: 0.5, min: 0, max: 1, group: 'index', label: 'Evidence gate: share of query words a full-text hit must contain', help: 'A chunk found only by full text needs this share of the question\'s words (stopwords aside), or the rank below. 0 turns this gate off.' },
  { key: 'index.minFtsRank', type: 'number', default: 0.8, min: 0, max: 2, group: 'index', label: 'Evidence gate: full-text rank that passes regardless of word share', help: 'ts_rank_cd normalised to 0–1, plus 0.5 for a phrase match. Above 1.5 never passes.' },
  { key: 'index.embedBatch', type: 'number', default: 32, min: 1, max: 512, group: 'index', label: 'Chunks per embedding call' },
  // --- end v2 index ---
  // --- v2 frontend ---
  { key: 'ui.powerMode', type: 'boolean', default: false, group: 'ui', label: 'Power mode (rules, routing, prompts and index status in Settings)', scope: 'user' },
  { key: 'ui.blur', type: 'number', default: 24, min: 0, max: 48, group: 'ui', label: 'Glass blur (px)', scope: 'user' },
  { key: 'ui.accent', type: 'string', default: '#007AFF', group: 'ui', label: 'Accent colour (hex)', scope: 'user' },
  { key: 'ui.notifications', type: 'boolean', default: true, group: 'ui', label: 'Tell me when something new needs me', scope: 'user' },
  { key: 'ui.helpMeWrite', type: 'boolean', default: true, group: 'ui', label: 'Help me write (quick replies, draft in my voice)', scope: 'user' },
  { key: 'ui.mailDark', type: 'enum', default: 'smart', options: ['smart', 'off'], group: 'ui', label: 'Dark mode for mail (smart = darken light mail in the dark theme, keeping images)', scope: 'user' },
  // --- end v2 frontend ---
  // --- v2 work ---
  { key: 'work.enabled', type: 'boolean', default: true, group: 'work', label: 'Working the inbox: lists, Done, thread stories, drafts, send guard', scope: 'user' },
  { key: 'work.storyMaxMessages', type: 'number', default: 20, min: 2, max: 100, group: 'work', label: 'Messages of a thread the story reads (most recent)' },
  { key: 'work.storyMessageChars', type: 'number', default: 1500, min: 200, max: 10000, group: 'work', label: 'Characters of new text per message in the story and draft prompts' },
  { key: 'work.quickReplies', type: 'boolean', default: true, group: 'work', label: 'Suggest one-line quick replies when a short answer fits', scope: 'user' },
  { key: 'work.quickReplyMaxChars', type: 'number', default: 1500, min: 100, max: 10000, group: 'work', label: 'Offer quick replies only when the latest message is shorter than (characters)' },
  { key: 'work.replyAllWarnAbove', type: 'number', default: 8, min: 1, max: 500, group: 'work', label: 'Warn before replying to more recipients than', scope: 'user' },
  { key: 'work.snoozeDefaultDays', type: 'number', default: 1, min: 1, max: 30, group: 'work', label: 'Snooze without a time: days ahead', scope: 'user' },
  { key: 'work.snoozeDefaultHour', type: 'number', default: 8, min: 0, max: 23, group: 'work', label: 'Snooze without a time: hour of day it comes back', scope: 'user' },
  { key: 'work.backFromSnoozeHours', type: 'number', default: 72, min: 1, max: 720, group: 'work', label: 'Show "Back from snooze" for (hours) after a snooze ends' },
  { key: 'work.waitingDefaultDays', type: 'number', default: 3, min: 1, max: 60, group: 'work', label: '"Remind me if no reply" default (days)', scope: 'user' },
  { key: 'work.voiceSamples', type: 'number', default: 5, min: 0, max: 20, group: 'work', label: 'Past replies to the same person read when drafting in your voice' },
  { key: 'llm.tokenBudget.work', type: 'number', default: 1000000, min: 0, max: 100000000, group: 'budgets', label: 'Working the inbox (stories, quick replies, drafts, nudges) tokens per user per day' },
  // --- end v2 work ---
  // --- v2 ask/cards ---
  { key: 'ask.retrieveLimit', type: 'number', default: 50, min: 5, max: 100, group: 'ask', label: 'Chunks retrieved per question' },
  { key: 'ask.contextTokens', type: 'number', default: 24000, min: 2000, max: 200000, group: 'ask', label: 'Evidence sent to the reasoning model per answer (tokens)' },
  { key: 'ask.maxAnswerTokens', type: 'number', default: 1200, min: 200, max: 8000, group: 'ask', label: 'Longest answer (tokens)' },
  { key: 'ask.messageChars', type: 'number', default: 4000, min: 300, max: 40000, group: 'ask', label: 'Most characters of evidence per message' },
  { key: 'ask.planReflex', type: 'boolean', default: true, group: 'ask', label: 'Ask the Reflex model to plan a question when the rules find no dates, people or folders' },
  { key: 'ask.planTimeoutMs', type: 'number', default: 500, min: 100, max: 10000, group: 'ask', label: 'Time allowed for the Reflex query plan (ms)' },
  { key: 'ask.followUpSources', type: 'number', default: 8, min: 0, max: 30, group: 'ask', label: 'Sources carried over from the previous answer in a follow-up' },
  { key: 'cards.enabled', type: 'boolean', default: true, group: 'cards', label: 'Records cards (receipts, deliveries, bookings, events, codes)', scope: 'user' },
  { key: 'cards.scanEverySec', type: 'number', default: 60, min: 10, max: 86400, group: 'cards', label: 'Look for newly sorted mail to make cards from every (s)' },
  { key: 'cards.scanBatch', type: 'number', default: 200, min: 1, max: 5000, group: 'cards', label: 'Sorted messages queued for cards per user per scan' },
  { key: 'cards.jobSize', type: 'number', default: 25, min: 1, max: 200, group: 'cards', label: 'Messages per cards job' },
  { key: 'cards.batchSize', type: 'number', default: 4, min: 1, max: 8, group: 'cards', label: 'Messages per Reflex card extraction call' },
  { key: 'cards.reflexPerJob', type: 'number', default: 5, min: 0, max: 50, group: 'cards', label: 'Reflex extraction calls per cards job (rate limit)' },
  { key: 'cards.reflexBundles', type: 'json', default: ['purchases', 'finance', 'travel', 'deliveries', 'calendar'], group: 'cards', label: 'Bundles whose mail goes to the Reflex model when no deterministic card is found' },
  { key: 'cards.maxAgeDays', type: 'number', default: 400, min: 1, max: 3650, group: 'cards', label: 'Make cards from mail up to (days) old' },
  { key: 'cards.reflexMaxAgeDays', type: 'number', default: 365, min: 0, max: 3650, group: 'cards', label: 'Ask the Reflex model about mail up to (days) old' },
  { key: 'cards.textChars', type: 'number', default: 3000, min: 300, max: 20000, group: 'cards', label: 'Characters of each message sent to the Reflex model' },
  { key: 'cards.subscriptionMinCharges', type: 'number', default: 3, min: 3, max: 12, group: 'cards', label: 'Receipts from one merchant at a steady interval before it counts as a subscription (at least 3: two charges cannot show a cadence)' },
  { key: 'cards.codeFreshMin', type: 'number', default: 15, min: 1, max: 1440, group: 'cards', label: 'Show a one-time code on the Brief for (min) after it arrives' },
  { key: 'cards.billDueDays', type: 'number', default: 7, min: 1, max: 60, group: 'cards', label: 'Show bills due within (days) on the Brief' },
  { key: 'cards.icsMaxBytes', type: 'number', default: 262144, min: 1024, max: 5242880, group: 'cards', label: 'Largest calendar attachment fetched (bytes)' },
  { key: 'llm.tokenBudget.cards', type: 'number', default: 500000, min: 0, max: 100000000, group: 'budgets', label: 'Card extraction tokens per user per day' },
  // --- end v2 ask/cards ---
  // --- v2 profile/onboarding/admin ---
  { key: 'profile.enabled', type: 'boolean', default: true, group: 'profile', label: 'Keep a short profile of how you handle mail (who matters, what you skip, how you write)', scope: 'user' },
  { key: 'profile.inPrompts', type: 'boolean', default: true, group: 'profile', label: 'Let sorting and drafting read your profile', scope: 'user' },
  { key: 'profile.weekday', type: 'number', default: 0, min: 0, max: 6, group: 'profile', label: 'Rebuild profiles on (0=Sun, server time)' },
  { key: 'profile.hour', type: 'number', default: 4, min: 0, max: 23, group: 'profile', label: 'Rebuild profiles at hour (server time)' },
  { key: 'profile.windowDays', type: 'number', default: 90, min: 7, max: 730, group: 'profile', label: 'Behaviour the profile learns from (days)' },
  { key: 'profile.maxLines', type: 'number', default: 40, min: 5, max: 80, group: 'profile', label: 'Longest profile (lines, pinned lines included)' },
  { key: 'profile.corrections', type: 'number', default: 30, min: 0, max: 200, group: 'profile', label: 'Recent corrections a rebuild reads' },
  { key: 'profile.minCount', type: 'number', default: 2, min: 1, max: 50, group: 'profile', label: 'Least count behind a fact (replies, skipped messages) before the profile may mention it' },
  { key: 'profile.sentSamples', type: 'number', default: 40, min: 0, max: 500, group: 'profile', label: 'Sent messages read to describe how you write' },
  { key: 'llm.tokenBudget.profile', type: 'number', default: 200000, min: 0, max: 100000000, group: 'budgets', label: 'Profile rebuild tokens per user per day' },
  { key: 'routing.sort.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Sorting (Reflex, Screener, spam): model tier', help: 'auto = each prompt\'s own tier. Applies to every prompt call charged to the feature.' },
  { key: 'routing.labels.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Labels (judge, questions, Ask triples): model tier' },
  { key: 'routing.ask.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Ask (plan, answer, verify): model tier' },
  { key: 'routing.cards.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Cards extraction: model tier' },
  { key: 'routing.work.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Working the inbox (stories, quick replies, drafts, nudges): model tier' },
  { key: 'routing.profile.tier', type: 'enum', default: 'auto', options: ['auto', 'reflex', 'reasoning'], group: 'routing', label: 'Profile rebuild: model tier' },
  { key: 'llm.models.enabled', type: 'json', default: [], group: 'models', label: 'Models people may pick for their own fast, long and agent roles', help: 'A subset of the catalog. Empty: nobody can override the models above.' },
  { key: 'onboarding.topSenders', type: 'number', default: 20, min: 1, max: 200, group: 'onboarding', label: 'Senders shown on "Sort the past"' },
  { key: 'onboarding.readyShare', type: 'number', default: 0.9, min: 0.1, max: 1, group: 'onboarding', label: 'Share of history indexed and sorted before "Sort the past" is ready' },
  { key: 'onboarding.done', type: 'boolean', default: false, group: 'onboarding', label: '"Sort the past" finished or dismissed', scope: 'user' },
  // --- end v2 profile/onboarding/admin ---
  // --- v2 work audit ---
  { key: 'work.summariesEager', type: 'boolean', default: true, group: 'work', label: 'Write thread stories and message TL;DRs as mail arrives (not only when a thread is opened)', scope: 'user' },
  { key: 'work.summariseThreadsPerCall', type: 'number', default: 4, min: 1, max: 8, group: 'work', label: 'Threads per summarise call (Tier 1)' },
  { key: 'work.tldrPerCall', type: 'number', default: 6, min: 1, max: 10, group: 'work', label: 'Messages per TL;DR call (Tier 1)' },
  { key: 'work.summariseThreadsPerJob', type: 'number', default: 12, min: 0, max: 200, group: 'work', label: 'Threads a summarise job writes before handing on to the next job' },
  { key: 'work.summariseMessagesPerJob', type: 'number', default: 36, min: 0, max: 500, group: 'work', label: 'Message TL;DRs a summarise job writes before handing on to the next job' },
  { key: 'work.storyEscalateAbove', type: 'number', default: 8, min: 2, max: 100, group: 'work', label: 'Threads with more messages than this get their story from Tier 2 (Tier 1 with a "lighter model" label while Tier 2 is degraded)' },
  { key: 'work.tldrChars', type: 'number', default: 1500, min: 200, max: 10000, group: 'work', label: 'Characters of each message the TL;DR reads' },
  { key: 'work.summariesEverySec', type: 'number', default: 1800, min: 60, max: 86400, group: 'work', label: 'Sweep for threads and messages without a summary every (s)' },
  { key: 'work.summariseRetryHours', type: 'number', default: 6, min: 1, max: 720, group: 'work', label: 'Retry a failed summary after (hours)' },
  { key: 'work.replyOverdueDays', type: 'number', default: 2, min: 1, max: 60, group: 'work', label: 'Needs you: a person who wrote to you directly has waited this many days for a reply', scope: 'user' },
  { key: 'work.deadlineSoonDays', type: 'number', default: 3, min: 0, max: 60, group: 'work', label: 'Needs you: something you owe is due within (days)', scope: 'user' },
  { key: 'work.needsDays', type: 'number', default: 30, min: 1, max: 365, group: 'work', label: 'Derive Needs you reasons over mail up to (days) old' },
  // --- end v2 work audit ---
  // --- v2 cards audit ---
  { key: 'cards.signalReflex', type: 'boolean', default: true, group: 'cards', label: 'Ask the Reflex model about People and Records mail that looks like an order, booking, invoice, ticket or delivery, whatever its bundle' },
  // --- end v2 cards audit ---
  // --- v2 index audit ---
  { key: 'labels.judgeDeferHours', type: 'number', default: 18, min: 0, max: 168, group: 'labels', label: 'While Tier 2 is degraded, wait up to (hours) for it before judging on Tier 1 alone', help: 'The judge needs two different models. Until then the nightly job waits (no attempt spent); after this many hours it runs only the Tier 1 side and marks its labels single-judge.' },
  { key: 'labels.historyDays', type: 'number', default: 3650, min: 30, max: 36500, group: 'labels', label: 'Learn "you replied" and "you wrote to them" labels from mail up to (days) old', help: 'Replies and sent mail are facts whatever their age; a newly connected account has little recent behaviour.' },
  { key: 'labels.behaviourQuestions', type: 'number', default: 5, min: 0, max: 50, group: 'labels', label: 'Questions queued per behaviour sweep where what you did disagrees with how Hedwig sorted', help: 'They join the judge\'s questions in one queue; at most labels.questionsPerDay are asked a day.' },
  { key: 'profile.deferHours', type: 'number', default: 24, min: 0, max: 168, group: 'profile', label: 'While Tier 2 is degraded, wait up to (hours) before rebuilding the profile on Tier 1 (marked provisional)' },
  { key: 'profile.fallbackDays', type: 'number', default: 365, min: 30, max: 3650, group: 'profile', label: 'When the last profile.windowDays hold too few facts, learn from up to (days) instead' },
  { key: 'insights.briefProseTier2Only', type: 'boolean', default: true, group: 'insights', label: 'Daily briefing prose only from Tier 2; the template (flagged) while Tier 2 is degraded' },
  // --- end v2 index audit ---
];

const BY_KEY = new Map(SCHEMA.map((f) => [f.key, f]));

export function envNameFor(key) {
  return 'HEDWIG_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\./g, '_').toUpperCase();
}

export function coerce(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  switch (field.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
      return Boolean(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return undefined;
      let v = n;
      if (field.min !== undefined) v = Math.max(field.min, v);
      if (field.max !== undefined) v = Math.min(field.max, v);
      return v;
    }
    case 'enum': {
      const s = String(raw).trim();
      return field.options.includes(s) ? s : undefined;
    }
    case 'json':
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return undefined; }
      }
      return raw;
    case 'secret': {
      const str = String(raw);
      if (str && isEncrypted(str)) {
        try { return decrypt(str); } catch { return undefined; }
      }
      return str;
    }
    default:
      return String(raw);
  }
}

function envValue(field, env = process.env) {
  const name = envNameFor(field.key);
  return name in env ? coerce(field, env[name]) : undefined;
}

let systemCache = null; // { values, expiry }
const userCache = new Map(); // userId -> { values, expiry }

async function loadSystemOverrides() {
  if (systemCache && systemCache.expiry > Date.now()) return systemCache.values;
  let values = {};
  try {
    const { rows } = await query("SELECT value FROM system_settings WHERE key = 'hedwig_config'");
    if (rows.length) values = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  } catch {
    values = {};
  }
  systemCache = { values: values || {}, expiry: Date.now() + CACHE_TTL_MS };
  return systemCache.values;
}

async function loadUserOverrides(userId) {
  if (!userId) return {};
  const cached = userCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.values;
  let values;
  try {
    const { rows } = await query('SELECT settings FROM hedwig_user_settings WHERE user_id = $1', [userId]);
    values = rows[0]?.settings || {};
  } catch {
    values = {};
  }
  userCache.set(userId, { values, expiry: Date.now() + CACHE_TTL_MS });
  return values;
}

export function invalidateConfigCache(userId) {
  systemCache = null;
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

// v2 admin model bounds: a user may override these role models, but only with a model the admin
// listed in llm.models.enabled. An override stops applying when the admin removes its model.
export const USER_MODEL_KEYS = Object.freeze(['llm.models.fast', 'llm.models.long', 'llm.models.agent']);

function enabledModels({ system = {}, env = process.env } = {}) {
  const field = BY_KEY.get('llm.models.enabled');
  const v = field ? resolveField(field, { system, env }) : [];
  return Array.isArray(v) ? v.map(String) : [];
}

function userMayOverride(field, value, layers) {
  if (field.scope === 'user') return true;
  return USER_MODEL_KEYS.includes(field.key) && enabledModels(layers).includes(String(value));
}

/** Resolve one field from the layers. Exported for tests. */
export function resolveField(field, { user = {}, system = {}, env = process.env } = {}) {
  if (user[field.key] !== undefined && userMayOverride(field, user[field.key], { system, env })) {
    const v = coerce(field, user[field.key]);
    if (v !== undefined) return v;
  }
  if (system[field.key] !== undefined) {
    const v = coerce(field, system[field.key]);
    if (v !== undefined) return v;
  }
  const e = envValue(field, env);
  if (e !== undefined) return e;
  return field.default;
}

/**
 * The effective config as a flat object keyed by dotted key, plus a `get(key)` helper.
 * @param {string} [userId]
 */
export async function getConfig(userId) {
  const [system, user] = await Promise.all([loadSystemOverrides(), loadUserOverrides(userId)]);
  const values = {};
  for (const field of SCHEMA) values[field.key] = resolveField(field, { user, system });
  return makeView(values);
}

function makeView(values) {
  return Object.freeze({
    ...values,
    get(key) {
      if (!BY_KEY.has(key)) throw new Error(`unknown hedwig config key: ${key}`);
      return values[key];
    },
  });
}

/** Where each value came from — for the settings UI. Secrets are masked. */
export async function describeConfig(userId) {
  const [system, user] = await Promise.all([loadSystemOverrides(), loadUserOverrides(userId)]);
  return SCHEMA.map((field) => {
    let source = 'default';
    if (user[field.key] !== undefined && userMayOverride(field, user[field.key], { system })) source = 'user';
    else if (system[field.key] !== undefined) source = 'admin';
    else if (envValue(field) !== undefined) source = 'env';
    let value = resolveField(field, { user, system });
    if (field.type === 'secret') value = value ? '••••••••' : '';
    return { ...field, value, source, env: envNameFor(field.key) };
  });
}

function validatePatch(patch, { allowScope }) {
  const out = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const field = BY_KEY.get(key);
    if (!field) { errors.push(`unknown key ${key}`); continue; }
    if (allowScope === 'user' && field.scope !== 'user' && !USER_MODEL_KEYS.includes(key)) { errors.push(`${key} is not a per-user setting`); continue; }
    if (raw === null) { out[key] = null; continue; } // null = clear the override
    if (field.type === 'secret' && raw === '••••••••') continue; // unchanged mask
    const v = coerce(field, raw);
    if (v === undefined) { errors.push(`invalid value for ${key}`); continue; }
    out[key] = v;
  }
  return { out, errors };
}

/** Merge an admin patch into system overrides. `null` clears a key. */
export async function saveSystemConfig(patch) {
  const { out, errors } = validatePatch(patch, { allowScope: 'system' });
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const current = { ...(await loadSystemOverrides()) };
  for (const [k, v] of Object.entries(out)) {
    if (v === null) delete current[k];
    else current[k] = BY_KEY.get(k).type === 'secret' && v ? encrypt(v) : v;
  }
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('hedwig_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(current)],
  );
  invalidateConfigCache();
  return current;
}

/** Merge a per-user patch. Only keys with scope 'user' are accepted. */
export async function saveUserConfig(userId, patch) {
  const { out, errors } = validatePatch(patch, { allowScope: 'user' });
  // Role models: only from the admin's enabled set (llm.models.enabled).
  const modelKeys = Object.keys(out).filter((k) => USER_MODEL_KEYS.includes(k) && out[k] !== null);
  if (modelKeys.length) {
    const allowed = enabledModels({ system: await loadSystemOverrides() });
    for (const k of modelKeys) if (!allowed.includes(String(out[k]))) errors.push(`${out[k]} is not one of the models enabled for ${k}`);
  }
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const current = { ...(await loadUserOverrides(userId)) };
  for (const [k, v] of Object.entries(out)) {
    if (v === null) delete current[k]; else current[k] = v;
  }
  await query(
    `INSERT INTO hedwig_user_settings (user_id, settings, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()`,
    [userId, JSON.stringify(current)],
  );
  invalidateConfigCache(userId);
  return current;
}
