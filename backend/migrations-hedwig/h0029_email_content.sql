-- Derived intelligence content, separate from the provider's body and display sanitizer.
CREATE TABLE IF NOT EXISTS hedwig_email_content (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  links JSONB NOT NULL DEFAULT '[]',
  tables JSONB NOT NULL DEFAULT '[]',
  warnings JSONB NOT NULL DEFAULT '[]',
  tsv TSVECTOR,
  changed BOOLEAN NOT NULL DEFAULT false,
  auto_repair BOOLEAN NOT NULL DEFAULT false,
  repair_state TEXT NOT NULL DEFAULT 'pending',
  repair_error TEXT,
  repair_progress JSONB NOT NULL DEFAULT '{}',
  repaired_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_email_content_tsv ON hedwig_email_content USING GIN(tsv);
CREATE INDEX IF NOT EXISTS idx_hedwig_email_content_repair ON hedwig_email_content(repair_state, updated_at) WHERE changed;
ALTER TABLE hedwig_work_stories ADD COLUMN IF NOT EXISTS input_hash TEXT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS evidence_stale BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS hedwig_email_metadata (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '[]',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Preserve the previous usable projection until the worker has parsed a changed body.
CREATE OR REPLACE FUNCTION hedwig_invalidate_email_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE hedwig_email_content SET version = NULL, updated_at = NOW() WHERE message_id = NEW.id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hedwig_body_content_changed ON messages;
CREATE TRIGGER hedwig_body_content_changed AFTER UPDATE OF body_text, body_html ON messages
  FOR EACH ROW WHEN (OLD.body_text IS DISTINCT FROM NEW.body_text OR OLD.body_html IS DISTINCT FROM NEW.body_html)
  EXECUTE FUNCTION hedwig_invalidate_email_content();
