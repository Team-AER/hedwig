# Audit: sorting, spam and the Screener (area C, 2026-09-24)

Scope: `backend/src/hedwig/sort/**`, `backend/src/hedwig/triage/**` as used by sorting, and the
prompts `sort.reflex`, `sort.screener`, `spam.reflex`. Evidence is read-only production data
(`prodsql.sh` SELECTs at 2026-09-23 22:57 UTC, `prodlogs.sh`), plus the code. Line numbers refer to
the code after this audit's changes.

## Summary

1. **The Ken went to People because of a sender decision, not a model.** All 314 of The Ken's
   stored issues (293 in INBOX, 21 in other folders) are `stream=people, layer=rule,
   confidence 0.95, reason "You have written to them"`. The user once wrote to
   `info@the-ken.com`, so the first sort seeded an `import` People decision for it
   (`hedwig_senders` id 26). That "always in" entry acted as a final *stream* decision. The list
   headers were only a prior (confidence 0.72), and that prior was never consulted. Every issue
   has `is_bulk`, `List-Unsubscribe` and `category=newsletter`. The same bug put 61 Archive and
   33 Personal non-list messages in People, including 19 `shipment-tracking@amazon.in` and 15
   `auto-confirm@amazon.in` ("In your contacts").
2. **Tier 1 barely ran.** Only one `sort.reflex` call was ever made for sorting. There were 33
   more, but those came from the labels judge (feature `labels`, 17:13–18:08 UTC). The judge held
   the single background lane for an hour, which is why job 1048 found the lane "full for 240 s"
   three times and failed at 17:31. Nothing re-enqueued that work. After 17:31 no row qualified
   for Reflex anyway, for three reasons:
   - Import decisions were final.
   - Spam-folder mail takes the rescue path, never `sort.reflex`.
   - From 18:11 the classifier heads decided at 0.92. Those heads had been trained on 460
     samples: 449 People positives (mostly The Ken, from the import decisions above), 2 Reading
     positives and 9 Records positives.
   In the last 14 days, 0 non-spam rows were left below `sort.classifierDecideAbove`.
3. **Failed Reflex work was not rebuildable.** When a job failed permanently its rows kept
   `pending='reflex'`. `pendingSweep` cleared that flag after 6 h and kept the classifier
   decision for good. `reflexRebuild` existed, but nothing scheduled called it.
4. **spam.reflex never ran: 0 calls ever.** The rescue "borderline" window was
   `[rescueAbove-0.35, rescueAbove)`, that is 0.35–0.70. In production, 0 of 827 spam-folder rows
   scored in that window (748 below 0.1, 50 in 0.1–0.2, 26 in 0.2–0.3, 1 in 0.3–0.4). The server
   folder was in effect the final word: of 472 Bulk rows in the last 14 days, 461 are suspected,
   10 phishing and 1 rescued.
5. **The classifier heads could learn "newsletter ⇒ spam".** `samplesFromDecisions` labelled
   every `stream=spam` row as a spam positive, including rows whose only evidence was the
   provider's Bulk folder. Bulk holds 714 `is_bulk` rows. The spam head had not trained yet, but
   it would have.

## Production numbers (2026-09-23 22:57 UTC)

| Query | Result |
| --- | --- |
| `hedwig_sort` by layer | classifier 5,919 · rule 596 · reflex 3 · reasoning 0 |
| `sort.reflex` jobs ever | 2: id 154 done 17:11; id 1048 failed 17:31, 3/3 attempts, "background model lane stayed full for 240 s" |
| `sort.reflex` AI calls | 1 feature=sort, 33 feature=labels (the judge), all on Gemma |
| `spam.reflex` AI calls | 0 |
| INBOX, last 14 days (31 rows) | people 25 (needs_you 1), records 5, reading 1. Of the 25 People rows, 23 are The Ken |
| All folders, last 14 days | Bulk: spam 471, screener 1 · INBOX as above |
| The Ken (`info@the-ken.com`) | 314 rows (293 INBOX), all `people/rule 0.95 "You have written to them"`, `is_bulk`, List-Unsubscribe, category newsletter, `body_seen=false` |
| Rows whose stream came from an import/auto People decision | list mail: INBOX 293, Archive 23, Personal 1 · non-list: Archive 61, Personal 33 |
| `pending` / `body_seen` | 4 rows `pending='reflex'` (job 1048's batch, layer rule); classifier 5,094 not body-seen, 825 body-seen; reflex 3 body-seen |
| `hedwig_sort_models` | people 460 samples (449 pos / 11 neg), reading (2 pos / 458 neg, holdout precision 0.07), records (9 pos); no spam head |
| Rescue score distribution (spam folder) | <0.1: 748 · 0.1–0.2: 50 · 0.2–0.3: 26 · 0.3–0.4: 1 · ≥0.9: 1 (rescued) |
| Candidates for spam.reflex (last 30 days) | old window 0 · new window (≥0.25) 27 |
| Tier 0 provenance | 6,515 non-model rows carry no model or prompt version, and nothing said which code decided them |
| Needs-you rows | 1 in total, and it has a reason |

## Requirements

Severity: **critical** = wrong mail in the wrong place for the user today · **high** = a PRD
promise not kept · **medium** = partly kept · **low** = polish or deferred by design.

| # | Requirement (source) | Status before | Evidence | Severity | Done / deferred |
| --- | --- | --- | --- | --- | --- |
| 1 | Newsletters and lists go to Reading by headers (List-Id, List-Unsubscribe, Precedence) (PRD "How the sort is decided"; V2-BUILD "Sorting decision" 1) | **no** | The Ken, 314 rows in People (317 list rows in all); list was only `header.prior` (headers.js) | critical | **Fixed.** `headers.js:181 listRule`: plain list mail is Reading, final, layer rule, reason "A newsletter or mailing list (List-Unsubscribe header)". List mail that looks transactional or automated gets a Reading/Records floor and goes to Reflex. `engine.js:230` puts it ahead of automatic sender decisions and after the user's own. The classifier (`engine.js:269`) and Reflex (`engine.js:322`) can never put list mail in People. The Reflex prompt gets a "personal greeting is a mail-merge" rule and moves to version 2026-09-24.1. |
| 2 | "Always in" (sent-to, contacts, replies to own threads) (PRD Screener) | partial: implemented as a stream decision | 80 import People decisions; Amazon shipping mail in People | critical | **Fixed.** `senders.js:35 gateOnly`: an automatic or imported People decision lets the sender past the Screener and marks them trusted for spam. It no longer picks the stream. Each message goes through headers, classifier and Reflex, with an `alwaysIn` signal. Replies in the user's own threads stay a hard People rule. |
| 3 | Streams and bundles decided per message; one sender can send a receipt and a question (PRD Sorting) | partial | same as 2 | high | Fixed with item 2. The user's own decisions still settle the whole sender. |
| 4 | Tier 1 reads every message Tier 0 could not settle; target 100 % coverage (PRD Two-tier) | **no** | 1 sort call ever; 0 unsure rows reach Reflex | critical | **Fixed.** `pending='reflex'` is now a durable "needs Reflex" mark. The only ways it clears are a model decision, the message aging past `sort.reflexMaxAgeDays`, or no model being configured (`llm_disabled`). The new `sort.reflexSweep` schedule (every 120 s, `engine.js:964`) does two things: it re-sorts, with Reflex allowed, recent classifier or automatic-rule rows below `classifierDecideAbove` that no model has judged, and it re-enqueues waiting rows that no live job covers. It caps retries at `sort.reflexTriesPerDay` (3) jobs per message per day. |
| 5 | Failed model work is rebuildable from the data (AI rebuild "job ledger"; V2-BUILD `rebuild`) | **no** | job 1048 never retried; 6 h clear in `pendingSweep` | critical | **Fixed.** `reflexPayloads` (`engine.js:921`) is used by both the sweep and `reflexRebuild` (index.js), so `retryFailed` and `reconcile` see the same batches. A failed job's batch is kept together, so its dedupe key and payload match and `reconcile` resolves it once the new run succeeds. The integration test covers this. |
| 6 | A full model lane waits instead of failing (V2-BUILD production hardening) | partial | lane deferral exists in `jobs.js`; the `sort.reflex` handler swallowed `budget_exceeded` and finalised rows | high | **Fixed.** `runReflexJob` rethrows everything except `llm_disabled`, so `runJob` defers `lane_busy` and gateway outages and moves `budget_exceeded` to after midnight, with rows still waiting. A missing answer keeps the row pending and returns `status: 'partial'`. A test shows a busy lane leads to a deferral with no attempt spent. |
| 7 | Re-sort after the engine or prompt changes (task; analogous to `spam.signalsVersion`) | **no** | — | high | **Added.** `version.js` holds `SORT_ENGINE_VERSION` and `engineStamp()` (engine plus the `sort.reflex` prompt version). The stamp is stored per row in `hedwig_sort.engine_version` (migration `h0017_sort_engine.sql`). The `sort.engine` schedule (at start, then every 600 s) enqueues one `sort.resort {engine}` per user. That job pages newest first through every row not decided by the user and not carrying the current stamp. Reflex is allowed within `reflexMaxAgeDays`; older mail gets the cheap layers only. Progress is kept in `hedwig_state sort.engineVersion:<user>`. |
| 8 | Server spam folder is a weak label; rescue candidates are judged by Reflex (PRD Privacy and spam; V2-BUILD decisions) | partial | 0 spam.reflex calls; window empty | high | **Fixed.** `rescueReflexCandidate` (`engine.js:1132`) selects rows with rescue score ≥ `rescueAbove − 0.45` (0.25), recent, and not phishing; that is 27 rows in production. The blend is unchanged, so the model alone cannot rescue mail with no evidence: a 0.25 score needs a "legit" at ≥ 0.95. A candidate that no model has read gets `reflex: 'pending'` in its rescue signal, and the rescue sweep picks it up once a model is available. Phishing rules are untouched. |
| 9 | Classifier heads: spam learns from real labels, not Bulk alone (PRD Learned spam; AI rebuild Triage and spam) | **no** | `samplesFromDecisions` labelled all `stream=spam` rows | high | **Fixed.** `classifier.js:114 spamLabelOf`: a spam-folder row trains the spam head only when the user, a model, a phishing verdict or a rescue judged it. |
| 10 | Per-user classifier trained on history and corrections (PRD layer 2) | partial: circular labels | heads trained on 449 import-People rows; Reading head had 2 positives | high | **Fixed.** Heads carry `metrics.engine` and are ignored under another engine version (`headsActive`, `classifier.js:69`). Each stream head also needs at least 10 positives and 10 negatives. Training uses user rows, model rows at ≥ 0.8 confidence, and rule rows stamped by the current engine only. Stale heads retrain once the engine re-sort is done (`learning.js:43`). A head the new engine cannot train is deleted. |
| 11 | Every decision stores layer, reason and provenance (PRD; V2-BUILD `hedwig_sort`) | partial | Tier 0 rows had no version; prod: 0 rows missing layer or reason | medium | **Added** `engine_version` on every engine write. `why` now returns `engineVersion` and `pending` (service.js:488). Model rows keep `prompt_id`, `prompt_version`, `model` and `ai_call_id`. Classifier-head decisions add a `classifier` signal naming the head version and sample count. |
| 12 | Needs-you reasons for People (PRD Streams; V2-BUILD Reflex output) | partial | a model `needs_you` with an empty reason stored NULL | medium | **Fixed.** `ensureNeedsYouReason` (`engine.js:420`) runs in `finalize`: "<Name> may need something from you" when neither triage nor the model wrote a reason. |
| 13 | Screener with pre-decided proposals and reasons; auto-screen logged and undoable (PRD Screener) | yes | `refreshProposals`, `setSenderDecision` log; prod 7 auto decisions, 2 screener calls | — | Unchanged. Newsletters settled by headers now auto-screen into Reading at 0.9. |
| 14 | Decisions by scope; suggest the widest safe scope (PRD) | partial | `screenerKey` gives list or address; domain is never proposed | low | Deferred. Needs a safety rule for shared domains such as gmail.com. |
| 15 | In spam but looks real, shown in the Screener (PRD) | yes | rescued rows with `needsScreen`; `screenerSenders.in_spam` | — | Unchanged. Rescued newsletters now propose Reading, not People. |
| 16 | Bundles: 9 defaults, schedules, custom by description (PRD Bundles) | yes | `bundles.js DEFAULT_BUNDLES`, `sort.bundleDescribe` | — | A newsletter no keyword places now defaults to `updates`. |
| 17 | Custom streams for power users (PRD Streams) | no | — | low | Deferred (not in R1/R2 scope). |
| 18 | Layer 1 headers: Auto-Submitted, calendar MIME, own mail, SPF/DKIM/DMARC (V2-BUILD) | yes | `headers.js headerLayer` | — | Unchanged. |
| 19 | Escalate to Qwen when Reflex < 0.6 or phishing < 0.8 (V2-BUILD 4) | yes | `reflex.js needsEscalation` | medium (runtime) | Unchanged. Qwen timed out on every call in production, so each escalation costs 45 s (runtime area). |
| 20 | Escalate rescue candidates under 0.7 to Tier 2 (PRD routing table) | no | `spamReflex` only escalates phishing | low | Deferred while Tier 2 is unreachable in production. It would add a 45 s timeout per candidate. |
| 21 | Decide after the body arrives, and re-run on body, retrain and reply (AI rebuild Triage) | yes, with a hole | `bodyWaitLeft`, `pendingSweep`, `retrainSortDue`, `clearNeedsYouAfterReply` | high | The hole is fixed: `pendingSweep` no longer clears `pending` before the re-sort, and it marks body-seen only on rows the re-sort did not rewrite. |
| 22 | Better model context: who you are, To/Cc, sender history, 5 corrections, last 2 thread messages (AI rebuild) | partial | `reflexItem` sends 600 characters of quoted context, not the last two thread messages | low | Deferred. |
| 23 | Calibrated blend fitted on gathered labels (AI rebuild) | no | fixed thresholds | low | Deferred until the labels area has enough gold labels. |
| 24 | Spam actions reversible; auto-move opt-in; never delete (PRD) | yes | `spam.autoMove` false; `spamMove.js`; `sort_log` undo | — | Unchanged. |
| 25 | Signals: similarity to mail you marked (PRD Learned spam) | no | — | low | Deferred. Needs vectors per spam label. |
| 26 | One classifier: the upstream categoriser is replaced (AI rebuild) | no | the classic shell shows upstream categories | medium | Frontend and upstream area (see requests). |
| 27 | Re-judge stored spam verdicts when signals change (V2-BUILD) | yes | `spam.signalsVersion` done 19:30, 812 checked, 14 phishing→suspected | — | Unchanged. The engine re-sort covers spam-folder rows too. |

## Why `sort.reflex` stopped after 17:31 on 2026-09-23

- 17:11: the first sort seeded 80 import People decisions (`sort.seeded`). The backfill used the
  cheap layers. `enqueueReflex` only runs for non-final rows at most 14 days old. Almost all recent
  mail was either The Ken (import decision, final) or Bulk (the rescue path, which never uses
  `sort.reflex`). Job 154 (5 messages) was done by 17:11:30.
- 17:13–18:08: the labels judge ran 33 `sort.reflex` calls on the background lane (concurrency 1,
  Redis not connected in the worker, so the limits were per process). Job 1048 waited 240 s three
  times; the build then in production had no lane deferral, so the job failed at 17:31.
- 18:11: heads were trained on the circular labels above. The `sort.resort` of classifier rows
  then gave 0.92 confidence, which is final.
- After that: no row was non-final, `pendingSweep` could only drop the 4 waiting rows after 6 h,
  and `retryFailed` ran only from the admin route.

## What production will do after deploy (nothing was run on production)

1. The worker starts, `sort.engine` sees the stamp change (`none` → `2026-09-24.1+sort.reflex@2026-09-24.1`),
   and enqueues one `sort.resort {engine}` for the user. Pages of 200 rows run at priority 8,
   newest first.
2. The 317 list rows in People (314 of them The Ken's) move to Reading (`layer=rule`, final, no model call). Import-gated
   non-list mail from the last 14 days goes to Reflex; older mail gets the cheap layers only. About
   27 spam-folder candidates get a `spam.reflex` read.
3. The current heads are ignored (they carry no engine stamp) until they retrain after the
   re-sort finishes.
4. `sort.reflexSweep` keeps Tier 1 coverage from then on. Job 1048 is resolved by `reconcile`
   (`runtime.reconcile`) once its messages no longer wait, or once a run with the same batch
   succeeds.

## Requests for other areas

- **Runtime (B):** the labels judge filled the only background lane for an hour. Give background
  work fair sharing across features (or a judge budget per hour), and confirm the worker connects
  to Redis: the log says `lanes: redis not connected; lane limits apply per process`.
  `retryFailed` now works with `sort.reflex`'s `rebuild`; failed rows whose messages a live job
  already covers are marked resolved ("no longer needed").
- **Labels (D):** `sort.reflex` is now version 2026-09-24.1 (a new list rule in the system text),
  so compare evals against that version. The judge's own spam labels should treat the Bulk folder
  as weak in the same way (`classifier.js spamLabelOf`).
- **Frontend (E):** the why sheet can show `engineVersion` and `pending` ("waiting for Reflex" or
  "waiting for the body") from `GET /sort/message/:id/why`. Show the `alwaysIn` and `listRule`
  signals as the reason ("You have written to them, but this is a newsletter"). The classic shell
  still shows upstream categories (item 26).

## Open

- Scope suggestion by domain (14), custom streams (17), rescue escalation to Tier 2 (20),
  thread-context input (22), calibrated thresholds (23), similarity signal (25).
- Transactional list mail goes to Reflex whenever the classifier is unsure, so there is more Tier 1
  load than for plain newsletters. That is expected and small (INBOX is about 2–3 messages a day
  outside The Ken).
