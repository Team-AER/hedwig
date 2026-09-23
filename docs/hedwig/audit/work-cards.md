# Audit: summaries, working the inbox, cards (2026-09-24)

The user asked "Where are my email summaries". This audit maps every requirement in the v2 PRD
("Cards: structured mail", "Working the inbox", "The story so far", quick replies, the routing table
rows) and the AI-rebuild PRD ("Summaries", "Commitments and facts") to what production did, why,
and what changed. Production numbers are from read-only queries on 2026-09-23 22:58 UTC (commit
4994384). Owner: stream F (work) and the cards half of stream G.

## Why there were no summaries (short version)

1. **Nothing wrote summaries eagerly.** The only thread story path was `GET /work/thread/:id`, run
   when a thread is opened in the v2 shell. The user is in the classic shell, so it was never called:
   `hedwig_work_stories` = 0 rows and zero `work.story` calls in `hedwig_ai_calls`. The 46 "summary"
   calls in 30 h were context entity summaries (7 ok + 2 failed Qwen, `context.summarizeEntity`),
   topic labels (10) and 27 on-demand calls with no job (upstream/agent paths). None of them is a
   thread summary or a TL;DR.
2. **No per-message TL;DR existed at all.** There was no code for it.
3. **Cards could not see Indian mail.** The mailbox has **0** messages with schema.org JSON-LD or
   microdata and **0** calendar parts, so the deterministic detectors (schema.org, .ics, European and
   US carriers, one-time codes) found 1 card in 189 scanned messages. Reflex was only allowed for
   Records mail in a data bundle and younger than 45 days, which left 5 messages; 2 cards came out.

## Production facts

| Fact | Number | Query / source |
| --- | --- | --- |
| Messages / non-spam sorted in the last 120 days | 6,609 / 189 | `messages`, `hedwig_sort` (4,647 messages are dated 2018; 825 of the last 120 days are Bulk) |
| Threads with ≥ 2 messages (dedup by Message-ID) | 42 (25 of 2, 5 of 3, 4 of 4, 4 of 5, one each of 12, 13, 17, 47) | `messages` grouped by `thread_key` |
| … with a real person in them | 21 all time, 5 in the last 365 days (`pipeline.backfillDays`), 1 in 30 days; 3 longer than 8 | person = not bulk, no List-Unsubscribe, not the owner, not a notification local part |
| … with a story | **0** (`hedwig_work_stories` = 0) | |
| People + Screener messages with a body, last 365 days (TL;DR candidates) | 355 | `hedwig_sort` ⨝ `messages` |
| Records messages all time / 365 d / 120 d | 1,057 / 42 / 20 | `hedwig_sort.stream = 'records'` |
| Records or People messages whose subject names an order, invoice, booking, ticket, shipment… | 529 all time, 65 in 365 d | subject regex |
| Messages with schema.org markup / .ics parts / VCALENDAR bodies | **0 / 0 / 0** | `body_html`, `attachments` |
| `hedwig_cards` | 2 (1 receipt, 1 delivery, both `reflex`) | |
| `hedwig_cards_scan` | 189 rows, all `cards-v1` / `done`, `found` sum 1, Reflex on 5 | |
| `cards.extract` jobs | 12, all done (17:12–20:29 UTC) | `hedwig_jobs` |
| `hedwig_work_items` / `hedwig_work_waiting` | 0 / 0 | user-made lists and watches only |
| `hedwig_sort.needs_you` true | 1 row ever ("Pradeesha asks you to share KYC documents…", layer reflex) | only the Reflex layer sets it; Reflex ran on 3 rows |
| `hedwig_triage` waiting_on | 0 | Sent mail 3–60 days old without a reply: none (the last Sent, 24 Aug, was answered) |
| People stream, last 30 days | 54 messages: 51 by `rule`, mostly The Ken's newsletter (a sort bug, see requests) | |

**Why `cards.extract` ran only 12 times.** `cards.scan` queues sorted, non-spam, non-own mail
younger than `cards.maxAgeDays` (120). That was 189 messages: 8 jobs of up to 25 at first sync, plus
requeues; every message ended `done` under `cards-v1`, and nothing new arrived that was not spam.
The job itself worked; the window and the eligibility rules starved it. Of the 189: 165 were People
(no bundle, never eligible for Reflex), 9 Records/travel (all older than 45 days), 3 Records without
a bundle (the Shopify order and shipment among them), 4+1 Records purchases/deliveries within 45 days
(the only Reflex input).

**What `hedwig_work_items` needs to be non-empty.** It holds only what the user puts on a list
(Reply Later, Set Aside, Pinned, reminders, Done, Snoozed through Hedwig). Zero rows is correct for a
user who never had the v2 shell. Needs You is not stored there: it is `hedwig_sort.needs_you`
(sorting, stream C), which only the Reflex layer sets, so with Reflex starved the list had 1 row.

**Waiting On.** Derived by triage's `triage.waitingOn` schedule (every 15 min, `scanWaitingOn` over
Sent mail 3–60 days old with a question or request and no reply). It ran (no errors in the worker
log); the mailbox simply has no qualifying Sent mail in the window. The scan itself is now covered by
an integration test.

## Requirements

Status: ✅ met · 🟡 partial · ❌ missing. Severity: how much it contributes to "where are my summaries".

### Summaries and the story so far

| Requirement | Before | Evidence | Severity | After |
| --- | --- | --- | --- | --- |
| Thread summaries written eagerly on arrival, for threads with a real person | ❌ only on open | `work/thread.js` `compute()` called only from `GET /work/thread`; 0 stories | **Critical** | ✅ pipeline step queues `work.summarise` (`work/summaries.js:378`, called from `work/lists.js:423`); job fills gaps newest first (`work/summaries.js:331`) |
| Batched 4 threads per call, strict JSON | ❌ one thread per call | `prompts/work.story.js` single-thread | High | ✅ `work.summarise` batch prompt (`prompts/work.summarise.js`), `work.summariseThreadsPerCall` = 4, per-entry validation |
| Every sentence cites its message | ✅ on open | `assembleStory` drops uncited sentences | — | ✅ same code for eager and open |
| Half-hourly sweep for gaps, newest first, within `pipeline.backfillDays` | ❌ | none | High | ✅ schedule `work.summaries` every `work.summariesEverySec` (1800) → `sweepSummaries` (`work/summaries.js:395`); gap query `storyGaps` (`:272`) |
| Cached with provenance (prompt id, version, model, ai_call_id, tier) | 🟡 JSON only | `hedwig_work_stories.provenance` | Medium | ✅ columns added (`h0018_work_summaries.sql`), plus `source` (eager/open), `lighter`, `error`, `attempted_at` |
| Long threads (> 8) on Tier 2; Tier 1 with a "lighter model" label when Tier 2 is degraded | ❌ always Tier 1 | `work.story` tier reflex, no escalation | Medium | ✅ `tierPlan` / `isLighter` (`work/summaries.js:63-77`) use `activeModels().long.degraded`; a call that fell back is also marked lighter; `storyMeta.lighter` in the API |
| "Story so far" when a long thread is opened | 🟡 route existed, never called | classic shell | High (frontend) | ✅ route reuses the eager cache (no model call when fresh); frontend must call it |
| Refresh runs as a job; the request does not wait 240 s | 🟡 | open computes inline | Low | 🟡 eager job does the work; a cache miss on open still computes inline on the interactive lane (Tier 1 in 2–8 s; long threads go straight to Tier 1 while Tier 2 is degraded) |
| One summarise prompt family replaces the five paths | ❌ | `work.story`, context entity/topic summaries (`chatJson`, role long), upstream `/api/ai` | Medium | 🟡 thread story and TL;DR share `work.summarise` (`work.story` removed). Entity/topic summaries (`context/summaries.js`), newsletter digest and the GTD one-liner still use their own paths (open) |
| Per-message TL;DR in People | ❌ | no code | **Critical** | ✅ `hedwig_work_tldr`, 6 messages per Tier 1 call, on every People row (`tldr`) and via `GET /work/tldr`, `GET /work/message/:id/tldr` |
| Rewrite with a note (corrections) | ❌ | no route | Low | ❌ open |

### Writing: quick replies

| Requirement | Before | Evidence | Severity | After |
| --- | --- | --- | --- | --- |
| Two or three one-liners on open, only when a short reply fits | ✅ | `quickReplyGate`, `cleanReplies`, unit tests | — | ✅ unchanged; an eagerly written story gets its quick replies on first open and caches them (verified end to end with the mock gateway, IT "writes stories and TL;DRs eagerly") |
| Tier 1, never escalates | ✅ | `work.quickReplies` reflex | — | ✅ |

### Working the inbox

| Requirement | Before | Evidence | Severity | After |
| --- | --- | --- | --- | --- |
| Needs You with a reason chip | 🟡 | only `hedwig_sort.needs_you` from Reflex; 1 row in prod | High | 🟡 work now derives "Waiting N days for your reply" (a person wrote to you directly, it is the thread's latest message, it sits in People, `work.replyOverdueDays` = 2) and "Due Fri: …" (open `i_owe` commitment due within `work.deadlineSoonDays` = 3) into `hedwig_work_needs` (`work/needs.js`), for new mail within minutes of the sweep and over the last `work.needsDays` (30); the owner's reply resolves it at once. Rows carry `workNeeds`. Joining sort's `needsYou=1` list needs a one-line change in `sort/service.js` (request below) |
| Waiting On from sent mail, nudges | ✅ (data-empty) | `triage.waitingOn`, `work/waiting.js` | Low | ✅ verified by IT (`scanWaitingOn` → `listWaiting` source `triage`) |
| Done, Reply Later, Set Aside, Snooze, Pins, Reminders | ✅ | `work/lists.js`, tests | — | ✅ unchanged (0 rows is correct in prod) |

### Cards

| Requirement | Before | Evidence | Severity | After |
| --- | --- | --- | --- | --- |
| Deterministic first: schema.org, .ics, carrier patterns, merchant templates | 🟡 | 0 schema.org / .ics mail in prod; no Indian carriers; no merchant templates | **Critical** | ✅ `detect/orders.js`: order, booking/PNR and invoice references stated next to a naming word, with the stated total; Blue Dart, Delhivery, DTDC, Aramex, Ekart, Shiprocket, India Post S10; waybill numbers inside links (store ids) ignored |
| Reflex fills the rest | ❌ for most mail | eligibility = Records + data bundle + ≤ 45 days | **Critical** | ✅ `reflexEligible` (`cards/extract.js:93`): Records in a data bundle, or People/Records/Screener mail with a data signal (subject/sender), up to `cards.reflexMaxAgeDays` (now 365); partial pattern cards (no total, no departure) are filled and merged into the same card (`twinOf`, `:102`) |
| `cards.extract` for every Records/People message with data | ❌ | 120-day window | High | ✅ `cards.maxAgeDays` 400; `CARDS_VERSION` → `cards-v2` so everything is rescanned once |
| Every field shows its source | ✅ | `sources` per field | — | ✅ pattern fields cite their sentence, the merchant cites the From header, Reflex fields their quote |
| At the top of a message and in bundle rows | 🟡 | `GET /cards/message/:id` only | Medium | ✅ plus `GET /cards/messages?ids=…` for list/bundle rows in one call |
| In the Daily Brief | ✅ | `cardsToday` → `insights/briefing.js` | — | ✅ (now has cards to show) |
| Ledger views (Purchases, Subscriptions, Travel, Deliveries) | ✅ code, ❌ data | `ledger.js` | High | ✅ rows verified by IT on production-shaped mail |
| Subscriptions from recurring receipts | ✅ | `syncSubscriptions` | — | ✅ |
| Messy invoices on Tier 2 | 🟡 | routing `routing.cards.tier` only | Low | 🟡 open (Tika attachment text is read; no escalation rule) |

### Corpus check (production shape, read-only)

The 417 non-spam, non-own sorted messages of the last 400 days were exported read-only and run
through the detectors locally (nothing written anywhere):

| | v1 (deployed) | v2 (this change) |
| --- | --- | --- |
| Messages with a deterministic card | 1 (in 189 scanned) | **61** (63 cards: 20 receipts, 27 travel, 10 deliveries, 6 invoices) |
| Messages the Reflex model may read | 2 (of 417, by the old rules) | 76 (all with a data signal or in a data bundle) |

Examples now found without a model: Shopify "Order #24176 confirmed" (REES52, ₹16,517.64) and its
Blue Dart shipment (90667948000, not the store id in the link), IndiGo tax invoices, MakeMyTrip
e-tickets (PNR), hotel vouchers and cab bookings, BookMyShow tickets (booking id and amount paid),
Amazon order numbers, MD Computers and FGTECH orders, a PayPal receipt. Left to Reflex: BookMyShow
mails without a total, Aramex's table layout, IRCTC, Steam, GitHub receipts, Cloudflare domain mail.

## What changed

Files (all in my area unless marked):

- `backend/src/hedwig/work/summaries.js` (new): eager stories and TL;DRs, gap queries, the job, the sweep, coverage.
- `backend/src/hedwig/work/needs.js` (new): derived Needs You reasons.
- `backend/src/hedwig/work/thread.js`: the story on open goes through `summariseThreads`; eager cache reused; quick replies added on first open; `storyMeta`, `tldr`, `messageTldrs` in the response.
- `backend/src/hedwig/work/lists.js`: `withWorkRows` adds `tldr` and `workNeeds` (and flips needsYou when the caller asks); `applyMail` resolves "waiting for your reply" on the owner's reply and queues the summarise job.
- `backend/src/hedwig/work/index.js`, `routes.js`: job `work.summarise`, schedule `work.summaries`, routes below.
- `backend/src/hedwig/prompts/work.summarise.js` (new); `prompts/work.story.js` removed (replaced).
- `backend/src/hedwig/cards/detect/orders.js` (new), `detect/index.js`, `detect/tracking.js`, `extract.js`, `store.js`, `index.js`, `service.js`; `prompts/cards.extract.js` (comment only).
- `backend/migrations-hedwig/h0018_work_summaries.sql` (new, additive). No cards migration was needed.
- Shared: `backend/src/hedwig/config.js`: appended `// --- v2 work audit ---` and `// --- v2 cards audit ---` blocks; **edited two defaults in the ask/cards block**: `cards.maxAgeDays` 120 → 400, `cards.reflexMaxAgeDays` 45 → 365 (cards is this area; production has no overrides, so the defaults are live).

New config keys: `work.summariesEager` (true, per user), `work.summariseThreadsPerCall` (4),
`work.tldrPerCall` (6), `work.summariseThreadsPerJob` (12), `work.summariseMessagesPerJob` (36),
`work.storyEscalateAbove` (8), `work.tldrChars` (1500), `work.summariesEverySec` (1800),
`work.summariseRetryHours` (6), `work.replyOverdueDays` (2, per user), `work.deadlineSoonDays` (3, per
user), `work.needsDays` (30), `cards.signalReflex` (true).

Expected load after deploy (Tier 1, background lane, `llm.tokenBudget.work` 1M/day): about 60
TL;DR calls and 2 story calls to backfill 355 messages and 5 threads, then a few calls a day; about
20 `cards.extract` calls to rescan 400 days.

## Requests for other areas

- **Sort (C), `sort/service.js` `streamList`:** so derived reasons join the Needs you list, change
  `if (needsYou) where.push('s.needs_you')` to
  `` if (needsYou) where.push(`(s.needs_you OR ${workNeedsYouSql('m', 's')})`) `` (import from
  `../work/index.js`) and pass `{ derivedNeedsYou: true }` to `withWorkRows`. Until then rows carry
  `workNeeds` but do not move into Needs you (flipping them without the SQL would drop them from both lists).
- **Sort (C):** The Ken (List-Unsubscribe) lands in People by `rule` (51 of 54 People rows in 30 days).
  It inflates People and gets TL;DRs it would get anyway in Reading; stories exclude it.
- **Frontend (E):** show the TL;DR, story, lighter label, quick replies and cards (shapes below);
  the classic shell shows none of it.
- **Runtime (B):** none required; `tierPlan` uses `activeModels(userId).long.degraded`, which now
  syncs the shared probe state.
- **Context:** entity/topic summaries (`context/summaries.js`) still call `chatJson` on the long role
  without the prompt registry; moving them onto `work.summarise`-style registry prompts (with
  citations already present) is the remaining part of "one summarise family".

## Open

- Rewrite-with-a-note for summaries (corrections kind `summary`).
- Entity/topic summary unification (above); newsletter digest and GTD one-liner paths.
- Cache miss on open still computes inline (fast on Tier 1; the eager job makes misses rare).
- Messy PDF invoices are not escalated to Tier 2 by rule.
- Needs You derivation joins the list only after the sort change above.
