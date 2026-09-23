# Hedwig architecture

Hedwig is Team-AER's fork of MailFlow. It keeps every upstream capability and adds five layers:
a context engine, learning triage, insights, an agent framework, and plugin runtime v2, plus a
pane-tree UI shell. All Hedwig code lives in new directories so monthly upstream merges stay clean.

PRD and build plan: https://claude.ai/code/artifact/48ecc34a-a467-473c-b457-16afebc0e082
UI design canvas: https://claude.ai/artifact/8MoUVyhgwXosgUDeAizWfX

## Principles (inherited from upstream CLAUDE.md, still binding)

- Mail reliability wins every trade-off. Hedwig code never runs inside IMAP sync paths; it reads
  `messages` after the fact and writes only `hedwig_*` tables (plus `messages.body_*` through the
  body-fetch job, using upstream's own fetch and sanitizer).
- Loud failure beats silent degradation. A failing step records `hedwig_msg.error`, a failing job
  records `hedwig_jobs.last_error`, and `/api/hedwig/admin/health` shows both.
- No data loss. Hedwig never deletes or moves mail on its own. Agent actions that change mail are
  recorded as `hedwig_agent_actions` and wait for the user to approve them.
- Everything is configurable (see `backend/src/hedwig/config.js`). Add a knob to `SCHEMA` rather
  than hard-coding a number, a model id, a URL, or a schedule.
- No new npm dependencies without the lead's approval. Everything needed is already installed:
  express, pg, redis, htmlparser2, sanitize-html, react 18, zustand, marked, dompurify, date-fns.

## Processes

| Process | Command | Runs |
| --- | --- | --- |
| API (`backend`) | `node src/index.js` | upstream MailFlow + Hedwig routes, API-side jobs (`mail.fetchBody`, approved agent actions) |
| Worker (`hedwig-worker`) | `node src/hedwig/worker.js` | pipeline scanner, job loop, schedules. No IMAP. |
| Embeddings | llm-proxy → Uranus Ollama | `POST /v1/embeddings`, `bge-m3` (1024 dims) |
| Models | `llm-proxy.cls` (LiteLLM) | `Qwen/Qwen3.8-Flash-Next` for the fast, long and agent roles |

The API applies migrations at boot (`backend/migrations` then `backend/migrations-hedwig`). The
worker waits for the Hedwig schema before starting.

## Backend layout (`backend/src/hedwig/`)

| File | Owner | What |
| --- | --- | --- |
| `config.js` | lead | Every knob: SCHEMA, `getConfig(userId)`, env → admin → user layering |
| `llm.js` | lead | `chat`, `chatStream`, `chatJson`, `extractJson`, budgets, catalog, clamp, logging |
| `embeddings.js` | lead | `embed(texts)`, `embedQuery(text)`, `embeddingProfile()`, `cosine`, `toVectorLiteral` |
| `jobs.js` | lead | `defineJob(kind, handler)`, `enqueue(kind, payload, {userId, dedupeKey, runAt, priority})` |
| `pipeline.js` | lead | `defineStep({name, order, backfill, run(rows, ctx)})`, scanner, `MESSAGE_COLUMNS`, `decorate` |
| `schedule.js` | lead | `defineSchedule({name, everySec, run})` |
| `hooks.js` | lead | `HEDWIG_HOOKS`, `runHedwigHook`, `collectHedwigHook` |
| `text.js` | lead | `messageText(row)`, `messageHeader(row)`, `addressesOf`, `domainOf`, `stripQuoted` |
| `state.js` | lead | `getState(key)`, `setState(key, value)` |
| `agent/toolRegistry.js` | lead | `registerTool`, `toolsFor`, `toOpenAiTools`, `getTool` |
| `core/` | lead | status, settings, layouts, usage, admin config/health, body fetch |
| `context/` | context agent | entities, embeddings step, topics, extraction, cards, search, ask |
| `triage/` | triage agent | 3-stage pipeline, classifier, feedback, sender stats, waiting-on |
| `insights/`, `agent/` | agent+insights agent | stats, briefings, insight cards, agent loop, automations |
| `pluginsv2/` + `backend/plugins/` | plugins agent | manifests, permissions, loader, facade, first-party plugins |

### Module contract (`modules.js`)

Each `backend/src/hedwig/<module>/index.js` default-exports:

```js
export default {
  name: 'context',
  tools() {},            // registerTool(...) — runs in API and worker
  routes(router) {},     // mounted at /api/hedwig, requireAuth applied; req.session.userId is the user
  adminRoutes(router) {},// mounted at /api/hedwig/admin, requireAdmin applied
  api({ imapManager }) {},// API process only: defineJob for jobs that need the mail engine
  worker() {},           // worker only: defineStep / defineJob / defineSchedule
};
```

Route paths must be namespaced by module: `/context/...`, `/triage/...`, `/insights/...`,
`/agent/...`, `/plugins/...`. Streaming routes use SSE: `Content-Type: text/event-stream`, one JSON
object per `data:` line, blank line between events, a final `{"type":"done"}` event.

### Pipeline order

| order | step | module | backfill |
| --- | --- | --- | --- |
| 10 | `entities` | context | yes |
| 15 | `senderStats` | triage | yes |
| 20 | `embed` | context | no |
| 30 | `triage` | triage | no |
| 40 | `topics` | context | no |
| 50 | `extract` (enqueues LLM jobs) | context | no |

Rows passed to steps carry `MESSAGE_COLUMNS` plus `user_id`, `user_addresses` (Set of the user's
own addresses) and `is_outgoing`. Steps set their `hedwig_msg.*_at` column when done.

### Data model

All tables are in `backend/migrations-hedwig/h0001_core.sql`. Modules that need more columns add a
new file `h00NN_<module>_<what>.sql` (additive, idempotent: `IF NOT EXISTS`). Never edit h0001 after
it has shipped; never edit upstream migrations.

### Model calls

Always through `llm.js`. Pick a role (`fast` for per-message work, `long` for summaries and answers,
`agent` for tool loops) and a `feature` that has a budget key (`triage`, `extraction`, `summary`,
`ask`, `agent`, `insights`). Plugins pass `pluginId`. Prompts ask for JSON with `json: true` and
parse with `extractJson`; always handle `null`. Every model output that reaches the UI carries the
message ids it came from.

Model: `Qwen/Qwen3.8-Flash-Next` supports tools and JSON mode, 262k context, ~2 s for short calls.
The gateway rejects `reasoning_effort: "off"`; `llm.js` already maps off → `none`.

### Plugin hooks added by Hedwig

`hooks.js` names them. Dispatch sites: `beforeTriage`/`afterTriage` in triage, `onContextBuilt` in
context, `beforeSend` in the send route (plugins agent), `collectInsights` in insights,
`onMessageIndexed` in the pipeline.

## Frontend layout (`frontend/src/hedwig/`)

| Path | Owner | What |
| --- | --- | --- |
| `api.js`, `registry.js`, `store.js` | lead | `hedwigApi`, `hedwigStream`, `registerView`, `registerCommand`, `useHedwig` |
| `shell/`, `theme/`, `icons.jsx`, `index.js` | shell agent | pane tree, templates, layout editor, tokens/themes, palette integration, plugin bundle loader, MailApp integration |
| `views/` | views agent | every Hedwig view (needs-you, context card, ask, timeline, insights, agent, settings pages) |
| `frontend/src/plugins/<first-party>/` | plugins agent | frontend halves of first-party plugins |

Views register with `registerView` from `hedwig/views/index.js` (imported once by `hedwig/index.js`).
Commands register with `registerCommand`. Cross-pane state lives in `useHedwig`; upstream state
(accounts, selected message, compose) stays in `store/index.js`.

### Design language (from the canvas)

| Token | Light "Hedwig" | Dark "Hedwig Night" |
| --- | --- | --- |
| ground | `#F3EEE4` | `#16140F` |
| surface | `#FFFDF9` | `#1F1C16` |
| raised/nav | `#EFE8DB` | `#26221B` |
| border | `#E2DACB` | `#3A342A` |
| ink | `#1B1A17` | `#EFE8DB` |
| muted | `#6B665C` | `#A39B8C` |
| teal (they owe, settled, plugin) | `#1F6B66` / tint `#D7E8E5` | `#5FB3AB` / tint `#1E3432` |
| amber (you owe, needs you) | `#B56E1A` / tint `#F5E3C8`, text `#7A4A0E` | `#E0A054` / tint `#3A2A14` |
| red (spam) | `#A8432E` | `#E07A62` |

Type: Fraunces for display, IBM Plex Sans for body, IBM Plex Mono for ids and counts. Reason chips
are rounded pills in amber (needs you) or teal (they owe / informational). Inline styles with CSS
variables, matching upstream convention. Every interactive element is a real `<button>`/`<a>`/
`<input>` with a label; keyboard first.

## Testing

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
docker compose -f docker-compose.devdb.yml up -d          # pgvector + redis on 55432/56379
cd backend && set -a && . ./.env.hedwig-dev && set +a
node scripts/hedwig-migrate.mjs && node scripts/hedwig-seed.mjs   # demo / hedwig-demo-password
npx vitest run src/hedwig                                  # unit tests
npm run test:hedwig-it                                     # + integration tests (sequential: they share the dev DB)
cd ../frontend && npm test && npm run lint && npm run build
```

Unit tests mock `../../services/db.js` with `vi.mock`. Integration tests are guarded with
`describe.skipIf(!process.env.HEDWIG_IT)` and may use the seeded demo user. The gateway at
`http://llm-proxy.cls/v1` is reachable from dev machines; tests must not depend on it.
