# Hedwig v2 build contract (R1 + R2)

This is the shared contract for the v2 build. Five workstreams run in parallel in this working tree.
Each owns its directories; shared files are touched only in the ways listed here. Read
`docs/hedwig/ARCHITECTURE.md` first: its principles (mail reliability wins, loud failure, no data
loss, everything configurable, no new npm dependencies) still bind.

Product spec: the v2 PRD (People / Reading / Records streams, Screener, bundles, cards, two-tier
models, Simple and Power modes, labels without homework). Engineering spec: the AI rebuild PRD
(index, job ledger, gateway client contract, prompt registry, provenance, evals). Design:
`docs/hedwig/design/*.dc.html` (six mockups: desktop People, Daily Brief, dark People; phone
People, Screener, Thread).

## Decisions already made

| Topic | Decision |
| --- | --- |
| Models | Everything on `http://llm-proxy.cls/v1`. Tier 1 "Reflex" = `google/gemma-4-12B-it-qat-w4a16-ct` (131k ctx, **4,096 max output, no tool calling, reasoning `none`/`high`**). Tier 2 "Reasoning" = `Qwen/Qwen3.8-Flash-Next` (262k ctx, 32k output, tools). Embeddings = `bge-m3` (1,024 dims, 8,192-token input) — already wired in `embeddings.js`. No cloud, no reranker yet. |
| Streams | `people`, `reading`, `records`. Plus `screener` (sender undecided) and `spam`. |
| Auto-screen | On by default; every auto decision is logged and undoable. |
| Spam | Server spam folder is a **weak** label. Spam rescue surfaces legitimate mail found in it. Hedwig never deletes; auto-move is opt-in. |
| Attachments | Apache Tika 2.9.2 at `http://10.0.1.69:9998` (LXC 165; `tika.cls` once DNS resolves). Config knob, on by default in prod, off in tests. |
| Household | Multi-user. Per-user: accounts, streams, rules, learning, budgets. Admin: models, routing, prompts, plugins, endpoints. |
| Labels | Gathered automatically: behaviour → judge (Qwen + Gemma agree) → gentle questions (≤3/day). No labelling sessions. |
| Existing modules | `context`, `triage`, `insights`, `agent`, `pluginsv2` stay and keep working. v2 modules are new directories. Triage's classifier (`triage/model.js`, per-user logistic regression) is reused by sorting, not rewritten. |

## Workstreams and ownership

| Stream | Owner dir(s) | Migration | Config group |
| --- | --- | --- | --- |
| **A Index** | `backend/src/hedwig/indexer/` | `h0010_indexer.sql` | `index.*` |
| **B Runtime** | `backend/src/hedwig/llm.js`, `jobs.js`, `backend/src/hedwig/prompts/`, `backend/src/hedwig/ledger/` | `h0011_runtime.sql` | `llm.*`, `jobs.*` |
| **C Sorting** | `backend/src/hedwig/sort/` | `h0012_sort.sql` | `sort.*`, `spam.*`, `rules.*` |
| **D Labels & evals** | `backend/src/hedwig/labels/`, `backend/scripts/hedwig-eval.mjs` | `h0013_labels.sql` | `labels.*`, `eval.*` |
| **E Frontend** | `frontend/src/hedwig/**` (shell, theme, views), `frontend/src/hedwig/v2/` | — | `ui.*` |
| **F Working the inbox** (wave 2) | `backend/src/hedwig/work/` — lists (Done, Reply Later, Set Aside, pins, reminders, snoozed), thread story + quick replies, drafts in your voice, Waiting On + nudges, send guard; routes `/work/…` | `h0014_work.sql` | `work.*` |
| **G Ask and cards** (wave 2) | `backend/src/hedwig/ask2/` (query plan, retrieval, citation check, saved answers, feedback; `context/ask.js` delegates to it), `backend/src/hedwig/cards/` (detectors, Reflex extraction, ledgers, `/cards/…`) | `h0015_cards.sql` | `ask.*`, `cards.*` |

Production hardening (2026-09-24): every Hedwig IMAP fetch goes through `core/mailYield.js` `guardedFetch`, which yields to upstream sync, provider cooldowns and recent user activity, backs off per account (1 → 15 min) on refusals, and defers the job without spending an attempt; `index.bodyRatePerSec` (1, fractions allowed), `index.bodyRateByProvider` (`{ "yahoo": 0.5 }`), `index.bodyConcurrency` (1). Lanes are first-come-first-served with `llm.lanes.background.waitMs` (20 min) and `llm.lanes.interactive.waitMs` (30 s); a job that cannot get a slot is deferred by `jobs.laneDeferMin`. Spam: `spam.trustedLinkHosts` lists CDN/link-wrapper hosts ignored by the link-mismatch signal; `phishing` needs two independent signs; rescue runs on every path through spam-folder mail and `sort.reevaluateSpam` re-judges rows when `spam.signalsVersion` changes.

Retrieval floor (tuned on bge-m3, 2026-09-23): `index.minCosine` 0.50 (`index.minCosineHash` 0.40 for the hash provider), `index.minTermCoverage` 0.5, `index.minFtsRank` 0.8 admit chunks before fusion; `index.floor` only trims the fused tail. Retune `minCosine` when the embedding model changes.

Shared files, and the only allowed edits:

- `backend/src/hedwig/config.js`: **append** your keys to `SCHEMA` inside a comment block `// --- v2 <stream> ---`. Never reorder or edit others' keys.
- `backend/src/hedwig/modules.js`: append your module to `MODULES` (A: `indexer`, C: `sort`, D: `labels`; B has no module, it is infrastructure).
- `backend/src/hedwig/hooks.js`: append new hook names only.
- `backend/migrations-hedwig/`: your own file only, additive and idempotent (`IF NOT EXISTS`). Never edit h0001–h0004.
- Upstream files (`backend/src/services/**`, `backend/src/routes/**`, `frontend/src/components/**`): only through existing hooks, or a one-line hook call. Say so in your report.
- `package.json`: no new dependencies. JSON schema validation: reuse `backend/src/hedwig/agent/validate.js` (extend it in place if needed; B owns it from now).

Every module follows `modules.js`'s contract (`name, tools, routes, adminRoutes, api, worker`). Routes are namespaced by module: `/api/hedwig/index/…`, `/sort/…`, `/labels/…`. Streaming routes are SSE as in ARCHITECTURE.md.

## Data model (new tables)

Prefix everything `hedwig_`. Owners create them; others may **read** them.

**A Index**
- `hedwig_index_coverage(account_id, folder, state text, cursor timestamptz, seen int, bodies int, chunked int, embedded int, error text, updated_at)` — one row per included folder. State: `pending|running|done|paused`. A new account or folder, or a change to `pipeline.excludeFolders`, resets its rows. Replaces the single `pipeline.backfill` state key (keep the old key working but unused).
- `hedwig_chunks(id bigserial, message_id uuid, user_id uuid, kind text, ordinal int, text text, tokens int, tsv tsvector, recipe text, created_at)` — `kind` ∈ `header|body|quote|attachment|thread`. ~350 tokens, 50 overlap, paragraph boundaries. Each chunk's text starts with a context header line (subject, sender, date, folder, attachment name). Weighted `tsv`: subject A, body B, attachment C, quote D. GIN index. Text-search config from `index.tsConfig` (default `simple`).
- `hedwig_chunk_vectors(chunk_id bigint, model text, recipe text, dims int, vector vector(1024))` — HNSW cosine per model. Recipe = `<chunker version>:<model>`. Bumping recipe re-embeds in the background; search keeps the old recipe until the new one is complete for that user.
- `hedwig_attachment_text(message_id, attachment_index int, filename, mime, chars int, text, error, extracted_at)`.

**B Runtime**
- `hedwig_jobs` gains: `status text` (derived view is fine: `queued|running|done|partial|failed|resolved|retried`), `tokens_in int`, `tokens_out int`, `note text`. Add `hedwig_job_kinds` registry in code, not DB.
- `hedwig_ai_calls` gains: `prompt_id text`, `prompt_version text`, `prompt_hash text`, `lane text`, `tier text`, `workflow text`, and optional `prompt_text`/`output_text` (kept only when `llm.keepTranscripts` is on, pruned after `llm.transcriptDays`).
- `hedwig_corrections(id, user_id, kind text, target_id text, before jsonb, after jsonb, note text, prompt_id text, prompt_version text, created_at)` — `kind` ∈ `sort|screener|spam|summary|answer|extraction|topic|card`. B creates it; C and D write to it; everyone reads.

**C Sorting**
- `hedwig_senders(user_id, key text, scope text, decision text, source text, confidence real, reason text, decided_at, undone_at)` — `scope` ∈ `address|domain|list`; `decision` ∈ `people|reading|records|block`; `source` ∈ `user|auto|import|rule`.
- `hedwig_sort(message_id pk, user_id, stream text, bundle text, needs_you bool, needs_you_reason text, spam text, spam_reason text, confidence real, layer text, reason text, prompt_id, prompt_version, model, ai_call_id, decided_at, body_seen bool)` — `layer` ∈ `rule|classifier|reflex|reasoning|user`. `spam` ∈ `clean|suspected|phishing|rescued`.
- `hedwig_bundles(id, user_id, key text, name text, description text, schedule jsonb, builtin bool, position int)`; `hedwig_bundle_deliveries(bundle_id, delivered_at, message_ids uuid[])`.
- `hedwig_rules(id, user_id, position int, name text, enabled bool, conditions jsonb, actions jsonb, source text, created_from_correction_id, hits int, updated_at)`.
- `hedwig_sort_log(id, user_id, message_id, action text, from jsonb, to jsonb, by text, undone_at, created_at)` — the "Hedwig today" log with undo.

**D Labels & evals**
- `hedwig_labels(id, user_id, suite text, target_id text, label jsonb, grade text, source text, evidence jsonb, created_at)` — `suite` ∈ `sort|needs_you|spam|rescue|ask|extraction|topic`; `grade` ∈ `weak|silver|gold`; `source` ∈ `behaviour|judge|question|correction|generated`.
- `hedwig_questions(id, user_id, kind text, target_id text, question text, evidence jsonb, options jsonb, asked_at, answered_at, answer jsonb, dropped_at, drop_reason)`.
- `hedwig_eval_runs(id, suite text, prompt_id, prompt_version, model, metrics jsonb, n_gold int, n_silver int, accepted bool, started_at, finished_at, notes)`.

## APIs between streams

**B → everyone: prompt registry** (`backend/src/hedwig/prompts/index.js`)

```js
definePrompt({
  id: 'sort.reflex',            // also the X-Workflow header
  version: '2026-09-23.1',
  tier: 'reflex' | 'reasoning',  // maps to llm.models.fast / .long
  system: string,
  user: (vars) => string,       // or a template
  schema: { /* JSON schema, strict */ },
  maxTokens: number,
  temperature: 0,
});
const { data, provenance } = await runPrompt('sort.reflex', vars, {
  userId, feature: 'sort', lane: 'background' | 'interactive', escalate: false,
});
// provenance = { aiCallId, promptId, promptVersion, model, tier, fellBack, tokensIn, tokensOut }
```
`runPrompt` sends `response_format: json_schema, strict: true`, validates locally, retries once on the
same model with the validation error appended, then once on the other tier's model; doubles
`max_tokens` on `finish_reason: length` up to the model's catalog cap; strips `<think>`; records
the call with prompt id/version/hash; enforces token budgets; applies the lane's concurrency. Batch
prompts declare `batch: { key: 'items', validateEach: schema }` and get per-entry validation with
dropped entries returned in `provenance.dropped`.

Prompts live one per file in `backend/src/hedwig/prompts/<id>.js`, registered by `prompts/index.js`.
Streams C and D add their prompt files there (C: `sort.reflex`, `sort.screener`, `spam.reflex`,
`sort.bundleDescribe`; D: `labels.judge`, `labels.question`, `ask.generate`, `ask.verify`).

**B → everyone: job ledger** (`jobs.js`, extended in place)

```js
defineJob(kind, handler, { timeoutMs, rebuild: async (userId) => [payload, ...] });
enqueue(kind, payload, { userId, dedupeKey, runAt, priority, maxAttempts });
// handler may return { status: 'partial', note } ; throwing = failed
reconcile();          // failed → resolved when a later run succeeded or rebuild() returns nothing for it
retryFailed(kind?);   // re-enqueues from rebuild(); marks old rows retried
reapStuck();          // running past timeout → queued again
healthGate();         // catalog unreachable → jobs deferred (run_at += 10 min), attempts untouched
```
Lanes: `llm.lanes.interactive.concurrency` and `llm.lanes.background.concurrency`, held in Redis
(`services/redis.js`) so they apply across API and worker processes.

**A → C, D, agent: retrieval** (`backend/src/hedwig/indexer/retrieve.js`)

```js
retrieve({ userId, query, filters: { people, after, before, folders, hasAttachment, threadId },
           limit, expandThreads: true }) → { chunks: [{ chunkId, messageId, threadId, kind, text, score, ftsRank, vecRank }], floor: bool }
indexStatus(userId) → { coverage: [...rows], chunked, embedded, recipe, pending }
messageParts(messageId) → { newText, quoted, signature, attachments: [{ filename, text }] }
```
Retrieval = full-text (OR of terms plus phrase boost) and vector search in parallel, weighted RRF
(`index.rrfWeights`), recency prior, neighbour chunks and the replied-to message when `expandThreads`,
and a relevance floor (`index.floor`). Wire the existing `context/search.js` and `agent` `search_mail`
tool to call `retrieve()` (A does this; keep the old function signatures working).

**C → E: sorting routes** (`/api/hedwig/sort/...`)

- `GET /sort/stream/:stream?cursor&needsYou=1` → `{ items: [{ threadId, messageId, from, subject, snippet, date, needsYou, reason, bundle, accountId, unread }], next }`
- `GET /sort/screener` → `{ senders: [{ key, scope, display, address, count, proposed, reason, inSpam, lastMessageId }] }`
- `POST /sort/screener/decide { key, scope, decision, all?: true }`
- `POST /sort/correct { messageId, stream?, bundle?, needsYou?, spam?, always: 'sender'|'list'|'kind'|null, note? }` → writes `hedwig_corrections`, `hedwig_sort_log`, and a rule when `always`.
- `GET /sort/today` → `{ screened, bundled, rescued, blocked, entries: [...log rows] }`; `POST /sort/undo { logId }`.
- `GET /sort/bundles`, `POST /sort/bundles` (custom by description), `GET /sort/rules`, `POST /sort/rules`, `POST /sort/rules/:id/dryrun` → `{ matched, sample: [...] }`.
- `GET /sort/message/:id/why` → `{ layer, reason, confidence, signals: [...], rule?, promptId, promptVersion, model }`.

**D → E: labels routes** (`/api/hedwig/labels/...`)

- `GET /labels/questions` → up to `labels.questionsPerDay` open questions `{ id, kind, question, evidence, options: [{ id, label, always?: bool }] }`.
- `POST /labels/questions/:id/answer { optionId, always? }` and `POST /labels/questions/:id/skip`.
- Admin: `GET /admin/labels/stats`, `GET /admin/eval/runs`, `POST /admin/eval/run { suite }`.

**A → E: index routes**: `GET /index/status` (per-folder coverage, percentages), admin `POST /admin/index/rebuild { userId?, recipe? }`.

**Brief** (`GET /api/hedwig/insights/brief/today`): D extends the existing `insights` briefing to return the sections the Brief screen needs (`needsYou`, `waitingOn`, `cards`, `reading`, `questions`, `today`). Cards in R1 are only what exists: deadlines from `hedwig_commitments`; A adds `attachments` with text. Delivery/bill/event cards come in wave 2.

## Sorting decision (C)

Layers, cheapest first; each may decide or pass down with a confidence:

1. **Rules and headers**: user rules (`hedwig_rules`, ordered), sender decisions (`hedwig_senders`), `List-Id`/`List-Unsubscribe`/`Precedence: bulk`/`Auto-Submitted`, calendar MIME, own sent mail, replies to own threads (always `people`), server spam folder (weak spam), `Authentication-Results` (SPF/DKIM/DMARC).
2. **Classifier**: `triage/model.js` per-user logistic regression plus `hedwig_sender_stats` (reply rate, open rate, archive-unread rate). C adds spam and stream heads or trains separate models with the same code.
3. **Reflex** (`sort.reflex` prompt on Gemma): one JSON object per message with `stream`, `bundle`, `needs_you`, `needs_you_reason`, `spam`, `confidence`, `reason` (≤ 90 chars, plain, second person). Batched 4–6 messages per call, output under 4k tokens. Input: who the user is, To/Cc role, cleaned new text (≤ 2,500 chars) plus quoted context (≤ 600), sender history line, 5 recent corrections as examples, bundle definitions.
4. **Escalate** to Qwen (`escalate: true`) when Reflex confidence < `sort.escalateBelow` (0.6) or phishing suspected < 0.8.

Runs after the body is present (A's coverage flow) or after `sort.bodyWaitSec`; re-runs when the body lands, the classifier retrains, or the user replies. Every row records `layer`, `reason`, prompt/model provenance. The Screener holds mail from senders with no decision; auto-screen decides when `sort.autoScreen` is on and confidence ≥ `sort.autoScreenAbove` (0.75), logging to `hedwig_sort_log`. Spam rescue runs the same layers over the server spam folder and marks `rescued` candidates.

## Labels without homework (D)

- **Behaviour** (worker schedule, hourly): reply within a day → `needs_you=true, stream=people`; archived unread 3× from a sender → `needs_you=false`; read > 30 s → engaged; moved into/out of spam → strong spam label; sent to → `people`; unsubscribe → not people. Bulk actions (≥ 5 messages archived in the same second) are "skipped", not "read". Grade: weak or strong (`strong` stored as `silver`).
- **Judge** (nightly, budgeted): stratified sample by folder × sender volume × age; `labels.judge` on Qwen with rationale; the same items through `sort.reflex` on Gemma; agreement with behaviour → `silver`; disagreement or low confidence → question queue.
- **Questions**: ≤ `labels.questionsPerDay` (3), one tap, evidence attached, never repeated for the same target, dropped when other evidence settles it. Answer → `gold` label + `hedwig_corrections` (+ rule via C's `/sort/correct` when `always`).
- **Ask triples**: `ask.generate` on Qwen from real threads, `ask.verify` second pass; unanswerable questions generated too; user "wrong answer" marks join the set.
- **Harness**: `node scripts/hedwig-eval.mjs <suite> [--prompt v] [--model m]` → `hedwig_eval_runs`, prints silver/gold metrics and the diff to the last accepted run. Suites: `retrieval`, `ask`, `sort`, `needs_you`, `spam`, `rescue`. Gates: no gold metric down > 2 points; spam false positives never up.

## Frontend (E)

Rebuild the Hedwig shell's look to the design mockups and add the v2 views, keeping the pane-tree,
palette, keymap and plugin bundle loader working.

- **Tokens** (`frontend/src/hedwig/theme/`): light `--paper #F4F2EC`, `--ink #17181A`, `--muted #66696D`, `--accent #E0561A` (tweakable), `--accent-ink #B24512`, `--accent-tint rgba(224,86,26,.12)`, `--glass rgba(255,255,255,.52)`, `--edge rgba(255,255,255,.72)`, `--line rgba(23,24,26,.09)`, `--line2 rgba(23,24,26,.18)`, `--tint rgba(23,24,26,.045)`. Dark: `--paper #111214`, `--ink #F2F0EA`, `--muted #A3A6AA`, `--accent #FF7A40`, `--accent-ink #FF9A66`, `--glass rgba(32,33,37,.55)`, `--edge rgba(255,255,255,.10)`, lines at .09/.18, tint .05. Glass = `backdrop-filter: blur(var(--blur, 24px)) saturate(1.4)`, 1px `--edge` border, radius 26 desktop / 28 phone sheets. Ground carries two blurred light fields (accent top-right, `#3B5A8A` bottom-left).
- **Type**: Instrument Serif (titles, and every reason Hedwig gives, in italic), Instrument Sans (body), DM Mono (times, counts). Google Fonts `css2` link; system fallbacks. No pills, no uppercase eyebrow labels, no left-border cards, no avatars: hairlines, size and one accent do the work.
- **Views** (register with `registerView`): `people` (stream list with Needs you on top, reason lines, selected-row tint, Reply Later footer), `reading`, `records` (bundled), `screener` (proposed decision per sender, stream picker, accept, accept-all, rescue rows), `thread` (story so far with superscript citations, deadline slip, why line with Change, quick replies, reply bar), `brief` (headline, Ask field, needs you, waiting on, ledger strip of figures, reading picks, the day's question, the "Hedwig today" line), `today` (the undo log). Phone: header sheet, text tab bar with counts, 44px targets.
- **Why chip → door**: every reason is clickable → a small sheet showing `GET /sort/message/:id/why` and `Change this` (just this one / always for sender / list / kind) → `POST /sort/correct`.
- **Simple vs Power**: a `ui.powerMode` per-user setting toggled from the palette. Power reveals the rules list, dry-run, routing table (read-only for non-admin), prompt versions (admin), and index status. Simple shows five switches on Settings.
- API client: `hedwigApi` in `frontend/src/hedwig/api.js`; SSE via `hedwigStream`. Until backend routes land, build against the shapes above with a local mock (`frontend/src/hedwig/v2/mock.js`) behind `import.meta.env.VITE_HEDWIG_MOCK`, then switch.

## Config keys to add (defaults)

- A: `index.tikaUrl` ('http://10.0.1.69:9998'), `index.tikaEnabled` (true in prod compose, false default), `index.tikaMaxBytes` (20 MB), `index.chunkTokens` (350), `index.chunkOverlap` (50), `index.recipe` ('v1'), `index.tsConfig` ('simple'), `index.bodyRatePerSec` (5), `index.bodyMaxAgeDays` (0 = all), `index.rrfWeights` ({fts:1, vec:1, recency:0.3}), `index.floor` (0.02), `index.embedBatch` (32).
- B: `llm.lanes.interactive.concurrency` (2), `llm.lanes.background.concurrency` (1), `llm.keepTranscripts` (false), `llm.transcriptDays` (14), `llm.tokenBudget.<feature>` (per-day tokens), `jobs.healthDeferMin` (10), `jobs.reapAfterMin` (30).
- C: `sort.autoScreen` (true), `sort.autoScreenAbove` (0.75), `sort.escalateBelow` (0.6), `sort.bodyWaitSec` (120), `sort.batchSize` (5), `spam.autoMove` (false), `spam.autoMoveAbove` (0.95), `spam.rescueAbove` (0.7), `spam.suspectedDays` (30), `rules.maxPerUser` (200).
- D: `labels.questionsPerDay` (3), `labels.judgeSample` (100), `labels.judgeHour` (3), `labels.behaviourEverySec` (3600), `eval.gatePoints` (2).
- E: `ui.powerMode` (false, per-user), `ui.blur` (24), `ui.accent` ('#E0561A').

## Testing and reporting

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
docker compose -f docker-compose.devdb.yml up -d
cd backend && set -a && . ./.env.hedwig-dev && set +a
node scripts/hedwig-migrate.mjs && node scripts/hedwig-seed.mjs
npx vitest run src/hedwig                # unit
npm run test:hedwig-it                   # integration, sequential
cd ../frontend && npm test && npm run lint && npm run build
```

Unit tests mock `../../services/db.js`; model calls are mocked by intercepting `fetch` and routing on
the `X-Workflow` header (B ships `backend/src/hedwig/testing/mockGateway.js` with deterministic hash
embeddings; A, C, D use it). Never call the live gateway from tests. Integration tests are
`describe.skipIf(!process.env.HEDWIG_IT)`.

Do not commit. When done, report: files touched (shared files listed separately), migrations, config
keys, routes, what is stubbed or waiting on another stream, test results, and anything you had to
change in another stream's territory (with the one-line reason).
