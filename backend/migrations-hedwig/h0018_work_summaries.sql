-- Working the inbox, audit 2026-09-24 (stream F): summaries written eagerly on arrival instead of
-- only when a thread is opened, a per-message TL;DR for People and Screener rows, and the Needs You
-- reasons work derives itself (a reply overdue, a deadline near). Additive and idempotent. Owned by
-- backend/src/hedwig/work/.

-- Provenance of the cached story as columns (it is also in `provenance`), so coverage and the
-- "lighter model" label can be queried without unpacking JSON. `source` is 'eager' (the job) or
-- 'open' (computed when the thread was opened); `error` / `attempted_at` record a failed eager try
-- so the sweep does not retry it on every pass.
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS prompt_id      TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS model          TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS ai_call_id     BIGINT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS tier           TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS lighter        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS source         TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS error          TEXT;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS attempted_at   TIMESTAMPTZ;

-- One-line TL;DR per message (People and Screener rows, the top of a message). text is NULL while
-- the last try failed (error, attempts); a row is rewritten when the prompt version changes.
CREATE TABLE IF NOT EXISTS hedwig_work_tldr (
  message_id     UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text           TEXT,
  prompt_id      TEXT,
  prompt_version TEXT,
  model          TEXT,
  ai_call_id     BIGINT,
  tier           TEXT,
  lighter        BOOLEAN NOT NULL DEFAULT false,
  error          TEXT,
  attempts       INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_work_tldr_user ON hedwig_work_tldr (user_id, updated_at DESC);

-- Needs You reasons work derives from the mail itself: a person wrote to the owner directly and has
-- waited too long for a reply ('reply_overdue'), or an open commitment the owner owes is due soon
-- ('deadline'). Open while resolved_at is NULL; the owner replying or the reason lapsing resolves it.
CREATE TABLE IF NOT EXISTS hedwig_work_needs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key      TEXT NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('reply_overdue', 'deadline')),
  reason          TEXT NOT NULL,
  due_at          TIMESTAMPTZ,
  derived_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_work_needs_open
  ON hedwig_work_needs (user_id, thread_key, kind) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_work_needs_user ON hedwig_work_needs (user_id) WHERE resolved_at IS NULL;
