# Writing Hedwig plugins

Hedwig plugin runtime v2 lets a plugin add hooks into triage and sending, its own HTTP routes,
views and commands, background schedules and agent tools, while touching mail, the model gateway,
storage and the network only through a per-plugin, per-user capability facade.

This guide covers the manifest, permissions, the backend facade, hooks, the frontend bundle
contract, agent tools, testing and publishing. The HTTP routes are specified in
[API.md](API.md#plugins-v2--backendsrchedwigpluginsv2). The example external plugin is
[`examples/plugins/hello-hedwig`](../../examples/plugins/hello-hedwig).

## Tiers and where plugins live

| Tier | What | Where | Loaded |
| --- | --- | --- | --- |
| 1 | First-party, reviewed in this repo | `backend/src/plugins/<name>/` (exports `manifest` + default `activate`) and `frontend/src/plugins/<name>/` | Imported statically (`backend/src/hedwig/pluginsv2/bundled.js`, `frontend/src/plugins/index.js`) |
| 2 | External | a directory `plugins.dir/<id>/` holding `hedwig.plugin.json` | Discovered at start; installed by an admin from a git URL or a directory |

Both tiers use the same facade. Tier 1 plugins shipped today: `aer.receipts`, `aer.digest`,
`aer.pensieve`, `aer.sendguard`. Upstream's GTD plugin keeps the v1 surface (`backend/src/plugins/api.js`)
and is untouched.

## Quick start

```bash
cd backend
npm run plugin -- new acme.weather --dir ~/src        # scaffold from hello-hedwig
npm run plugin -- validate ~/src/acme.weather          # manifest + boundary check (what the server runs)
npm run plugin -- dev ~/src/acme.weather --plugins-dir /srv/hedwig-plugins
# set plugins.dir to /srv/hedwig-plugins (Admin → Hedwig, or HEDWIG_PLUGINS_DIR), restart,
# then enable it in Settings → Plugins. After editing: Admin → Plugins → Reload.
npm run plugin -- pack ~/src/acme.weather              # acme.weather-0.1.0.tgz + .sha256
```

## Manifest: `hedwig.plugin.json`

```json
{
  "id": "acme.weather",
  "name": "Weather",
  "version": "0.1.0",
  "api": "^1.0.0",
  "tier": 2,
  "description": "Adds the forecast to meeting invites.",
  "author": "Acme",
  "backend": "./backend/index.js",
  "frontend": "./frontend.js",
  "permissions": [
    { "name": "mail.read", "reason": "Read invites to find the meeting place" },
    { "name": "net:api.weather.example", "reason": "Fetch the forecast" },
    { "name": "llm.summarize", "optional": true, "reason": "Shorten long forecasts" }
  ],
  "hooks": ["onMessageIndexed"],
  "net": ["api.weather.example"],
  "settings": {
    "type": "object",
    "properties": {
      "units": { "type": "string", "enum": ["metric", "imperial"], "default": "metric", "title": "Units" },
      "apiKey": { "type": "string", "secret": true, "default": "", "title": "API key" }
    }
  },
  "views": ["acme.weather.panel"],
  "commands": ["acme.weather.open"]
}
```

The validator (`backend/src/hedwig/pluginsv2/manifest.js`) is strict: unknown keys are errors and
every problem is reported at once.

| Key | Rules |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9.-]{1,63}$`, no `..`/`--`, not ending in `.`/`-`. Use `vendor.name`. The directory must be named exactly the id. Upstream's registry disallows dots, so the plugin registers there as dots → `-` (`aer.receipts` → `aer-receipts`); that mapped id is also the **activation key** stored in `users.preferences.enabledPlugins` (`PluginInfo.activationKey`). |
| `version` | semver `x.y.z` |
| `api` | semver range of the Hedwig plugin API (`^1.0.0`, `~1.0.0`, `>=1.0.0 <2`, `1.x`, `\|\|`). This server provides **1.0.0**. |
| `tier` | `2` for external plugins, `1` for bundled ones. |
| `backend`, `frontend` | relative `./…js` paths inside the plugin; `backend` default-exports `activate`. |
| `permissions` | `[{ name, reason, optional? }]`. `reason` is shown to the user. Required ones must all be granted to enable the plugin. |
| `hooks` | hook names (below). Each hook's permission must be declared. `activate()` must return exactly these. |
| `net` | hostnames (no scheme, port, path or wildcards) or `$settings.<key>` for "the host of this user's setting" (a string setting with `format: "url"` or `"host"`). Each entry needs a matching `net:<entry>` permission and vice versa. |
| `settings` | `{ type: "object", properties }`, each `{ type: string\|number\|integer\|boolean, title?, description?, default?, enum?, format?: url\|email\|host\|secret\|multiline, secret?, minimum?, maximum?, maxLength? }`. Per user. Secrets are encrypted at rest and masked in the browser. |
| `views`, `commands` | ids the frontend registers, prefixed `<id>.`; need the `views` permission. |

## Permissions

| Permission | Grants | Facade |
| --- | --- | --- |
| `mail.read` | Read the user's messages, threads, accounts and identities | `mail.search/getMessage/getThread/findByMessageId/listAccounts`; hooks `beforeSend`, `onMessageIndexed`, `onSentMessage` |
| `mail.write` | Label and archive (never delete) | `mail.applyLabel`, `mail.archive` |
| `context.read` | People, topics, commitments | `context.search/getPerson/listCommitments`; hook `onContextBuilt` |
| `context.write` | Add facts (tagged with the plugin id, removed on uninstall) | `context.addFact` |
| `triage.hook` | See and steer triage | `triage.get`; hooks `beforeTriage`, `afterTriage` |
| `llm.summarize` / `llm.extract` / `llm.chat` | Model gateway calls, counted against `llm.dailyBudget.plugins` per plugin per user | `llm.summarize/extract/chat` |
| `compose.draft` | Create a draft in Drafts. Nothing in the plugin runtime can send. | `compose.createDraft` |
| `storage` | The plugin's own per-user key/value store | `storage.get/set/list/delete` |
| `views` | Add views and commands (frontend) | — |
| `schedule` | Background schedules, run once per user who granted it | `schedules` from `activate()` |
| `agent.tools` | Offer tools to the Hedwig agent | `tools` from `activate()` |
| `net:<host>` / `net:$settings.<key>` | Outbound HTTP to that host only | `net.fetch` |

Every capability is checked **at call time**: the acting user must have activated the plugin, the
manifest must declare the permission and the user must have granted it; otherwise the call throws
`hedwig.PermissionError` (`{ pluginId, permission, reason }`). Checks are cached for 5 seconds, so
a disable or revoke takes effect in every process within that window. Disabling a plugin withdraws
all its grants.

## Backend

```js
// backend/index.js
export default function activate(hedwig) {
  const router = hedwig.router();
  router.get('/forecast', async (req) => ({ units: (await hedwig.settings.get(req.userId)).units }));
  return {
    hooks: { onMessageIndexed: async (ctx) => { /* … */ } },
    router,
    tools: [/* … */],
    jobs: { refresh: async (payload, { userId }) => { /* … */ } },
    schedules: [{ name: 'daily', everySec: 3600, run: async ({ userId }) => { /* … */ } }],
    collectInsights: async (ctx) => [/* cards */],
  };
}
```

`activate` may be async; it has 10 seconds. It runs in **both** processes: the API (routes, and
API-side actions) and `hedwig-worker` (pipeline hooks, jobs, schedules). Keep it free of side
effects other than building the returned object. A plugin that throws while loading is shown with
status `error` and the error text; it never takes the process down.

### Facade reference (`hedwig`)

Every call takes the acting `userId` first.

```ts
hedwig.pluginId, hedwig.apiVersion, hedwig.manifest, hedwig.PermissionError, hedwig.logger.{debug,info,warn,error}
hedwig.isActive(userId) → boolean

hedwig.mail.listAccounts(userId) → [{ id, name, email, displayName, color, aliases: [{ email, name }] }]
hedwig.mail.search(userId, { q?, from?, accountId?, folder?, category?, triage?, bulk?, unread?,
                             hasAttachments?, after?, before?, limit? ≤ 200 }) → MessageLite[]
hedwig.mail.getMessage(userId, messageId, { html? }) → MessageLite & { message_id_header, in_reply_to,
      references, to, cc, reply_to, list_unsubscribe, text, html?, body_fetched, attachments } | null
hedwig.mail.getThread(userId, messageId) → MessageLite[]
hedwig.mail.findByMessageId(userId, '<rfc-message-id>', { html? }) → full view | null
hedwig.mail.applyLabel(userId, messageId, labelFolder) → { applied, reason } | { queued, jobId }
hedwig.mail.archive(userId, messageId) → { archived, reason } | { queued, jobId }

hedwig.context.search(userId, opts) / getPerson(userId, idOrEmail) / listCommitments(userId, opts)
hedwig.context.addFact(userId, { key, value, entityId?, topicId?, sourceMessageId?, confidence? }) → { id }
hedwig.triage.get(userId, messageId) → { category, priority, needs_you, confidence, stage, reason_label, reasons, overridden, decided_at } | null

hedwig.llm.available(userId) → boolean
hedwig.llm.summarize(userId, text, { maxWords?, role?: 'fast'|'long', instructions? }) → string
hedwig.llm.extract(userId, { text, instructions?, schema? }) → object | null
hedwig.llm.chat(userId, { messages: [{ role, content }], role?, json?, maxTokens?, temperature? }) → { content, data? }

hedwig.compose.createDraft(userId, { accountId? | replyToMessageId?, aliasId?, to, cc?, bcc?, subject?,
                                     body, bodyIsHtml? }) → { created, uid, folder } | { queued, jobId }

hedwig.storage.get(userId, key) / set(userId, key, jsonValue) / delete(userId, key)
hedwig.storage.list(userId, { prefix?, limit? ≤ 1000, offset?, values? }) → [{ key, value, updatedAt }]
hedwig.settings.get(userId) → values with defaults / set(userId, patch) → values
hedwig.net.fetch(userId, url, { method?, headers?, body?, timeoutMs? }) → { ok, status, headers, text(), json() }
hedwig.jobs.enqueue(userId, jobName, payload, { runAt?, dedupeKey? })
hedwig.user.timezone(userId) → IANA zone
hedwig.broadcast(userId, payload)            // arrives in the browser as { type: 'hedwig.plugin', pluginId, payload }
hedwig.router()                              // see "Routes"
hedwig.util.{ messageText, addressesOf, domainOf, extractJson }
```

`getMessage(…, { html: true })` returns the stored message HTML as received, unsanitized: use it
as data (links, archiving), never render it.

Limits: storage keys `[A-Za-z0-9._:/@+=-]{1,200}`, values ≤ 256 KB JSON, 20,000 keys per user;
`net.fetch` responses ≤ 2 MB, 15 s default timeout, redirects are returned (not followed), cookies
are never sent; job payloads and broadcasts ≤ 64 KB; model inputs are truncated at 48,000
characters.

Mail writes and drafts need the live mail engine, which only the API process has. Called from the
worker (a hook or schedule), they are queued as an API-side job and return `{ queued, jobId }`;
the permission is checked again when the job runs.

### Routes

`hedwig.router()` returns a small router (`get/post/put/patch/delete(path, handler)`, `:param`
segments). It is mounted at `/api/hedwig/p/<pluginId>/` behind the session check and a per-request
activation check. Handlers never see Express objects:

```js
router.get('/items/:id', async (req, res) => {
  // req = { userId, pluginId, method, path, params, query, body, headers } (frozen)
  return { id: req.params.id };          // returned values are sent as JSON
});
router.get('/export.csv', async (req, res) => {
  res.attachment('export.csv', csvText, 'text/csv; charset=utf-8');
});
// res: status(code), type(ct), header(name, value), json(obj), send(textOrBytes), attachment(name, body, type)
```

Allowed response types: JSON, text/plain, text/csv, octet-stream, PDF and png/jpeg/gif/webp.
HTML, SVG and script are refused, every response carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`, and only `content-disposition`,
`cache-control`, `etag` and `last-modified` may be set. Throwing `PermissionError` answers 403;
invalid input (`hedwig` throws a `PluginInputError`) answers 400.

### Hooks

| Hook | Kind | Fires in | Permission | ctx | Return |
| --- | --- | --- | --- | --- | --- |
| `beforeTriage` | collect | worker (triage) | `triage.hook` | `{ userId, messageId, message? }`; `message` is headers + snippet only (`id, account_id, folder, subject, from_*, to/cc_addresses, date, snippet, is_bulk, category, has_list_unsubscribe, …`) | `{ verdict?: { category, reason }, features?: { name: number } }`; feature names are prefixed `<pluginId>:` |
| `afterTriage` | event | worker | `triage.hook` | `{ userId, messageId, triage }` | — |
| `onContextBuilt` | event | worker | `context.read` | `{ userId, kind: 'entity'\|'topic', id }` | — |
| `beforeSend` | collect | API, send route | `mail.read` | `{ userId, accountId, aliasId, from: { email, name }, to, cc, bcc, subject, body (plain text, without the quoted reply), bodyIsHtml, hasAttachments, attachments: [{ filename, contentType }], inReplyTo, references }` | `{ block?: true, warn?: string, reason?: string, findings? }` |
| `onMessageIndexed` | event | worker (pipeline) | `mail.read` | `{ userId, messageId, accountId }` | — |
| `collectInsights` | collect | worker (insights) | none | `{ userId, … }` | card or cards `{ title, body (markdown), severity, data, sources: [messageId] }` |
| `onSentMessage` | event | API | `mail.read` | `{ userId, accountId, messageIdHeader }` | — |

A hook runs only for users who activated the plugin and granted its permission. ctx is a frozen
plain copy (no engine, account rows or functions). Hooks have timeouts (`beforeSend` 5 s,
`beforeTriage` 10 s, others 60–120 s); a failing or slow hook is logged and contributes nothing.

`beforeSend`: a `block` result stops the send with HTTP 409
`{ error: reason, blockedBy: pluginId, warnings }`; `warn` results never block and come back with
the send result as `warnings: [{ pluginId, message }]`. Plugins that want a pre-flight (like Send
guard's `POST /api/hedwig/p/aer.sendguard/check`) expose it as a route.

### Agent tools

```js
tools: [{
  name: 'list_receipts',                         // registered as aer_receipts__list_receipts
  description: 'List receipts found in the user\'s mail.',
  parameters: { type: 'object', properties: { month: { type: 'string' } } },
  permission: 'storage',                         // optional: also required at call time
  mutates: false,                                // true → the agent asks the user to approve first
  summarize: (args) => `List receipts for ${args.month}`,
  handler: async (args, { userId, runId }) => ({ /* JSON result */ }),
}]
```

Tools need the `agent.tools` permission. The agent only offers a plugin's tools to users who
activated it and granted `agent.tools` (and the tool's own permission); the handler re-checks both.

### Schedules and jobs

`schedules: [{ name, everySec ≥ 60, run({ userId }) }]` run in the worker, once per user who
activated the plugin and granted `schedule`. For clock times, tick often and decide in `run`
(see `aer.digest`, which ticks every 15 minutes and writes the paper after the user's chosen hour
in their `insights.timezone`). `jobs: { name(payload, { userId }) }` are durable (hedwig_jobs,
retried with backoff) and are enqueued with `hedwig.jobs.enqueue`.

## Frontend bundle contract

An external plugin's `frontend` is one ES module. The browser imports it after the user activates
the plugin (`frontend/src/plugins/runtimeLoader.js`); the server serves it only to such users,
as `application/javascript` with `nosniff`. The bundle must not import anything. It gets the host
API as `window.hedwig`, scoped to the plugin while the module evaluates, so **read it once at the
top of the module**:

```js
const { React, h, registerView, registerCommand, registerSlot, api, pluginApi, stream, useHedwig, tokens, pluginId, SettingsForm } = window.hedwig;

function Panel() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { pluginApi.get('/forecast').then(setData); }, []);
  return h('div', { style: { color: `var(${tokens.ink})`, fontFamily: `var(${tokens.fontBody})` } }, data?.units);
}
registerView({ id: 'panel', title: 'Weather', component: Panel });   // becomes acme.weather.panel
registerCommand({ id: 'open', title: 'Open weather', run: () => useHedwig.getState().openView(`${pluginId}.panel`) });
```

| Member | What |
| --- | --- |
| `React`, `h` | the host's React 18 and `React.createElement` (build JSX with `jsxFactory: h` or use `h`) |
| `registerView`, `registerCommand` | `frontend/src/hedwig/registry.js`; ids are forced under `<pluginId>.` and removed when the plugin is deactivated |
| `registerSlot` | upstream slot registry (`frontend/src/plugins/registry.js`), gated on activation |
| `api`, `stream` | `hedwigApi` / `hedwigStream` for `/api/hedwig` (CSRF header included) |
| `pluginApi` | the same, rooted at `/api/hedwig/p/<pluginId>`; `pluginApi.url(path)` for links and downloads |
| `useHedwig` | the Hedwig zustand store (`openView`, `selectedEntityId`, …) |
| `tokens` | CSS variable names: `ground surface raised border ink muted faint tint teal tealTint tealText amber amberTint amberText red redTint shadow fontDisplay fontBody fontMono`; use as `var(${tokens.ink})` |
| `SettingsForm` | `<SettingsForm pluginId schema? onSaved? />`, a form for the plugin's settings |

First-party plugins are bundled by Vite instead and gate their registrations with
`whenActivated(pluginId, () => [registerView(…), registerCommand(…)])` from `runtimeLoader.js`.

## Security model

What the runtime enforces:

- **Capabilities, per user, per call.** A plugin gets nothing but the frozen facade. Every read is
  an ownership-scoped query returning a projected shape (never a raw row, account credentials or
  IMAP uids); every call re-checks activation and the grant for the acting user.
- **No Express objects.** Plugin routes see a frozen plain request, never `req.session` or the
  socket, and may not serve active content.
- **Network allowlist.** `net.fetch` reaches only manifest-declared, user-granted hosts, through
  upstream's SSRF-safe fetch (private addresses refused unless the admin allows them, HTTPS for
  public hosts, no redirects followed).
- **Budgets.** Model calls count against `llm.dailyBudget.plugins` per plugin per user.
- **Install-time boundary check** (`backend/src/hedwig/pluginsv2/boundary.js`, the same code the
  CLI's `validate` runs): backend files may import only files inside the plugin directory and the
  built-ins `assert buffer crypto events path querystring string_decoder url util timers`;
  packages, `fs`, `net`, `http(s)`, `child_process`, `vm`, `worker_threads` and the rest are
  refused, as are `process`, `globalThis`/`global`, the global `fetch`/`WebSocket`/`XMLHttpRequest`,
  `eval`/`Function`, `require`, computed `import()`, symlinks and native addons.
- **Pinning.** The sha256 of every file in the plugin directory is recorded at install (or first
  sight) in `hedwig_plugins` and checked on every load; changed files are refused until an admin
  reloads the plugin, which re-validates and re-pins.
- **Admin-only install.** Only admins install, reload or uninstall. Git installs are https only,
  `git clone --depth 1` with an argument array, no credentials in the URL, only when
  `plugins.allowGit` is on, and the clone's `.git` is removed before validation.
- **First-party plugins** are held to the same rules by `npm run lint:plugins`
  (`backend/eslint.plugins-boundary.js`): they import only their own files.

What it cannot enforce: **a tier-2 plugin runs inside the Node process.** The boundary check is a
static filter over source text, and JavaScript can be written to evade a static filter (for
example by reaching a global through an object's prototype chain in a way no pattern anticipates).
Code that gets past it could read `process.env` (database and encryption keys), open sockets or
touch the filesystem. The same holds for frontend bundles, which run as same-origin script with
the signed-in user's session. So installing a tier-2 plugin is a trust decision equivalent to
deploying code: read it, install it from a pinned commit, and keep `plugins.dir` writable only by
the operator. Real isolation would mean running tier-2 backends in a separate process (or
container) with a scrubbed environment and the facade served over IPC; the facade was designed so
that move needs no change to plugins.

## Testing

- Pure logic: keep it in plain modules next to `index.js` and unit test it (see
  `backend/src/plugins/receipts/heuristics.test.js`).
- Hooks and routes: call `activate()` with a stub facade that has only what the plugin uses (see
  `backend/src/plugins/sendguard/rules.test.js`).
- Runtime behaviour: `backend/src/hedwig/pluginsv2/loader.test.js` loads `hello-hedwig` from a
  temporary plugins dir with an in-memory DB (`fakeDb.testutil.js`).
- Against the dev DB: `HEDWIG_IT=1 npx vitest run src/hedwig/pluginsv2` (see ARCHITECTURE.md).

```bash
cd backend
npx vitest run src/hedwig/pluginsv2 src/plugins src/routes/send
npm run lint:plugins
npm run plugin -- validate ../examples/plugins/hello-hedwig
```

## Publishing to the directory

The directory is `plugins/directory.json` in this repository (served to admins from
`plugins.directoryUrl`, falling back to the copy in the build). To list a plugin, open a PR adding:

```json
{ "id": "acme.weather", "name": "Weather", "description": "…", "version": "0.1.0", "api": "^1.0.0",
  "tier": 2, "source": "git", "location": "https://github.com/acme/hedwig-weather.git#v0.1.0",
  "author": "Acme", "permissions": ["mail.read", "net:api.weather.example"] }
```

`location` is an https git URL, optionally `#<tag-or-branch>`; the plugin's `hedwig.plugin.json`
must be at the repository root and the directory name at install is the id. Pin a tag, include the
`pack` sha256 in the PR, and expect review of every permission and of the source.
