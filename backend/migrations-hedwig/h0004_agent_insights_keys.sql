-- Insights and agent: keys and lookups the h0001 tables need once they are in use. Additive only.

-- One insight card per (user, card key, local day): regenerating cards during the day updates the
-- card in place instead of stacking duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hedwig_insights_card_key
  ON hedwig_insights (user_id, (data->>'key'), period_start) WHERE kind = 'card';

-- Actions are listed per run on the run page and per user by status in the approvals list.
CREATE INDEX IF NOT EXISTS idx_hedwig_agent_actions_run ON hedwig_agent_actions (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hedwig_agent_actions_user_created ON hedwig_agent_actions (user_id, created_at DESC);
