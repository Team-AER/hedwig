# Audit: index, Ask, labels, Brief, profile and onboarding (2026-09-24)

Scope: `backend/src/hedwig/indexer/**`, `ask2/**`, `labels/**`, `profile/**`, `onboarding/**`,
`insights/**` (the Brief), `scripts/hedwig-eval.mjs`, and the prompts `labels.*`, `ask.*`,
`profile.rebuild`. The evidence is read-only production data: `prodsql.sh` SELECTs at
2026-09-23 23:00 UTC, and the code. Line numbers refer to the code after this audit's changes.
Requirements come from PRD-ai-rebuild ("Indexing layer", "Ask and search", "Briefings",
"Feedback and memory", "Evaluation"), PRD-v2-product ("Context and memory", "Labels without
homework", "Onboarding and multi-account", "Completeness") and V2-BUILD.

## Summary

1. **The body ledger was right; the parser was not.** Upstream `messages.body_text` is set on
   3,889 of 6,614 messages. Another 2,630 have only `body_html`: Archive 1,667, Bulk 786,
   INBOX 158, Sent 11, Personal 8. Hedwig's ledger counts either column as a fetched body, so
   "complete for nearly every folder" was true. The other 95 have no body: Trash 83, Draft 1,
   Deleted Messages 1 (all three excluded folders), 8 in Sent and 2 in Personal (the server
   returned nothing).
   The real gap was 31 messages that have a body but produced no text:
   - 22 have a text/plain part that is only `\r\n`, which hid the HTML part (`splitBody` used
     `body_text || ''`).
   - 7 have HTML in the text/plain part, or a one-paragraph body that mentions "confidential".
     The disclaimer rule treated the whole body as a footer.

   Real bodies today: **6,482 of 6,522 indexable (99.39%)**. The other 40 are no_text 31 and
   server_empty 9; 7 duplicates are not counted. After the parser fix, 28 of the 31 give text
   (checked on the exported production rows), so the expected figure is about 6,510 (99.8%).
2. **Behaviour labels were almost empty: 2 rows ever.** `labels.windowDays` is 30, but the
   account is mostly history. Sent has 0 messages in the last 30 days and 16 in the last 365.
   Only 32 replies exist, ever. There are also no read stamps yet (`read_changed_at` is set only
   when the user reads in Hedwig), no spam marks and no unsubscribes. Everything downstream
   starved:
   - the judge had no behaviour to agree with;
   - the profile had no facts;
   - behaviour never proposed a question.
3. **The judge ran both sides on Gemma.** It made 33 `labels.judge` calls on Gemma (tier
   reasoning, after 4 Qwen failures of 45 s each) and 33 `sort.reflex` calls on Gemma.
   - The same-model guard held: **0 silver labels**.
   - It still queued **15 questions** from Gemma-vs-Gemma disagreements (6 spam, 9
     models_disagree). They were worded "How should I sort this email from …", some with
     "(Junk / Real mail)".
   - None was ever asked. The Brief and `/labels/questions` were never opened; the user is in
     the classic shell.
   - Each judge batch waited 45 s for Qwen while holding the single background lane for about an
     hour (see sort.md, finding 2).
4. **Everything else Tier 2 fell back to Gemma without saying so:**
   - The only briefing (`insights.daily`, 07:27) is stored as `generated_by=model`. Qwen failed
     twice (after 45 s and 120 s), so Gemma wrote it.
   - The 7 Ask triples were generated and verified on Gemma.
   - `hedwig_profile` has **0 rows**. `profile.rebuild` finished in 1 s with "no evidence yet":
     1 sent message in 90 days.
   - `hedwig_ask_log` has 0 rows, `hedwig_corrections` 0 and `hedwig_eval_runs` 0.
5. **Ask is built and checked, but was never used in production.** It has a query plan, the
   retrieval floor, thread expansion, the citation check, saved answers and feedback, all
   covered by unit tests with the mock gateway. It lacked two things: the coverage share and the
   lighter-model flag. Both are added.

## Requirements

Status key: OK = meets the requirement; FIXED = met after this audit's change; PARTIAL; GAP; REQ =
needs another area (see Requests).

### Indexing layer

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| Coverage ledger per account and folder; a new account or folder starts its backfill | OK | `indexer/coverage.js:95` refreshCoverage. Prod: 5 rows (Archive, Bulk, INBOX, Sent, Personal), all `done`. Trash, Draft and Deleted Messages are excluded by rule | — | — |
| Body for every included message, with a reason when it cannot be fetched | FIXED | Prod: 6,519 of 6,529 have a body column. 10 are `body_state=empty` ("the server returned no body"). 31 had a body but no text (parser) | High | Parser fixes in `parse.js:259` (whitespace text part, HTML in the text part) and `parse.js:123` (the disclaimer never takes the whole body). A one-time re-chunk of those messages runs via `store.js:377` repairEmptyBodies (`PARSER_VERSION`), with no recipe bump |
| One number for "messages with a real body", with reasons, that the index, admin health and onboarding agree on | FIXED | Before, `coverage.bodies` meant "a body column is set" and onboarding summed it | High | `indexer/truth.js:72` bodyCoverage defines it once: real = fetched and produced a body or quote chunk. The reasons are duplicate, fetch_failed, server_empty, waiting, not_indexed and no_text. Served in `/admin/health` `index.bodies`, `/index/status` (`bodies`, and per folder `realBodies`, `bodyReasons`, `pct.realBodies`) and `/onboarding/status` (per account, and in total) |
| Per-folder coverage exposed in admin health | OK+ | `/admin/health` `index.coverage` holds the totals. `index.bodies.byFolder` now gives real bodies per folder. `/admin/index/status?userId=` gives per-folder chunked and embedded counts | Low | — |
| Chunks about 350 tokens, context header, weighted tsvector, thread rollup | OK | Prod: header 6,522, body 21,212 (6,462 messages), quote 742, attachment 1,358 (268 messages), thread 63 | — | — |
| Embeddings on bge-m3 keyed by recipe; search keeps the old recipe during a rebuild | OK | 29,896 vectors, all `v1:bge-m3`. Every folder is embedded (for example Archive 5,174 of 5,174) | — | — |
| Attachment text through Tika | OK | 1,358 attachment chunks | — | — |
| Spam folder indexed, hidden from Ask and search | OK | Bulk: 830 chunked, `c.spam` filter in `retrieve.js:172` | — | — |

### Ask and search

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| Query plan: rules first, Reflex only when the rules find nothing, strict JSON, time-boxed | OK | `ask2/plan.js:233`. Tests in `ask2.test.js` (planRules, timeout fallback) | — | — |
| Retrieval floor (`index.minCosine` 0.50, `minTermCoverage` 0.5, `minFtsRank` 0.8, `index.floor` 0.02); below it, "nothing relevant" with no model call | OK | `retrieve.js:94` admit and `:107` cut. `answer.js` returns without a model call. Tests: `retrieve.floor.test.js`, and ask2 "answers nothing relevant without a model call" | — | — |
| Thread expansion (neighbour chunks and the replied-to message) | OK | `retrieve.js:290` | — | — |
| Up to 24k tokens of evidence grouped by thread, numbered `[n]` | OK | `ask2/evidence.js`, `ask.contextTokens` 24000 | — | — |
| Citation check; answers with no valid citation marked unsupported | OK | `ask2/citations.js:29`. Tests cover invalid `[5]` removal and unsupported | — | — |
| Saved answers (history shows the answer, not a re-ask) | OK | `ask2/history.js`, `GET /context/ask/:id`. The history entries now also carry `model` and `lighterModel` | — | — |
| Feedback: "wrong answer" becomes a correction and a gold label | OK | `POST /context/ask/:id/feedback` → `labels/askTriples.js` answerFeedback. Prod: never used (0 ask_log rows) | — | — |
| Ask answers on the lighter model carry the flag | FIXED | Nothing flagged it before | High | `answer.js:193`: `done.lighterModel`, `done.model`, the return value, and `plan.answer` in `hedwig_ask_log` |
| "Features light up as the index fills": coverage share on Ask, search and cards | FIXED (Ask) / REQ (search, cards) | Not present before | Medium | `indexer/truth.js:110` coverageShare. Ask puts `coverage` in its sources and done events. The not-found text says "Only N% of your mail is indexed so far" (`answer.js:28`). New `GET /index/coverage`. Search and cards: see Requests |
| Main search box on the hybrid engine | OK (not audited in depth) | `context/search.js` searchIndexed → `retrieve()` | — | — |
| Recall@10 ≥ 0.85, faithfulness ≥ 0.95 | GAP (not measurable) | 7 generated triples, all written by Gemma; no eval run ever | Medium | Triples now run on Tier 2 only (`allowLighter: false`). They accumulate nightly once Qwen is back |

### Briefings (Daily Brief)

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| Compiled from data, no model call on the request path | OK | `briefing.js` compileBrief, test "never calls a model" | — | — |
| Sections: needs you (with reasons), waiting on (nudges), today's cards, reading's best, what Hedwig did with undo | FIXED | "What Hedwig did" had only counts | Medium | `today.undoable` and `today.entries` (the newest 5 undoable log entries, for `POST /sort/undo`). The stored briefing's Needs you now comes from the same sort list as the screen, with triage used only before sorting has run |
| Prose only through Tier 2, template fallback flagged | FIXED | Prod: the one briefing was written by Gemma after two Qwen failures, stored as `model` | High | `composeBriefing` skips the model while Tier 2 is degraded, and discards a fallback-model answer. `data.fallback`, `data.fallback_reason` (tier2_degraded, model_error, budget, models_off, empty_reply) and `data.model` are recorded. The Brief exposes `prose { source, fallback, reason, model, at }`. The prose call now has provenance (`insights.briefing` prompt id, version and hash). Config `insights.briefProseTier2Only` |
| Gentle questions in the Brief | OK | `compileBrief` → `listOpenQuestions` (marks asked, 3 a day at most) | — | — |
| Coverage in the Brief | FIXED | — | Low | `coverage` field |

### Labels without homework

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| Behaviour labels from replies, archives, reads, spam moves, sends, unsubscribes | FIXED | Prod: 2 labels ever (`sent_to`, weak) | High | Replies and sent mail are now read over `labels.historyDays` (default 3650), the rest over `labels.windowDays` (`behaviour.js:310`). The engaged rule needs `read_changed_at`, which fills as the user reads in Hedwig |
| Judge: a Qwen and a Gemma opinion on a stratified sample (`labels.judgeSample` 100); the two judges are different models | FIXED | Prod: 33 judge calls on Gemma. The same-model guard gave 0 silver, but 15 questions and an hour of the background lane | High | While Tier 2 is degraded, `labels.nightly` defers (no attempt spent) for up to `labels.judgeDeferHours` (18). After that it runs in single mode: Tier 1 only, labels silver with `evidence.singleJudge`, and evals report `silverSingleJudge` apart. `labels.judge` runs with `allowLighter: false`. If Tier 2 goes down mid-run, the run stops (`tier2Lost`), keeps its labels and defers the rest. Ask triples are skipped while degraded |
| Questions: at most 3 a day, in the Brief and inline, with evidence, never repeated, dropped when settled | FIXED | Prod: 15 queued, 0 asked, generic wording | High | Behaviour now feeds the queue (`behaviourCandidates`, `behaviour.js:370`): a sender you replied to or wrote to that sorting put in Reading or Records, and spam-folder rescue candidates. A full queue keeps its most useful questions (`planQueue`, `questions.js:194`). Unanswered for 3 days after being shown → dropped. Inline: `GET /labels/questions/for/:messageId` (it counts toward the daily limit). Model wording only on Tier 2 and only if usable (`questionIsUsable`); otherwise templates that say what you did. The labels.question prompt is at 2026-09-24.1. Evidence `senderReplied` now counts only the user's own replies (it counted anyone's replies before) |
| Ask golden set generated, verified, plus "wrong answer" marks | PARTIAL | 7 triples from Gemma | Medium | Tier 2 only from now on (`allowLighter: false` on ask.generate and ask.verify) |
| Harness `node scripts/hedwig-eval.mjs <suite>` with gates | OK | Runs against the dev database: sort, needs_you, spam and retrieval all exit 0 with "nothing to score" (no labels in dev). Gates in `labels/metrics.js` checkGates | Low | `npm run hedwig:eval` is not in package.json (Request) |
| Admin: latest eval run per suite, gold counts | OK | `GET /admin/labels/stats`, `/admin/eval/runs` | — | — |

### Feedback and memory: the profile

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| Versioned, editable, pinned lines kept, diff shown | OK | `profile/service.js`, `lines.js` applyUserEdit, tests | — | — |
| Rebuilt weekly from 90 days of behaviour and corrections | PARTIAL → FIXED | Prod: 0 rows, "no evidence yet" | Medium | When the 90-day window gives fewer than 3 facts, the rebuild reads `profile.fallbackDays` (365) instead. The facts state their window |
| No hallucinated claims without evidence | FIXED | `validateLines` kept lines with no numbers and no citation (for example "You like your friends.") | High | Every generated line must cite at least one existing fact (`lines.js:60`) |
| Rebuild on Tier 2; waits or is provisional when degraded | FIXED | — | Medium | `runRebuildJob` defers while within `profile.deferHours` (24), with `allowLighter: false`. After that it builds on the lighter model and marks `provenance.provisional`. `GET /profile` returns `provisional`, and `weeklyTick` rebuilds a provisional version once Tier 2 is back |

### Onboarding: Sort the past

| Requirement | Status | Evidence | Severity | Action |
|---|---|---|---|---|
| One summary screen: "Sorted N: people in People, newsletters in Reading, receipts in Records, spam, of which about N look real" | FIXED | Prod: 6,376 sorted. People 1,432 messages from 203 senders, Reading 3,060 from 287, Records 1,057 from 138. Spam 826, rescue candidates 1 | Medium | `summary.sorted`, `peopleSenders`, `readingSenders`, `recordsSenders` added |
| Progress per account, bodies in the same number as health | FIXED | It summed the ledger's fetched-body count | Medium | Per account: `bodies` (real), `bodyShare`, `bodyReasons`, plus the top-level `bodies` |
| 50 highest-volume senders with proposals, and rescue candidates | OK (20 by default) | `onboarding.topSenders` 20 | Low | — |

## What changed (files)

- `indexer/truth.js` (new): bodyCoverage, coverageShare, shareOf, foldBodyRows.
- `indexer/parse.js`: whitespace text part, HTML in the text part, the disclaimer never takes
  everything, `PARSER_VERSION`, looksLikeHtml, textChars.
- `indexer/store.js`: repairEmptyBodies. `indexer/service.js`: runs it in the chunk sweep, and
  adds `bodies` to indexHealth.
- `indexer/retrieve.js`: indexStatus gains `bodies`, `share` and per-folder real bodies.
- `indexer/routes.js`: `GET /index/coverage`.
- `ask2/answer.js`: coverage, lighterModel, the not-found text with the share.
  `ask2/history.js`: model and lighterModel.
- `labels/tier.js` (new): reasoningTier (runtime `tierStatus`, then the `activeModels` cooldown,
  then recent `hedwig_ai_calls`), ranOnLighterModel.
- `labels/judge.js`: single mode (`reconcileSingle`), `allowLighter: false`, tier2Lost.
  `labels/index.js`: runNightly deferral and the inline question route.
- `labels/questions.js`: planQueue, questionFor, questionIsUsable, behaviour templates, the
  3-day drop, the senderReplied fix, Tier 2-only wording.
- `labels/behaviour.js`: the history window, behaviourCandidates.
- `labels/askTriples.js`: Tier 2 only; tier_degraded makes the run partial.
- `labels/eval.js`: `silverSingleJudge`.
- `insights/briefing.js`: Tier 2 prose with a flagged fallback, provenance, undo entries, the
  prose block, coverage, one Needs you list.
- `profile/service.js`, `profile/evidence.js`, `profile/lines.js`: the defer or provisional
  rule, the wider window, cite-or-drop.
- `onboarding/status.js`: real bodies and the summary numbers.
- `prompts/labels.question.js`: version 2026-09-24.1.
- `config.js`: `// --- v2 index audit ---` with `labels.judgeDeferHours`, `labels.historyDays`,
  `labels.behaviourQuestions`, `profile.deferHours`, `profile.fallbackDays`,
  `insights.briefProseTier2Only`.
- Tests: `indexer/truth.test.js` (new), `labels/tier2.test.js` (new), and additions to
  `parse.test.js`, `labels.test.js`, `ask2.test.js`, `brief.test.js`, `profile.test.js` and
  `onboarding.test.js`.

No migrations. No new dependencies.

## Endpoint shapes for the frontend

- `GET /api/hedwig/index/coverage` → `{ share: 0..1 | null, indexed, total, complete }`. The share
  is of searchable mail (the spam folder aside) that is chunked and embedded. `null` means no
  included folder yet. Show "Covers N% of your mail" on Ask, search and cards until `complete`.
- `GET /api/hedwig/index/status` → as before, plus:
  - `bodies: { real, indexable, share, reasons: { duplicate, fetch_failed, server_empty, waiting, not_indexed, no_text } }`
  - `share` (as above)
  - per folder: `realBodies`, `bodyReasons`, `pct.realBodies`.
- `POST /api/hedwig/context/ask` (SSE):
  - `sources` gains `coverage`.
  - `done` gains `coverage`, `model` and `lighterModel` (show "lighter model" when true).
  - `GET /context/ask/history` and `GET /context/ask/:id` entries gain `model` and `lighterModel`
    (null for answers saved before this change).
- `GET /api/hedwig/insights/brief/today` → as before (`headline`, `headlineSource`, `needsYou`,
  `waitingOn`, `cards`, `reading`, `questions`, `today`), plus:
  - `prose: { insightId, source: 'model'|'template', fallback, reason, model, at } | null`. When
    `fallback` is true, show "written from a template" and the reason.
  - `coverage`.
  - `today: { screened, bundled, rescued, blocked, undoable, entries: [{ id, action, text, messageId, subject, createdAt }] }`,
    each entry undone with `POST /sort/undo { logId: id }`.
- Questions:
  - `GET /api/hedwig/labels/questions` → `{ questions: [{ id, kind: 'stream'|'needs_you'|'spam', question, evidence, options: [{ id, label, always? }], askedAt }] }`,
    at most `labels.questionsPerDay` (3) a day. Calling it marks them asked.
  - `GET /api/hedwig/labels/questions/for/:messageId` → `{ question: <same shape> | null }`, for
    asking inline on that message. It counts toward the same daily limit.
  - `POST /labels/questions/:id/answer { optionId, always?: true|'sender'|'list'|'kind' }` →
    `{ ok, applied }`.
  - `POST /labels/questions/:id/skip` → `{ ok }`.
  - Evidence carries `why`: behaviour_conflict, rescue_candidate, spam_disagree,
    models_disagree, low_confidence or same_model.
- `GET /api/hedwig/onboarding/status`:
  - `summary` gains `sorted`, `peopleSenders`, `readingSenders` and `recordsSenders`.
  - each account gains `bodyShare` and `bodyReasons`; its `bodies` is now the real-body count.
  - top-level `bodies` is the same object as in `/index/status`.
- `GET /api/hedwig/profile` gains `provisional` (built on the lighter model; rebuilt when Tier 2
  is back).

## Requests for other areas

1. **Search and cards (context/search.js, cards/):** add `coverage: await coverageShare(userId)`
   from `indexer/truth.js` to the `/context/search` response and to the cards list responses.
   Until then the frontend can read `GET /index/coverage`.
2. **Frontend:** show the coverage share, the Ask "lighter model" label, the Brief `prose.fallback`
   note, the undo entries, inline questions, the onboarding summary numbers and
   `profile.provisional`.
3. **package.json (orchestrator):** add `"hedwig:eval": "node scripts/hedwig-eval.mjs"`. The PRD
   documents `npm run hedwig:eval -- <suite>`.
4. **Runtime (prompts/index.js):** `provenance.lighterModel` is false when runPrompt's third step
   (the other tier) answers a Tier 2 prompt. Gemma wrote it, but nothing says so. Consider setting
   `lighterModel` when `servedTier === 'reflex'` for a Tier 2 prompt.
5. **Orchestrator, optional:** the 15 production questions from the same-model judge run are still
   queued. Better candidates now replace them automatically, and they are dropped 3 days after
   being shown unanswered. To clear them now: `UPDATE hedwig_questions SET dropped_at = NOW(),
   drop_reason = 'same-model judge run' WHERE asked_at IS NULL AND created_at < '2026-09-24'`.

## Open

- Recall@10, faithfulness and the triage gold metrics cannot be measured until Qwen answers and
  labels accumulate: about 100 silver labels a night, and 3 gold labels a day from questions.
- The eval `ask` suite judges faithfulness on Tier 2 only, so it fails while Tier 2 is degraded.
  That is intended.
- The dev database is shared and order-sensitive. `ask2.it` (people resolution needs entities
  from the pipeline), `insights.it` (needs triage needs-you rows) and `onboarding.it` (needs
  sorting's `sort.seeded` state) fail when run alone after a fresh seed. They depend on other
  areas' pipeline runs, not on these changes.
