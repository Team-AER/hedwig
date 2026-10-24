# HTML evidence and repair

Email intelligence uses `services/emailContent.js` to select useful MIME content before feature
budgets are applied. Rendering continues to use the existing sanitized HTML and sandbox. The
content parser never fetches links, images, stylesheets, or other resources.

The shared representation retains text, table rows, link labels/targets, labeled image alt text,
secondary preheaders, selection reason, parse state, truncation warnings, version, and content
hash. Quotes, signatures, and legal footers are segmented by the existing indexer over that text.
Image-only and placeholder-only bodies do not count as readable evidence.

Raw schema.org metadata is captured before sanitization in `hedwig_email_metadata`. It is bounded,
converted into inert JSON, scoped through the owning message, and checked against visible body
evidence before it can supply card fields. The display sanitizer is unchanged.

`hedwig_email_content` stores the ownership-scoped projection and its full-text search vector.
Body updates invalidate its parser version; the worker replaces the projection asynchronously.
Changed previously normalized bodies queue their own repair. Initial upgrades are inspected and
repaired explicitly, allowing a canary before a broad rollout.

## Maintenance

Run inside the deployed backend container with its existing database environment:

```sh
node scripts/hedwig-repair-content.mjs
node scripts/hedwig-repair-content.mjs --apply --normalise-only
node scripts/hedwig-repair-content.mjs --apply MESSAGE_UUID
node scripts/hedwig-repair-content.mjs --apply --index-first --metadata
```

The last command normalizes stored bodies, builds corrected chunks in batches, queues scoped repairs, and queues rate-limited raw
metadata refreshes for changed transactional mail whose original metadata was stripped. Use the
message UUID with `--metadata` for a canary. The default command is read-only. Jobs are durable in
`hedwig_jobs`; each message checkpoints successful stages in `repair_progress`, keyed by its
content hash. Failed stages keep previous usable model outputs and can be retried through the
existing job ledger. Model budgets and provider backoff continue to apply.

Repair reindexes and embeds, recomputes machine sorting and triage, updates cards and existing
summaries, re-extracts prior facts, and refreshes dependent summaries, labels, profiles, training
features, and briefings. User overrides, edited card fields, resolved commitments, and historical
answers survive. Entity/topic summaries use the strict, versioned `context.summarise` prompt and retry malformed
outputs before replacing any stored summary. Historical answers whose source changed carry
`evidenceStale`; the UI asks the
reader to ask again. Historical sorting suppresses mailbox moves and plugin action hooks. It does
not replay inbox move/forward/send rules. A future live message still applies those rules normally.

Inspect `/api/hedwig/admin/content/health` and the maintenance command for projection and repair
counts. Do not equate service health, body presence, or a nonempty chunk with correct evidence.
Validate the content, search result, cited summary, and record card of the canary.

## Deployment and rollback

Preserve the deployed Ask web research, thread-scoped Ask, MCP tools, and SearXNG service when
selecting a baseline. Before replacing application images, save a PostgreSQL custom-format dump,
source archive, private configuration, and tags for the previous running backend/frontend images.
Rehearse the additive migration and repair on a restored database with no API/IMAP worker attached.
Use verified `tmux` sessions for backups, deployments, and unattended maintenance.

Rollback stops the new worker and restores the previous backend/frontend image tags and source.
The additive tables and columns can remain: the previous release ignores them. Disable pending
`content.*` jobs before returning to an old worker. Restoring the database dump is reserved for a
database recovery; it would also discard mail or user actions received after the backup. Keep
the backup until repaired output and normal mail behavior have been verified.
