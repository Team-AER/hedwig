# Audit: model runtime and admin (area B, 2026-09-24)

Scope: `backend/src/hedwig/llm.js`, `prompts/index.js`, `prompts/lanes.js`, `prompts/inline.js`
(new), `ledger/**`, `jobs.js`, the runtime schedules, the admin routes under `/api/hedwig/admin/*`
that are the runtime's, `/api/hedwig/status`, and `testing/mockGateway.js`. The evidence is
read-only production data: `prodsql.sh` SELECTs at 2026-09-23 22:58 UTC, `prodlogs.sh`, and
`redis-cli CLIENT LIST` on the prod Redis. The live gateway was probed with `X-Session-ID:
hedwig-audit`.

The user asked: "Where are my email summaries fast model config etc."

## Summary

1. **Qwen is slow, not down, and nothing in Hedwig could tell the difference.** Every Qwen call
   after 09:33 UTC on 23 Sep failed, and none has succeeded since the v2 deploy at 17:11 UTC. In
   the 48 h window there were 24 failures: 13 "no response within 45000 ms", 10 "timeout" at
   240 s, and 1 abort. Together they cost 2,324 s (39 min) of model-lane time. The 42 Qwen calls
   that did succeed averaged 75 s (max 116 s): 38 on the evening of 22 Sep and 4 on the morning of
   23 Sep. The live Qwen still gives no first token in 25 s. vLLM on dgx-spark shows 4 running and
   10 waiting, all 10 "deferred", from other clients. Gemma answers in about 0.2 s.
2. **Every Tier 2 call paid the 45 s wait, and the fallback verdict stayed private to one process.**
   A primary that timed out was skipped for `llm.fallbackCooldownSec` (300 s), in that process only.
   After the cooldown the next call paid 45 s again. With background concurrency 1, those 45 s
   blocked all background model work: 6 × 45 s after the v2 deploy. The job health gate probes only
   `catalog.json`, which answers instantly, so it never deferred anything.
3. **After the v2 deploy, Gemma answered all 80 successful Tier 2 calls** (labels at
   `tier=reasoning`: 63; summaries: 17), and nothing was shown to the user. `/api/hedwig/status`
   returned `models.long.degraded` from the API process's own memory. The API process had made no
   model calls, so the flag was always `false`.
4. **Half the rows written after the deploy have no prompt or tier.** Of the 209 rows since
   17:11 UTC, 103 have no `tier` or `prompt_id`: extraction 84 and summary 19, from
   `context/extract.js` and `context/summaries.js` calling `chat()` directly. All 115 rows from
   before the deploy lack lane, tier, prompt and workflow, and 99 of them lack a user. After the
   deploy, `lane`, `workflow` and `user_id` are always set.
5. **The worker does connect to Redis.** Prod `CLIENT LIST` shows the worker (172.18.0.3) as a
   node-redis client whose age matches its first model call, with `cmd=zrem`. The single
   `lanes: redis not connected` warning came from the first call. That call started the connect
   and meanwhile ran on a per-process semaphore, so it was outside the shared lane limit.
6. **`reconcile` and `reapStuck` run on a schedule, but `retryFailed` never does.**
   `ledger/schedules.js` registers `runtime.reconcile` every 900 s and `runtime.reapStuck` every
   300 s in the worker. `retryFailed` ran only from `POST /admin/jobs/retry`. So job 1048
   (`sort.reflex`, failed at 17:31 with "the background model lane stayed full for 240 s") is still
   failed. It failed under the code that ran before `4994384`. Current code already defers
   `lane_busy`, but it wrote status `queued`, and only when the error code was not wrapped.
7. **The model settings exist, but only as a raw key list.** The only user is admin. **Settings →
   Models** (`hedwig.settings.models`, `ModelSettings.jsx`) renders every config key from
   `GET /admin/config`. `llm.models.fast` is labelled "Fast model: the Reflex tier…",
   `llm.models.long` is labelled "Long model (summaries, ask, briefings)", and nothing says Tier 2.
   There was no admin route that describes the tiers, lists catalog capabilities, or reports usage
   by tier.

## Requirements → status → evidence → severity → action

Severity: **S1** means the user sees broken or silently degraded behaviour. **S2** means
correctness or operations suffer. **S3** means a gap with a workaround.

| # | Requirement (source) | Before | Evidence | Sev | Action (this change) |
|---|---|---|---|---|---|
| 1 | Qwen slow/down: Gemma answers with a "lighter model" label (PRD v2 Fallbacks) | Partial: fallback worked, no label anywhere | 80/80 Tier 2 answers on Gemma after the deploy; `provenance` had only `fellBack` | S1 | `runPrompt` provenance and `chat()` results carry `tier`, `servedTier`, `lighterModel`; `tierStatus().notice` = "Tier 2 is slow; using the lighter model" on `/status` |
| 2 | Detect degradation cheaply; do not make every call wait (task 1) | Missing | 24 Qwen failures cost 2,324 s; health gate probes catalog only | S1 | `probeModels()`: streamed 8-token completion per model every `llm.probe.everySec` (60 s), `llm.probe.timeoutMs` (10 s); degraded after `degradeAfter` (1) failures, recovers after `recoverAfter` (2) answers; offline catalog entries degraded without a request; verdicts in Redis `hedwig:model-health:<model>` so API and worker agree; degraded primary → attempts go straight to the fallback |
| 3 | Per-lane fallback waits: interactive 8 s first token, background 45 s (PRD AI runtime) | Partial | Keys existed, but a non-streamed call's "first byte" is the whole answer, so a 75 s answer from a working Qwen was cut off at 45 s | S2 | Calls that may fall back are streamed internally (`llm.stream.firstToken`, default on), so the wait is measured to the first token. For streams, the timer runs until the first chunk, not just the headers. |
| 4 | Every output records the tier and model that produced it (PRD v2) | Partial | 103 rows since the deploy had no tier | S2 | Inline prompt registry (`prompts/inline.js`) fills `prompt_id`, `prompt_version='inline'`, `prompt_hash` (hash of the system message sent), `tier`, and `X-Workflow` for every unregistered call. New columns `fell_back`, `escalated` (h0020). |
| 5 | Every call through the registry with lane, tier, feature, prompt id/version, user, X-Workflow; upstream included (PRD AI runtime, Upstream AI) | Partial | Upstream summarize and categorize ran as feature `assistant`, role `long`, so a one-line TL;DR paid the Tier 2 wait. No prompt id. | S1 | Call sites are resolved from an explicit `workflow` or from the stack: `upstream.summarize`, `upstream.categorize` (both **Tier 1 Reflex** by default), `upstream.chat`, `context.summary`, `context.topicLabel`, `context.extract`, `triage.stage3`, `insights.brief`, `agent.step`, `plugin.*`. `routing.<feature>.tier` now applies to them too (new keys for summary, extraction, triage, insights, assistant). |
| 6 | Reasoning effort clamped to the catalog (PRD) | Done | `clampEffort`; live Qwen rejects `off`, so `none` is sent | — | Kept. The admin API now shows the allowed efforts and the value actually sent (`wireEffort`, `notes`). |
| 7 | Lanes held in Redis across API and worker (PRD) | Done, with a start-up gap | Worker connected lazily; first call used a local semaphore | S3 | `runtimeRedis()` waits up to 3 s for the connect on first use; the worker connects at start (`worker.js` block) |
| 8 | Job states incl. deferral without spending attempts; lane-full is not a failure (PRD, task 4) | Partial | Job 1048 failed on lane-full; deferrals wrote `queued` | S2 | New state `deferred` for model-capacity waits (lane full, gateway down, `tier_degraded`); `lane_busy` recognised through wrapped `cause` chains and by message; handler `deferJob()` keeps `queued` (mail yield) |
| 9 | Reconcile on admin load and hourly; retry rebuilds from data; reaper (PRD) | Partial | `retryFailed` admin-only; reconcile every 15 min; no reconcile on page load | S2 | `runtime.retryFailed` hourly: reconcile, then `retryFailed({ rebuildOnly, olderThanSec, max })`. Only kinds with `rebuild()` are retried unattended. Reconcile also runs (throttled to once a minute) when `/admin/health` or `/admin/jobs/stats` loads. |
| 10 | Health gate defers when the gateway does not answer (PRD) | Done for "down", blind to "slow" | Catalog OK while Qwen queued | S2 | The per-model probe covers "slow". Callers that must not use the fallback (`allowLighter: false`) get `tier_degraded` at once, and the job defers. |
| 11 | Admin picks the model per tier from the catalog (PRD Operations, Admin) | Partial | Generic key form; no capabilities or tier names | S1 | `GET/PUT /admin/runtime`, `GET /admin/models/catalog` (below); tier names Tier 1 Reflex / Tier 2 Reasoning |
| 12 | Routing table by feature, budgets (PRD) | Done (onboarding area) | `GET/PUT /admin/routing` | — | Inline call sites now appear in it (`listPrompts()` includes them), with new routing keys |
| 13 | Dashboard: calls, tokens, latency, escalation rate per feature (PRD Operations) | Missing | `/admin/health` had per-feature 24 h calls only | S2 | `GET /admin/usage?days=` per day × feature × tier × model, and per feature × tier with error, fallback and escalation rates |
| 14 | Status shows which model serves each tier and whether Tier 2 is degraded (brief) | Wrong | Flag from API memory; always false | S1 | `/api/hedwig/status` → `tiers` (shared state); `/admin/health` → `tiers`; `GET /admin/tiers`, `POST /admin/tiers/probe` |
| 15 | Agent tool calls on fallback | Latent bug | The fallback (Gemma) has no tool calling | S2 | Calls that offer tools never fall back to a model without `tools`. With a degraded primary they fail at once with `tier_degraded` instead of waiting 240 s. |
| 16 | User picks effort / budgets within the admin's bounds (PRD Power mode 3) | Missing | `llm.reasoning.*` are system keys | S3 | Open, see below |

## What changed

Owned files:

- `llm.js`: model health (probe, Redis sharing, call marks), `tierStatus()`, `modelHealth()`,
  `probeModels()`, `TIER_INFO`, `roleTier()`. Unregistered calls get an inline prompt and follow
  routing. Calls that may fall back are streamed internally, and a first-token timer runs until the
  first chunk. New `noFallback` / `tier_degraded`. Tool calls never land on a tool-less fallback.
  `servedBy` annotations on every result. `fell_back`/`escalated` are logged.
- `prompts/index.js`: provenance gains `servedTier` and `lighterModel`. New
  `allowLighter: false`. Escalations are flagged on the call. `listPrompts()` includes the inline
  call sites.
- `prompts/inline.js` (new): the inline call-site registry and the stack resolver.
- `prompts/lanes.js`: `runtimeRedis()` and `connectRuntimeRedis()`. The first acquire waits for
  the connect, and a failed connect is retried.
- `jobs.js`: `deferred` state; `lane_busy` and `tier_degraded` are deferrals, including when a
  handler wraps them; `retryFailed(kind, { rebuildOnly, olderThanSec, max })` returns `skipped`;
  `queueStats` counts `deferred`.
- `ledger/schedules.js`: `runtime.probeModels` (60 s), `runtime.retryFailed` (1 h, via
  `scheduledRetry()`).
- `ledger/admin.js` (new) and `ledger/routes.js`: the routes below; reconcile on admin load.
- `core/index.js`: `/status` and `/admin/health` return `tiers`; `/admin/health` reconciles
  (throttled).
- `testing/mockGateway.js`: `gw.stall()`, `gw.delay(ms, data, { firstChunkMs, totalMs })`,
  `gw.health(model, 'ok'|'hang'|status)`; probe requests answer `ok` by default.
- `migrations-hedwig/h0020_runtime_audit.sql`: `hedwig_ai_calls.fell_back`, `.escalated`, a
  `created_at` index, and a partial index on deferred jobs.

Shared files (append-only blocks):

- `config.js` `// --- v2 runtime audit ---`: `llm.probe.enabled` (true), `llm.probe.everySec`
  (60), `llm.probe.timeoutMs` (10000), `llm.probe.degradeAfter` (1), `llm.probe.recoverAfter` (2),
  `llm.stream.firstToken` (true), `routing.summary.tier`, `routing.extraction.tier`,
  `routing.triage.tier`, `routing.insights.tier`, `routing.assistant.tier` (all `auto`),
  `jobs.retryEverySec` (3600), `jobs.retryMaxPerRun` (200).
- `worker.js` `// --- v2 runtime audit ---`: connects Redis at start.

Behaviour change to note: under routing `auto`, upstream one-line message summaries and the upstream
categoriser now run on Tier 1 (Gemma) instead of Tier 2. Everything else keeps the role its caller
asks for. With today's Qwen, the probe marks it degraded within a minute of the worker starting, and
Tier 2 work goes to Gemma with no 45 s wait. `/status` then shows the notice.

## Admin and status API contract (for the settings page)

All admin routes are under `/api/hedwig/admin` with `requireAuth` and `requireAdmin`. Tier names:
`reflex` = **Tier 1 Reflex** (config role `fast`), `reasoning` = **Tier 2 Reasoning** (role
`long`), and `agent` = the Tier 2 tool-calling model (role `agent`).

### `GET /api/hedwig/status` (every user): new field `tiers`

The existing `models` field keeps its shape.

```json
{
  "tiers": {
    "reflex":    { "tier": "reflex", "label": "Tier 1 Reflex", "role": "fast", "model": "google/gemma-4-12B-it-qat-w4a16-ct",
                   "fallback": null, "active": "google/gemma-4-12B-it-qat-w4a16-ct", "degraded": false, "lighterModel": false,
                   "reason": null, "source": null, "since": null, "checkedAt": "2026-09-24T05:01:00.000Z", "latencyMs": 180 },
    "reasoning": { "tier": "reasoning", "label": "Tier 2 Reasoning", "role": "long", "model": "Qwen/Qwen3.8-Flash-Next",
                   "fallback": "google/gemma-4-12B-it-qat-w4a16-ct", "active": "google/gemma-4-12B-it-qat-w4a16-ct",
                   "degraded": true, "lighterModel": true, "reason": "no answer within 10000 ms", "source": "probe",
                   "since": "2026-09-24T05:00:00.000Z", "checkedAt": "…", "latencyMs": null },
    "agent":     { "tier": "reasoning", "label": "Agent (Tier 2, tool calling)", "role": "agent", "…": "same fields" },
    "notice": { "level": "warning", "tier": "reasoning", "text": "Tier 2 is slow; using the lighter model",
                "detail": "Qwen/Qwen3.8-Flash-Next: no answer within 10000 ms. google/gemma-… answers Tier 2 work until it recovers." },
    "probe": { "enabled": true, "everySec": 60, "timeoutMs": 10000, "lastRunAt": "…" }
  }
}
```

`notice` is `null` when all is well. Its other texts are "Tier 2 is not answering" (no fallback
configured) and "Tier 1 is not answering; rules and classifiers sort until it is back"
(`level: "error"`). `source` is `probe`, `catalog` or `call`. `tiers` is `null` if it could not be
computed.

### `GET /admin/tiers` and `POST /admin/tiers/probe`

`GET` returns the same object as `status.tiers`. `POST` probes every watched model now, then
returns that object plus `probed: [{ model, ok, latencyMs, error, degraded }]` and `skipped`
(a reason string, or `null`).

### `GET /admin/runtime`

```json
{
  "tiers": {
    "reflex":    { "label": "Tier 1 Reflex", "role": "fast", "modelKey": "llm.models.fast", "model": "google/…", "modelSource": "env",
                   "effortKey": "llm.reasoning.fast", "effort": "off", "effortSource": "default",
                   "efforts": ["off", "high"], "wireEffort": "none", "inCatalog": true },
    "reasoning": { "label": "Tier 2 Reasoning", "role": "long", "…": "…", "efforts": ["off", "low", "medium", "xhigh"], "wireEffort": "low" },
    "agent":     { "label": "Agent (Tier 2, tool calling)", "role": "agent", "…": "…" }
  },
  "fallback": { "model": "google/…", "modelKey": "llm.fallbackModel", "modelSource": "env",
                "afterMs": { "interactive": 8000, "background": 45000 }, "cooldownSec": 300 },
  "lanes": { "interactive": { "concurrency": 2, "waitMs": 30000, "fallbackAfterMs": 8000 },
             "background":  { "concurrency": 1, "waitMs": 1200000, "fallbackAfterMs": 45000 } },
  "probe": { "enabled": true, "everySec": 60, "timeoutMs": 10000, "degradeAfter": 1, "recoverAfter": 2 },
  "streamFirstToken": true,
  "enabledModels": [],
  "budgets": { "sort": { "tokens": 2000000, "tokensKey": "llm.tokenBudget.sort", "calls": null, "callsKey": null },
               "ask":  { "tokens": 1000000, "tokensKey": "llm.tokenBudget.ask", "calls": 200, "callsKey": "llm.dailyBudget.ask" } },
  "status": { "…": "same object as GET /admin/tiers" }
}
```

`*Source` is `default`, `env` or `admin`. Only `admin` values can be reset: send `null`.

### `PUT /admin/runtime`

Every field is optional. `null` clears the admin override, which falls back to env, then default.

```json
{
  "models":  { "fast": "id", "long": "id", "agent": "id", "fallback": "id" | "" },
  "effort":  { "fast": "off|low|medium|high|xhigh", "long": "…", "agent": "…" },
  "lanes":   { "interactive": { "concurrency": 2, "waitMs": 30000, "fallbackAfterMs": 8000 },
               "background":  { "concurrency": 1, "waitMs": 1200000, "fallbackAfterMs": 45000 } },
  "fallback": { "cooldownSec": 300, "model": "id" },
  "probe":   { "enabled": true, "everySec": 60, "timeoutMs": 10000, "degradeAfter": 1, "recoverAfter": 2 },
  "streamFirstToken": true,
  "budgets": { "<feature>": { "tokens": 123456, "calls": 200 } },
  "enabledModels": ["id", "…"]
}
```

- `models` and `effort` also accept the tier names `reflex` and `reasoning` as keys.
- `fallback: ""` means no fallback. `lanes.background.fallbackAfterMs` writes `llm.fallbackAfterMs`.
- The response is the `GET` shape plus `changed` (a list of config keys) and `notes`, for example
  "google/… accepts none/high; low is sent as none".
- These return 400 with `{ "error": "…" }`: an id that is not in the catalog, a non-chat model, an
  agent model without `tools`, an effort that is not on the ladder, unknown fields, unknown budget
  features, and a `calls` budget for a feature that has none.

### `GET /admin/models/catalog?refresh=1`

```json
{
  "generatedAt": "2026-09-24T…",
  "models": [{
    "id": "Qwen/Qwen3.8-Flash-Next", "displayName": "Qwen 3.8 Flash Next", "node": "dgx-spark", "status": "ready", "disabledAt": null,
    "capabilities": ["chat", "completions", "responses", "tools", "reasoning", "streaming"],
    "chat": true, "tools": true, "reasoning": true, "streaming": true, "embeddings": false,
    "contextWindow": 262144, "maxOutputTokens": 65536, "reasoningEfforts": ["off", "low", "medium", "xhigh"], "defaultReasoningEffort": "medium",
    "roles": ["long", "agent"], "tiers": ["reasoning", "agent"], "fallback": false, "enabled": false,
    "health": { "degraded": true, "source": "probe", "reason": "no answer within 10000 ms", "since": "…", "checkedAt": "…", "latencyMs": null, "lastError": "…", "lastOkAt": null }
  }]
}
```

Embedding and image models are listed too, with `chat: false`. Pickers should filter on `chat`, and
on `tools` for the agent role. The raw catalog stays at `GET /admin/catalog`.

### `GET /admin/usage?days=7&userId=<uuid>`

`days` is 1 to 90. Without `userId` the report covers the whole household.

```json
{
  "days": 7, "userId": null,
  "daily":    [{ "day": "2026-09-23", "feature": "labels", "tier": "reasoning", "model": "google/…", "calls": 63, "errors": 0,
                 "fellBack": 63, "escalated": 0, "tokensIn": 1000, "tokensOut": 200, "avgLatencyMs": 3000, "p95LatencyMs": 9000 }],
  "features": [{ "feature": "labels", "tier": "reasoning", "calls": 67, "errors": 4, "fellBack": 63, "escalated": 0, "tokens": 1200,
                 "avgLatencyMs": 5000, "p95LatencyMs": 45000, "errorRate": 0.06, "fallbackRate": 0.94, "escalationRate": 0 }],
  "tiers":    { "reflex": { "calls": 0, "errors": 0, "fellBack": 0, "tokens": 0 }, "reasoning": { "…": "…" }, "unknown": { "…": "…" } },
  "escalation": { "escalated": 1, "calls": 80, "rate": 0.013 }
}
```

`tier: "unknown"` marks rows written before this change. `fellBack` and `escalated` are counted
from h0020 onward.

### Existing routes the settings page also needs (unchanged)

- `GET/PUT /admin/routing` (onboarding area). The body is
  `{ <feature>: { tier: auto|reflex|reasoning|null, escalateBelow, budget } }`. Features now
  include `summary`, `extraction`, `triage`, `insights` and `assistant`, from the inline call sites.
- `GET /routing` is the read-only copy for every user.
- `GET/PUT /admin/models/enabled` sets the models users may pick for their own roles.
- `GET/PATCH /admin/config` is every key as a raw form. `POST /admin/test-llm { role }` runs a
  quick test.
- `GET /admin/jobs/stats`: `stats[].status` now includes `deferred`.
- `GET /admin/jobs/failed`, `POST /admin/jobs/retry { kind? }` (returns
  `{ retried, enqueued, resolved, skipped }`), `POST /admin/jobs/reconcile`, `GET /admin/prompts`.
  In `/admin/prompts`, inline call sites have `inline: true, version: "inline"`.

## Requests for other areas

- **D, labels:** call `runPrompt('labels.judge', …, { allowLighter: false })`. A degraded Tier 2
  then defers the nightly judge (`tier_degraded` → `deferred`) instead of letting Gemma judge
  against Gemma. Also drop or mark any stored label whose `provenance.lighterModel` is true.
- **Context, insights and triage owners:** move the inline prompts into `prompts/<id>.js`
  (`context.summary`, `context.topicLabel`, `context.extract`, `insights.brief`,
  `triage.stage3`) and call `runPrompt`, or at least pass `workflow: '<id>'` explicitly. Stack
  resolution works, but a registered prompt carries a real version and schema. Entity summaries
  ask for Tier 2 (`role: 'long'`). Consider Reflex; the admin can already set
  `routing.summary.tier = reflex`.
- **E, frontend:**
  - Build **Settings → Models** from `/admin/runtime` (one card per tier, named as above, with a
    catalog picker filtered on `chat`/`tools`, effort limited to `efforts`, and a `wireEffort`
    hint), `/admin/models/catalog` (health dots), `/admin/routing` and `/admin/usage`.
  - Show `status.tiers.notice` as a banner, and mark outputs whose provenance has
    `lighterModel: true` ("answered by the lighter model").
  - `HedwigSettings.jsx` can switch from `status.models` to `status.tiers`.
- **Upstream shim (`services/aiProvider.js` `hedwigChatOptions`):** passing a `workflow` per
  feature would make attribution explicit rather than stack-derived. It is optional.
- **Mail yield (`core/mailYield.js`):** handler deferrals still write `queued`. Switching them to
  `deferred` is one argument in `jobs.js` `defer()`, plus three assertions in
  `mailYield.test.js`.
- **Orchestrator:** h0020 is additive. Once deployed, the worker log shows
  `model Qwen/… degraded (no answer within 10000 ms)` within a minute while dgx-spark is busy, and
  `answers again` when it clears. `hedwig:model-health:*` keys appear in Redis.

## Still open

- Per-user reasoning effort and per-user budgets within the admin's bounds (PRD Power mode 3) need
  a user scope on `llm.reasoning.*` and budget keys. Those keys sit outside the runtime's
  append-only block, so this is left for the config owner.
- History is not backfilled: the 221 older rows keep an empty `tier` and `prompt_id`, and the
  usage report shows them as `unknown`.
- The probe gives each watched model one small streamed request a minute. It drops the connection
  after the first chunk or at the timeout. Whether LiteLLM cancels the queued vLLM request on
  disconnect has not been verified on dgx-spark.
- `/admin/health` `schedules` lists only the API process's schedules. The worker's schedules
  (probe, reconcile, reaper, retry) are not visible there.
- The input token estimator (PRD "a real estimator") was not part of this audit.
