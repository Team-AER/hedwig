-- Ask about one thread, and Ask with the web (ask2/answer.js). thread_key: the conversation the
-- question was asked from (the reader's "Ask about this"), so reopening that thread brings its chat
-- back; keyed by thread_key like every other Hedwig list, never by a folder on the mail server.
-- web: whether this answer was allowed to search the web. web_sources: the pages it read or saw as
-- search snippets, numbered after the mail sources, kept so a saved answer's citations still open
-- without fetching anything again.
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS thread_key  TEXT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS web         BOOLEAN;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS web_sources JSONB;

CREATE INDEX IF NOT EXISTS idx_hedwig_ask_log_thread ON hedwig_ask_log(user_id, thread_key, created_at DESC)
  WHERE thread_key IS NOT NULL;
