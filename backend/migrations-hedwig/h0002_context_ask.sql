-- Context engine additions: the ask log, the overdue stamp, and lookup indexes for the
-- thread- and source-based queries the context engine runs on every extraction.
-- Per-dimension HNSW indexes on hedwig_embeddings are created at runtime (dims is configurable).

CREATE TABLE IF NOT EXISTS hedwig_ask_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  entity_id    UUID REFERENCES hedwig_entities(id) ON DELETE SET NULL,
  topic_id     UUID REFERENCES hedwig_topics(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  answer       TEXT,
  citations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_ask_log_user ON hedwig_ask_log(user_id, created_at DESC);

ALTER TABLE hedwig_commitments ADD COLUMN IF NOT EXISTS overdue_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_hedwig_commitments_thread ON hedwig_commitments(user_id, thread_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_hedwig_commitments_topic ON hedwig_commitments(topic_id);
CREATE INDEX IF NOT EXISTS idx_hedwig_commitments_source ON hedwig_commitments(source_message_id);
CREATE INDEX IF NOT EXISTS idx_hedwig_facts_source ON hedwig_facts(source_message_id);
CREATE INDEX IF NOT EXISTS idx_hedwig_topic_members_thread ON hedwig_topic_members(thread_key);
CREATE INDEX IF NOT EXISTS idx_hedwig_entities_org ON hedwig_entities(org_id) WHERE org_id IS NOT NULL;
