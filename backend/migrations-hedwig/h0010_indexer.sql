-- Hedwig v2 index (stream A): coverage ledger, chunks, chunk vectors, attachment text.
-- Everything here is derived from upstream mail tables and can be rebuilt; dropping these tables
-- loses nothing a user typed. Additive and idempotent.

-- ── Coverage ledger: one row per included folder per account ──────────────────
-- State is recomputed from absence counts on every refresh, so a folder can never be stuck in
-- 'done' while it has unindexed mail (the bug the old single pipeline.backfill cursor had).
CREATE TABLE IF NOT EXISTS hedwig_index_coverage (
  account_id  UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder      TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spam        BOOLEAN NOT NULL DEFAULT false,   -- server spam folder: indexed, hidden from retrieval by default
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','paused')),
  cursor      TIMESTAMPTZ,                      -- oldest message date Hedwig has seen in this folder
  total       INT NOT NULL DEFAULT 0,           -- messages in the folder (not deleted)
  seen        INT NOT NULL DEFAULT 0,           -- with a hedwig_msg row
  dupes       INT NOT NULL DEFAULT 0,           -- copies of a message already seen elsewhere (never chunked)
  bodies      INT NOT NULL DEFAULT 0,           -- with a body
  body_failed INT NOT NULL DEFAULT 0,           -- body fetch failed or came back empty
  chunked     INT NOT NULL DEFAULT 0,           -- chunked under the current chunker version
  embedded    INT NOT NULL DEFAULT 0,           -- every chunk embedded under the current recipe
  error       TEXT,
  rules_hash  TEXT,
  reset_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, folder)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_index_coverage_user ON hedwig_index_coverage(user_id);

-- ── Per-message index state (body acquisition, chunk version, embed recipe) ──
CREATE TABLE IF NOT EXISTS hedwig_index_msg (
  message_id          UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_key          TEXT,
  msg_date            TIMESTAMPTZ,
  spam                BOOLEAN NOT NULL DEFAULT false,
  chunk_version       TEXT,                     -- NULL = due for (re)chunking
  had_body            BOOLEAN NOT NULL DEFAULT false,
  chunks              INT NOT NULL DEFAULT 0,
  chunked_at          TIMESTAMPTZ,
  embed_recipe        TEXT,                     -- NULL = some chunk still lacks a vector for the current recipe
  embedded_at         TIMESTAMPTZ,
  body_state          TEXT CHECK (body_state IN ('requested','failed','empty')),
  body_requested_at   TIMESTAMPTZ,
  body_attempts       INT NOT NULL DEFAULT 0,
  body_error          TEXT,
  attach_state        TEXT CHECK (attach_state IN ('queued','done','failed','skipped','retry')),
  attach_requested_at TIMESTAMPTZ,
  attach_error        TEXT,
  error               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_index_msg_unchunked ON hedwig_index_msg(msg_date DESC) WHERE chunk_version IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_index_msg_unembedded ON hedwig_index_msg(msg_date DESC) WHERE embed_recipe IS NULL AND chunk_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_index_msg_nobody ON hedwig_index_msg(message_id) WHERE had_body = false;
CREATE INDEX IF NOT EXISTS idx_hedwig_index_msg_body_state ON hedwig_index_msg(body_state) WHERE body_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_index_msg_user ON hedwig_index_msg(user_id);

-- ── Chunks ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hedwig_chunks (
  id               BIGSERIAL PRIMARY KEY,
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key       TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('header','body','quote','attachment','thread')),
  ordinal          INT NOT NULL DEFAULT 0,
  attachment_index INT,
  text             TEXT NOT NULL,
  tokens           INT NOT NULL DEFAULT 0,
  tsv              TSVECTOR,
  recipe           TEXT NOT NULL,              -- chunker version (index.recipe)
  spam             BOOLEAN NOT NULL DEFAULT false,
  msg_date         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunks_tsv ON hedwig_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunks_message ON hedwig_chunks(message_id, recipe);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunks_user ON hedwig_chunks(user_id, recipe, msg_date DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunks_thread ON hedwig_chunks(user_id, thread_key);

-- ── Chunk vectors (bge-m3, 1,024 dims), keyed by recipe = <chunker version>:<model> ──
CREATE TABLE IF NOT EXISTS hedwig_chunk_vectors (
  chunk_id   BIGINT NOT NULL REFERENCES hedwig_chunks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  recipe     TEXT NOT NULL,
  dims       INT NOT NULL,
  vector     vector(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chunk_id, recipe)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunk_vectors_hnsw ON hedwig_chunk_vectors USING hnsw (vector vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_hedwig_chunk_vectors_user ON hedwig_chunk_vectors(user_id, recipe);

-- ── Attachment text (Apache Tika) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hedwig_attachment_text (
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_index INT NOT NULL,
  filename         TEXT,
  mime             TEXT,
  part             TEXT,
  bytes            INT,
  chars            INT NOT NULL DEFAULT 0,
  text             TEXT,
  error            TEXT,
  extracted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, attachment_index)
);

-- ── Body-job lookup ─────────────────────────────────────────────────────────────
-- acquire.js reconcileBodies() finds each requested body's latest job by dedupe_key ('body:<id>')
-- every sweep; without this the LATERAL lookup scans all of hedwig_jobs once per row. (The unique
-- dedupe index only covers pending jobs, and the lookup must also see finished and failed ones.)
CREATE INDEX IF NOT EXISTS hedwig_jobs_dedupe_key_idx ON hedwig_jobs (dedupe_key, id DESC) WHERE dedupe_key IS NOT NULL;
