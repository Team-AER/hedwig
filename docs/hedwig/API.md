# Hedwig API and service contracts

These shapes are the contract between the backend modules and the frontend views. Backend modules
implement them exactly; views consume them. All routes are under `/api/hedwig` and require a
session (`req.session.userId`). Admin routes are under `/api/hedwig/admin`. Mutating requests need
the `X-Requested-With` header (the frontend client adds it).

## Shared shapes

```ts
MessageLite = { id, account_id, account: { id, name, color }, folder, subject, from_name, from_email,
                date, snippet, is_read, is_starred, has_attachments, thread_key }
EntityLite  = { id, kind: 'person'|'org'|'self', display_name, primary_email, domain,
                message_count, last_seen, is_bulk }
Commitment  = { id, direction: 'i_owe'|'they_owe', counterparty, counterparty_entity_id, what, due_at,
                status: 'open'|'done'|'dismissed', source_message_id, thread_key, topic_id,
                confidence, created_at, overdue: boolean }
Fact        = { id, key, value, entity_id, topic_id, source_message_id, confidence, pinned }
TriageInfo  = { category, priority, needs_you, confidence, stage: 1|2|3, reason_label,
                reasons: [{ label, weight, direction: 'for'|'against' }], overridden, decided_at }
Insight     = { id, kind, title, body /* markdown */, data, sources: [messageId], severity:
                'info'|'warn'|'alert', created_at }
```

Triage categories: `needs_you`, `waiting_on`, `digest` (newsletters), `notifications`,
`everything` (the rest), `spam`.

SSE streams: `Content-Type: text/event-stream`; each event is `data: <json>\n\n`; the last event is
`{ "type": "done", ... }` or `{ "type": "error", "error": "..." }`.

## Context — `backend/src/hedwig/context/`

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/context/entities` | `q`, `kind`, `limit` | `EntityLite[]` |
| GET | `/context/entities/:id` | | `EntityCard` |
| GET | `/context/entities/by-email/:email` | | `EntityCard` (404 when unknown) |
| POST | `/context/entities/:id/refresh` | | `{ ok }` (regenerates the summary) |
| GET | `/context/topics` | `limit` | `[{ id, label, summary, message_count, first_seen, last_seen, open_commitments }]` |
| GET | `/context/topics/:id` | | `TopicCard` |
| GET | `/context/messages/:messageId` | | `MessageContext` |
| GET | `/context/commitments` | `status`, `direction`, `limit` | `Commitment[]` |
| PATCH | `/context/commitments/:id` | `{ status?, what?, due_at? }` | `Commitment` |
| PATCH | `/context/facts/:id` | `{ value?, dismissed?, pinned? }` | `Fact` |
| POST | `/context/search` | `{ q, limit?, entityId?, topicId?, after?, before? }` | `{ results: (MessageLite & { score })[] }` |
| POST | `/context/ask` (SSE) | `{ question, entityId?, topicId? }` | events below |
| GET | `/context/ask/history` | | `[{ id, question, created_at }]` |

```ts
EntityCard = { entity: EntityLite & { addresses: [{ email, name }], org: EntityLite|null, pinned },
               summary: { text, at, sources: [messageId] } | null,
               stats: { messages, you_sent, they_sent, first_seen, last_seen, accounts: [{ id, name, color }] },
               commitments: Commitment[], facts: Fact[], recent: MessageLite[],
               topics: [{ id, label, message_count, last_seen }] }
TopicCard  = { topic: { id, label, summary, summary_sources, message_count, first_seen, last_seen },
               timeline: [{ message: MessageLite, gist, marker: 'i_owe'|'they_owe'|'settled'|null }],
               people: EntityLite[], commitments: Commitment[], facts: Fact[] }
MessageContext = { sender: EntityCard|null, topic: { id, label }|null, commitments: Commitment[],
                   facts: Fact[], related: MessageLite[] }
```

Ask events: `{ type: 'sources', sources: [{ n, message: MessageLite }] }`, `{ type: 'delta', text }`,
`{ type: 'done', answer, citations: [n] }`. Answers cite sources as `[n]`.

Service exports (`context/service.js`) other modules may import:
`searchMessages(userId, opts)`, `findEntities(userId, q, limit)`, `getEntityCard(userId, id)`,
`resolveEntityByEmail(userId, email)`, `listTopics(userId, opts)`, `getTopicCard(userId, id)`,
`listCommitments(userId, opts)`, `updateCommitment(userId, id, patch)`,
`getMessageContext(userId, messageId)`, `answerQuestion(userId, question, { entityId, topicId, onEvent, signal })`.

## Triage — `backend/src/hedwig/triage/`

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/triage/list` | `view` (category), `accountId`, `limit`, `before` | `{ items: [{ message: MessageLite, triage: TriageInfo, thread: { count, participants } }], counts: { needs_you, waiting_on, digest, notifications, everything, spam } }` |
| GET | `/triage/messages/:messageId` | | `{ triage: TriageInfo, sender: { received, opened, replied, archived_unread } }` |
| POST | `/triage/messages/:messageId/override` | `{ category, reason? }` | `TriageInfo` |
| POST | `/triage/messages/:messageId/resolve` | | `{ ok }` (handled; leaves the needs-you list) |
| POST | `/triage/sender-rule` | `{ sender?, domain?, category, preview? }` | preview: `{ affected, siblings: [email], sample: MessageLite[] }`; apply: `{ applied }` |
| GET | `/triage/stats` | | `{ needsYouPrecision7d, needsYouOpen, corrections30d, modelCallsToday, stageCounts, samples, trainedAt, spamBeyondProvider }` |
| GET | `/triage/decisions` | `limit` | `[{ message: MessageLite, triage: TriageInfo }]` |
| POST | `/triage/retrain` | | `{ ok, samples, metrics }` |

Service exports (`triage/service.js`): `listTriage(userId, opts)`, `getTriage(userId, messageId)`,
`overrideTriage(userId, messageId, patch)`, `resolveTriage(userId, messageId)`, `triageStats(userId)`.

## Insights — `backend/src/hedwig/insights/`

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/insights/overview` | `days` (default 30) | `{ volume: [{ day, received, sent }], byAccount: [{ account, received, sent }], topSenders: [{ email, name, count, opened_rate, replied_rate }], responseTime: { median_hours, p90_hours, weekly: [{ week, median_hours }] }, owe: { i_owe, they_owe, overdue }, triage: { needs_you, waiting_on, digest, spam }, ai: { calls, prompt_tokens, completion_tokens } }` |
| GET | `/insights/cards` | | `Insight[]` (kind `card`, not dismissed) |
| POST | `/insights/cards/:id/dismiss` | | `{ ok }` |
| GET | `/insights/briefing` | | latest `Insight` of kind `briefing` or `null` |
| GET | `/insights/briefings` | `limit` | `Insight[]` |
| POST | `/insights/briefing/generate` | | `Insight` |

Service exports (`insights/service.js`): `overview(userId, { days })`, `listCards(userId)`,
`latestBriefing(userId)`, `generateBriefing(userId)`.

## Agent — `backend/src/hedwig/agent/`

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/agent/tools` | | `[{ name, description, mutates, pluginId }]` |
| POST | `/agent/runs` (SSE) | `{ prompt, runId?, allowedTools? }` | events below |
| GET | `/agent/runs` | `limit` | `[{ id, title, status, trigger, created_at }]` |
| GET | `/agent/runs/:id` | | `{ run: { id, title, status, messages, steps, result }, actions: Action[] }` |
| GET | `/agent/actions` | `status` | `Action[]` |
| POST | `/agent/actions/:id/approve` | | `{ action: Action, result }` |
| POST | `/agent/actions/:id/reject` | | `{ action: Action }` |
| GET | `/agent/automations` | | `Automation[]` |
| POST | `/agent/automations` | `{ name, prompt, schedule, allowed_tools?, deliver?, enabled? }` | `Automation` |
| PATCH | `/agent/automations/:id` | same fields | `Automation` |
| DELETE | `/agent/automations/:id` | | `{ ok }` |
| POST | `/agent/automations/:id/run` | | `{ runId }` |

```ts
Action     = { id, run_id, tool, args, summary, status: 'pending'|'approved'|'rejected'|'executed'|'failed', result, created_at }
Automation = { id, name, prompt, schedule, enabled, allowed_tools, deliver: 'insight'|'notification', last_run_at, next_run_at }
```

Schedules: `daily@HH:MM`, `weekdays@HH:MM`, `weekly@<0-6>@HH:MM`, `every@<N>m`, `every@<N>h`, in the
user's `insights.timezone`.

Run events: `{ type: 'run', runId }`, `{ type: 'tool_call', id, name, arguments }`,
`{ type: 'tool_result', id, name, ok, summary }`, `{ type: 'action_pending', action: Action }`,
`{ type: 'delta', text }`, `{ type: 'done', runId, status, result }`.

## Plugins v2 — `backend/src/hedwig/pluginsv2/`

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/plugins` | | `PluginInfo[]` |
| POST | `/plugins/:id/enable` | `{ grants: [permission] }` | `PluginInfo` |
| POST | `/plugins/:id/disable` | | `PluginInfo` |
| PATCH | `/plugins/:id/grants` | `{ grants: [permission] }` | `PluginInfo` |
| GET | `/plugins/:id/frontend.js` | | ES module (`application/javascript`) |
| GET/PUT | `/plugins/:id/settings` | JSON | the plugin's per-user settings |
| ALL | `/p/:pluginId/*` | | the plugin's own routes |
| GET | `/admin/plugins` | | `PluginInfo[]` plus install details |
| POST | `/admin/plugins/install` | `{ source: 'git'|'dir', location }` | `PluginInfo` |
| POST | `/admin/plugins/:id/reload` | | `PluginInfo` |
| DELETE | `/admin/plugins/:id` | | `{ ok }` |
| GET | `/admin/plugins/directory` | | `[{ id, name, description, source, location, version }]` |

```ts
PluginInfo = { id, name, version, tier, source, description, author, activated, status, error,
               permissions: [{ name, description, granted, optional }],
               hooks: string[], views: string[], tools: string[], commands: string[],
               hasFrontend, frontendUrl, settingsSchema }
```

Frontend bundles are ES modules that receive the host API as `window.hedwig`:
`{ React, h, registerView, registerCommand, registerSlot, api, stream, useHedwig, tokens, pluginId }`.

## Runtime — `backend/src/hedwig/jobs.js`, `ledger/`, `prompts/`

Admin only (`/api/hedwig/admin`). The job ledger's states are `queued`, `running`, `done`, `partial`
(the handler returned `{ status: 'partial', note }`), `failed`, and two terminal states for rows
that failed: `resolved` (a later run of the same work succeeded, or the kind's `rebuild()` no longer
lists it) and `retried` (a fresh job was enqueued for it). "Failed" counts only rows still failed.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/admin/jobs/stats` | | `{ kinds: JobKind[], stats: JobStats[], gateway: GatewayHealth }` |
| GET | `/admin/jobs/failed` | `kind?`, `limit?` (≤ 500, default 50) | `{ jobs: FailedJob[] }`, newest first |
| POST | `/admin/jobs/retry` | `{ kind? }` (omit for every kind) | `{ retried, enqueued, resolved }` |
| POST | `/admin/jobs/reconcile` | | `{ resolved, reaped, gateway: { ok, deferred, error? } }` (runs reconcile, the reaper and the health gate now) |
| POST | `/admin/jobs/retry-failed` | | `{ retried, enqueued, resolved }` (older route, now the same as `/admin/jobs/retry` for every kind) |
| GET | `/admin/prompts` | | `{ prompts: [{ id, version, hash, tier, feature, maxTokens, batch }] }` |

```ts
JobKind       = { kind, timeoutMs, rebuild: boolean, needsGateway: boolean }   // kinds defined in this process
JobStats      = { kind, pending, running, failed_24h, done_24h, last_error, tokens_in, tokens_out,
                  status: { queued, running, done, partial, failed, resolved, retried } } // last 7 days + all still-failed rows
FailedJob     = { id, kind, user_id, payload, dedupe_key, attempts, max_attempts, last_error, note,
                  created_at, failed_at, tokens_in, tokens_out }
GatewayHealth = { ok, checkedAt /* epoch ms, 0 = not probed in this process */, error }
```

`GET /admin/health` also carries `gateway: GatewayHealth`. `GET /usage` adds `tokenBudgets`
(`llm.tokenBudget.<feature>`, tokens per user per day) next to `budgets` (calls per day).

Model-call provenance: every row of `hedwig_ai_calls` now records `prompt_id`, `prompt_version`,
`prompt_hash`, `lane` (`interactive|background`), `tier` (`reflex|reasoning`), `workflow` (the
`X-Workflow` header sent to the gateway) and `job_id`; `prompt_text`/`output_text` only while
`llm.keepTranscripts` is on (nulled after `llm.transcriptDays`). `runPrompt` returns the same
provenance as `{ aiCallId, promptId, promptVersion, promptHash, model, tier, fellBack, tokensIn,
tokensOut, attempts, escalated, repaired, dropped }`; store `aiCallId` next to anything derived
from a model call.
