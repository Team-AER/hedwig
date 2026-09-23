# Frontend audit, 2026-09-24

Scope: every user-visible requirement in `PRD-v2-product.md` that the frontend owns, checked
against the working tree after this pass. Paths are relative to `frontend/src/`. "Before" is
what production (commit 4994384) showed the user; "Now" is this working tree.

## Why the user saw no AI

The user was in the classic shell. `useHedwig.shellMode` came from `localStorage.hedwig_shell`,
and `'classic'` renders upstream MailFlow with none of v2 (`components/MailApp.jsx:131`,
`:786`). The classic shell was one click away (an unlabelled icon beside Settings in the top bar)
and the only way back was the palette command "Switch to the Hedwig layout". Because
`HedwigShell` never mounted, `useShell.init()` never ran, so the pre-v2 layout migration
(`hedwig/shell/state.js:85`) never moved their "Triage" row either.

Production rows checked (read-only): one `hedwig_layouts` row, name "Triage", device desktop,
active, no `version`, tree `core.nav · hedwig.needs · core.thread · hedwig.context`
(`follows: core.thread`, `sizes [220, 420, null, 320]`); no `hedwig_user_settings` row; no
server-side theme preference (the default is Hedwig / Hedwig Night by system scheme). That row is
used verbatim in `hedwig/v2/repair.test.js` ("layout migration for a layout saved before v2").

## Requirements

Severity: **S1** the user cannot reach the feature, **S2** reachable but wrong or incomplete,
**S3** polish.

| # | PRD requirement | Before | Now | Evidence | Sev | Action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | One Hedwig; v2 is what people see | Classic shell stuck in localStorage, no visible way back | Fixed. One-time move `classic → hedwig` stamped `hedwig_shell_v2`; later choices stick | `hedwig/store.js:18` `initialShellMode`, `:64`; `setShellMode` stamps too | S1 | Done |
| 2 | Pre-v2 layout moves to Streams, old one kept as "Classic" | Never ran for this user (shell not mounted) | Runs on first load; Classic is saved from the row it came from (on a tablet that is the desktop row), the old row is removed, a toast says where it went | `hedwig/shell/layouts.js:51`, `hedwig/shell/state.js:85`, `:92`, `:146` | S1 | Done; verified in a browser against the production row (Classic desktop inactive v2 + Streams active) |
| 3 | Classic shell has a way back | Palette only | "Classic layout · Hedwig layout" line under the sidebar header (owl button when collapsed), also in the phone drawer | `hedwig/shell/ClassicWayBack.jsx:9`, `components/Sidebar.jsx:897` | S1 | Done. The one-click classic icon was removed from the top bar; the classic shell stays in the layout menu (`hedwig/shell/TopBar.jsx:89`) and the palette |
| 4 | Simple mode: three things (needs you, waiting on, brief) | Present in the Hedwig shell only | Present | People with Needs you on top `hedwig/v2/StreamView.jsx:110`; Waiting on `hedwig/v2/Waiting.jsx:53`; Brief `hedwig/v2/Brief.jsx:67` | – | None |
| 5 | Why chip on every sorted message, "Change this" (just this one / always) | Present | Present | Reason line `hedwig/v2/rows.jsx:88`; thread Change `hedwig/v2/Thread.jsx:378`; door `hedwig/v2/WhyDoor.jsx:102` (why), `:147` (`/sort/correct`), `:228` | – | None |
| 6 | Hedwig today with undo | Present | Present | Rail line `hedwig/v2/Rail.jsx:143`; view `hedwig/v2/Today.jsx:54`, `/sort/undo` `:66` | – | None |
| 7 | Screener with pre-decisions, accept all, spam rescue | Present, but no hint of what the sender wrote | Adds the sender's TL;DR (or latest subject from `subjects`) above the reason | `hedwig/v2/Screener.jsx:34`, `:73`, accept all `:127` | S3 | Done |
| 8 | Streams and bundles (People / Reading / Records, bundles collapse to one line) | Present | Present | `hedwig/v2/StreamView.jsx:45` (`BundleGroup`) | – | None. Upstream's category tabs remain in the classic list only |
| 9 | Cards at the top of a message and on bundle rows | Present | Present | `hedwig/v2/Cards.jsx:33`, above each message `hedwig/v2/Thread.jsx:134`; bundle rows `hedwig/v2/StreamView.jsx:49`, `/cards?limit` `:113` | – | None |
| 10 | Cards in the Brief and Ledger | Present | Present | `hedwig/v2/Brief.jsx:68`; `hedwig/v2/Ledger.jsx:110` | – | None |
| 11 | Cards on a person / company card ("Last order 12 Aug") | Missing | Missing | `hedwig/views/ContextCard.jsx` has no card data | S2 | Open: needs a cards-by-sender route from the cards stream |
| 12 | TL;DR rows (one line per message) | Missing in the UI; no backend field | Rendered when the row carries `tldr` (string or `{ text }`, `summary` alias); nothing shown otherwise; one line on desktop, two on a phone; `aria-describedby` | `hedwig/v2/format.js` `tldrOf`, `hedwig/v2/rows.jsx:28`, `:68` | S2 | Done on the frontend. **Backend: no `tldr` field on `/sort/stream` items or `/sort/screener` senders yet** |
| 13 | Story so far, sentences linked to messages | Present but invisible (classic shell) and silent when it fails | Shows with citations; says "Written by the lighter model" when `provenance.story.fellBack`; a failed story says so in words with Try again (`?refresh=1`), budget-exhausted says so without retry; raw errors never shown | `hedwig/v2/Thread.jsx:393`, `:396`, `:404`; `hedwig/v2/threadData.js:89`, `:108` | S2 | Done |
| 14 | Quick replies under the message, insert not send | Present | Present; horizontal scrollbar hidden on phones | `hedwig/v2/Thread.jsx:337` | S3 | Done |
| 15 | Waiting On with nudges | Present | Present | `hedwig/v2/Waiting.jsx:53` | – | None |
| 16 | Power: rules engine (read, edit, dry run) | Read and dry run only | Unchanged | `hedwig/v2/HedwigSettings.jsx:218`, dry run `:225` | S2 | Open: no create / edit / enable / reorder / delete UI although `POST/PATCH/DELETE /sort/rules` exist |
| 17 | Power: routing table readable by everyone | Role → model lines from `/status` only | Adds the `/routing` table (tier choice, cadence, this person's tokens today) and the Tier 2 note; admins get "Change models and routing" | `hedwig/v2/HedwigSettings.jsx:279`, `/routing` `:282` | S2 | Done |
| 18 | Power: model choices within the admin's bounds (per user) | Only through the generic settings list | Unchanged | `PATCH /settings` via `hedwig/views/settings/ConfigForm.jsx` | S3 | Open: a picker limited to `modelChoices` from `/routing` would be clearer |
| 19 | Admin: pick Tier 1 / Tier 2 model from the catalog, effort, routing per feature, budgets, usage per feature | A generic config form ("Fast model", "Long model") in "Models and pipeline"; routing, catalog picker and usage not surfaced | New admin page **Models and routing**: "Tier 1 Reflex (fast)", "Tier 2 Reasoning (long)", Agent and the lighter model, each picked from the catalog (chat models only), effort limited to the model's `reasoning_efforts` and clamped on a model change, what is serving now (degraded shows who stands in), a Test call; routing per feature (tier, escalation, tokens a day) with usage beside it; usage table; models people may pick | `hedwig/views/settings/RoutingSettings.jsx:120`, `:176`, `:227`, `:314`, `:355`; nav `hedwig/views/settings/SettingsFrame.jsx:12`; view and palette `hedwig/views/index.js:44`, `:64`; old page's test buttons relabelled `hedwig/views/settings/ModelSettings.jsx:67` | S1 | Done |
| 20 | Tier status: say when Tier 2 is degraded; label lighter-model output | Nothing anywhere | Quiet "Tier 2 is slow; answers use the lighter model" in the rail, the top bar (layouts without the rail), Ask, the Brief and Power → Routing; `/status` re-read every minute without dropping state on failure; Ask answers labelled "Answered by the lighter model" | `hedwig/v2/tiers.js:14`, `:41`, `:53`; `hedwig/v2/TierNote.jsx:9`, `:29`; `hedwig/v2/Rail.jsx:122`; `hedwig/shell/TopBar.jsx:134`; `hedwig/views/Ask.jsx:165`, `:264`, `:300`; `hedwig/v2/Brief.jsx:233`, `:245`; `hedwig/store.js:76`; `hedwig/v2/index.js:118` | S1 | Done. Ask labels need `model`/`fellBack` on the done event (see below) |
| 21 | Mobile: tab bar, 44 px targets, phone thread / Screener / Brief | Present | Present; Hedwig settings pages now scroll clear of the floating tab bar | `hedwig/shell/MobileShell.jsx:22`, `:42`; `hedwig/views/settings/SettingsFrame.jsx` | S3 | Done |
| 22 | Nothing silent: every AI path degrades visibly | Story failure silent, Tier 2 fallback silent | See 13 and 20 | – | S2 | Done |

## Seam pass (same day): wired to the landed backend shapes

- **TL;DR**: People rows read `tldr: { text, lighter, model }` from `/sort/stream/people`; Reading,
  Records and Screener rows fetch `GET /work/tldr?ids=…` once per list (`hedwig/v2/tldrs.js`,
  cached per message, misses re-asked after 5 min, never without the work routes). The thread
  shows `messageTldrs` above each message and the thread `tldr` when there is no story; "Written
  by the lighter model" follows `storyMeta.lighter` (`hedwig/v2/threadData.js`, `Thread.jsx`).
- **Cards for rows**: Records uses `GET /cards/messages?ids=…` (falls back to `/cards?limit=200`).
- **Ask**: `model` + `lighterModel` on the done event and history entries; `coverage` on sources
  and done → "Hedwig has read N% of your mail so far" (`hedwig/v2/ask.js`, `views/Ask.jsx`).
- **Tiers**: the note shows `tiers.notice` (text, detail as title; `level: error` for Tier 1);
  `models.long.degraded` only when `tiers` is missing (`hedwig/v2/tiers.js` `tierNotice`).
- **Admin**: Models and routing now reads and writes `GET/PUT /admin/runtime` (validation `notes`
  and 400 messages shown), picks from `GET /admin/models/catalog`, tests with `POST
  /admin/tiers/probe`, and shows `GET /admin/usage?days=7` summed per feature over tiers with
  failure, lighter-model and Tier 2 escalation shares (falls back to `/admin/health`). The routing
  table stays on `/admin/routing`. Enabled models go through `PUT /admin/runtime { enabledModels }`.
- **Labels / Brief / index**: the thread asks `GET /labels/questions/for/:messageId` inline; the
  Brief says when the template wrote the prose and why (`prose.reason`), lists `today.entries`
  with Undo (`POST /sort/undo { logId }`), and shows `coverage`; Ask (idle) and the ledgers read
  `GET /index/coverage` (`hedwig/v2/CoverageNote.jsx`).
- **Why door**: `pending: 'reflex'` → "Waiting for Reflex"; Power lists every signal with its name
  (`alwaysIn` "Always in", `listRule` "List rule") and weight, and `engineVersion`.
- Not used: `GET /work/needs` (the People `needsYou=1` list already includes work needs through
  `workNeedsYouSql`, so both would duplicate rows); `GET /work/message/:id/tldr` (the thread payload
  carries `messageTldrs`); `/profile` `provisional` (there is no profile screen in the frontend).

## Endpoints the frontend consumes, and shapes assumed

Existing and verified against the working tree (`fe-shapes.mjs` run read-only on the dev DB):
`GET /status` (`models.<fast|long|agent>.{primary,fallback,active,degraded}`), `GET/PUT/DELETE
/layouts`, `GET /work/thread/:id[?refresh=1]` (`story`, `storyError`, `provenance.story`,
`quickReplies`), `GET/PATCH /admin/config`, `GET /admin/catalog`, `GET/PUT /admin/routing`,
`GET/PUT /admin/models/enabled`, `GET /admin/health` (`models`, `aiCalls24h`), `POST
/admin/test-llm`, `GET /routing`.

The shapes first assumed here (`tldr`, `tiers`, Ask `fellBack`, `/admin/usage`) are superseded by the seam pass above, which follows the landed code.

## Open

1. Cards on the person / company card (#11), rules editing (#16), a per-user model picker (#18).
2. A memory profile screen (would show `/profile` and its `provisional` flag); lanes, probe and
   budget-by-calls knobs from `/admin/runtime` are not on the admin page yet.
