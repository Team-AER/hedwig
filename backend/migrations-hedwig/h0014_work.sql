-- v2 "Working the inbox" and "Writing" (stream F). Additive and idempotent. Owned by
-- backend/src/hedwig/work/.

-- Lists a thread can be on: Reply Later, Set Aside, Pinned, reminders, Done, and the snoozes made
-- through Hedwig (so "back from snooze" can be shown as a reason). An item is open while done_at is
-- NULL; done_at records when it closed and done_reason why ('user', 'replied', 'new_mail', 'done').
-- A reminder without a thread has thread_key NULL and its text in note, its time in until.
CREATE TABLE IF NOT EXISTS hedwig_work_items (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key        TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('reply_later','set_aside','pin','reminder','done','snoozed')),
  note              TEXT,
  until             TIMESTAMPTZ,
  position          INT NOT NULL DEFAULT 0,
  anchor_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at           TIMESTAMPTZ,
  done_reason       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_work_items_open
  ON hedwig_work_items (user_id, kind, thread_key) WHERE done_at IS NULL AND thread_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_work_items_thread ON hedwig_work_items (user_id, thread_key) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_work_items_kind ON hedwig_work_items (user_id, kind, position) WHERE done_at IS NULL;

-- Thread story ("since you last looked") and quick replies, cached per thread and recomputed only
-- when the thread grows (a different latest message).
CREATE TABLE IF NOT EXISTS hedwig_work_stories (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key       TEXT NOT NULL,
  up_to_message_id UUID,
  message_count    INT NOT NULL DEFAULT 0,
  story            JSONB NOT NULL,
  provenance       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, thread_key)
);

-- "Remind me if no reply in N days": a watch on a thread, anchored at the user's last message
-- (or the moment it was set, at compose time). Due at due_at; resolved when anyone else writes.
CREATE TABLE IF NOT EXISTS hedwig_work_waiting (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key      TEXT NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  anchor_at       TIMESTAMPTZ NOT NULL,
  days            INT NOT NULL,
  due_at          TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_work_waiting_open
  ON hedwig_work_waiting (user_id, thread_key) WHERE resolved_at IS NULL;
