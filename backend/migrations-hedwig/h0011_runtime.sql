-- v2 runtime (stream B): job ledger states, model-call provenance, corrections. Additive only.

-- ── Job ledger ──
-- status is written by jobs.js on every transition: queued|running|done|partial|failed|resolved|retried.
-- resolved/retried are terminal states for rows that failed: a later run succeeded, the work no
-- longer exists, or the row was re-enqueued as a new job.
ALTER TABLE hedwig_jobs ADD COLUMN IF NOT EXISTS status     TEXT;
ALTER TABLE hedwig_jobs ADD COLUMN IF NOT EXISTS tokens_in  INT NOT NULL DEFAULT 0;
ALTER TABLE hedwig_jobs ADD COLUMN IF NOT EXISTS tokens_out INT NOT NULL DEFAULT 0;
ALTER TABLE hedwig_jobs ADD COLUMN IF NOT EXISTS note       TEXT;

UPDATE hedwig_jobs SET status = CASE
    WHEN done_at IS NOT NULL THEN 'done'
    WHEN failed_at IS NOT NULL THEN 'failed'
    WHEN locked_at IS NOT NULL THEN 'running'
    ELSE 'queued' END
  WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_hedwig_jobs_status ON hedwig_jobs(status, kind) WHERE status IN ('failed', 'running');

-- ── Model-call provenance ──
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS prompt_id      TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS prompt_hash    TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS lane           TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS tier           TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS workflow       TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS job_id         BIGINT;
-- Only written when llm.keepTranscripts is on; nulled after llm.transcriptDays.
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS prompt_text    TEXT;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS output_text    TEXT;

-- Token budgets sum a user's calls per feature for the day.
CREATE INDEX IF NOT EXISTS idx_hedwig_ai_calls_user_feature_day ON hedwig_ai_calls(user_id, feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_ai_calls_prompt ON hedwig_ai_calls(prompt_id, prompt_version, created_at DESC) WHERE prompt_id IS NOT NULL;

-- ── Corrections: every time a person fixes something Hedwig decided ──
CREATE TABLE IF NOT EXISTS hedwig_corrections (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('sort', 'screener', 'spam', 'summary', 'answer', 'extraction', 'topic', 'card')),
  target_id      TEXT,
  before         JSONB,
  after          JSONB,
  note           TEXT,
  prompt_id      TEXT,
  prompt_version TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_corrections_user_kind ON hedwig_corrections(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_corrections_target ON hedwig_corrections(kind, target_id);
