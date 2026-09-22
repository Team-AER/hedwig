-- Triage additions (additive, idempotent). Owned by backend/src/hedwig/triage/.

-- The feature vector a decision was made from, so feedback and explanations use exactly what fired,
-- and the deadline a stage-1 or stage-3 pass found, so the list chip ("Deadline · 3 d") stays current.
ALTER TABLE hedwig_triage ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hedwig_triage ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_decided ON hedwig_triage(user_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_open ON hedwig_triage(user_id, COALESCE(override_category, category)) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_hedwig_triage_feedback_message ON hedwig_triage_feedback(message_id);

-- Sender and domain rules the user created from "always treat mail from X as Y".
CREATE TABLE IF NOT EXISTS hedwig_triage_rules (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('sender','domain')),
  value      TEXT NOT NULL,
  category   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, value)
);

-- Which messages have been counted into hedwig_sender_stats, so re-running a batch never double
-- counts. kind 'in' = counted as received (behaviour_at: opened/starred/archived counted too);
-- kind 'out' = an outgoing message whose reply credit was given.
CREATE TABLE IF NOT EXISTS hedwig_triage_sender_log (
  message_id   UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('in','out')),
  sender_email TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  behaviour_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_sender_log_pending ON hedwig_triage_sender_log(user_id) WHERE kind = 'in' AND behaviour_at IS NULL;
