-- v2 runtime audit (2026-09-24): per-call fallback and escalation flags, for the usage dashboard
-- (escalation rate and "answered by the lighter model" per feature per tier per day). Additive only.
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS fell_back BOOLEAN;
ALTER TABLE hedwig_ai_calls ADD COLUMN IF NOT EXISTS escalated BOOLEAN;

-- The usage endpoint groups the last N days by day, feature and tier.
CREATE INDEX IF NOT EXISTS idx_hedwig_ai_calls_created ON hedwig_ai_calls(created_at DESC);

-- Job ledger: 'deferred' (waiting for model capacity; see jobs.js) joins the partial status index.
CREATE INDEX IF NOT EXISTS idx_hedwig_jobs_deferred ON hedwig_jobs(run_at) WHERE status = 'deferred';
