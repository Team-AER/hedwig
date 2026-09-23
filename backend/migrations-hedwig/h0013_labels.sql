-- v2 labels and evals (stream D). Additive and idempotent. Owned by backend/src/hedwig/labels/.

-- Labels gathered without homework: behaviour (weak/silver), the nightly judge (silver), answered
-- questions and corrections (gold), and generated ask triples. One row per (user, suite, target,
-- source, rule): a rule re-firing updates its row instead of stacking duplicates.
CREATE TABLE IF NOT EXISTS hedwig_labels (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suite      TEXT NOT NULL CHECK (suite IN ('sort','needs_you','spam','rescue','ask','extraction','topic')),
  target_id  TEXT NOT NULL,
  label      JSONB NOT NULL,
  grade      TEXT NOT NULL CHECK (grade IN ('weak','silver','gold')),
  source     TEXT NOT NULL CHECK (source IN ('behaviour','judge','question','correction','generated')),
  evidence   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_labels_rule
  ON hedwig_labels (user_id, suite, target_id, source, (COALESCE(evidence->>'rule', '')));
CREATE INDEX IF NOT EXISTS idx_hedwig_labels_suite ON hedwig_labels (user_id, suite, grade);
CREATE INDEX IF NOT EXISTS idx_hedwig_labels_target ON hedwig_labels (target_id);

-- Gentle questions. At most one question per target, ever: answered, skipped and dropped rows stay
-- so the same thing is never asked twice.
CREATE TABLE IF NOT EXISTS hedwig_questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  question    TEXT NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority    REAL NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asked_at    TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  answer      JSONB,
  dropped_at  TIMESTAMPTZ,
  drop_reason TEXT,
  UNIQUE (user_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_questions_open
  ON hedwig_questions (user_id, priority DESC, created_at) WHERE answered_at IS NULL AND dropped_at IS NULL;

-- Eval harness runs. metrics = { silver: {...}, gold: {...}, scope: {...}, gates: {...} }.
CREATE TABLE IF NOT EXISTS hedwig_eval_runs (
  id             BIGSERIAL PRIMARY KEY,
  suite          TEXT NOT NULL,
  prompt_id      TEXT,
  prompt_version TEXT,
  model          TEXT,
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  n_gold         INT NOT NULL DEFAULT 0,
  n_silver       INT NOT NULL DEFAULT 0,
  accepted       BOOLEAN NOT NULL DEFAULT false,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_hedwig_eval_runs_suite ON hedwig_eval_runs (suite, started_at DESC);
