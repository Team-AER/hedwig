-- Hedwig core schema. Every table is prefixed hedwig_ and derived from upstream tables,
-- so dropping all of them loses nothing a user typed except overrides, grants and settings.
-- Runs after the upstream migrations, tracked in schema_migrations as 'hedwig/h0001_core'.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Jobs ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hedwig_jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key   TEXT,
  priority     SMALLINT NOT NULL DEFAULT 5,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at      TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hedwig_jobs_dedupe ON hedwig_jobs(dedupe_key) WHERE done_at IS NULL AND failed_at IS NULL AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_jobs_ready ON hedwig_jobs(priority, run_at) WHERE done_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_jobs_kind ON hedwig_jobs(kind, created_at DESC);

-- ── Per-message pipeline state (the "outbox by absence": no row = not yet seen) ──
CREATE TABLE IF NOT EXISTS hedwig_msg (
  message_id     UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  text_hash      TEXT,
  entities_at    TIMESTAMPTZ,
  embedded_at    TIMESTAMPTZ,
  triaged_at     TIMESTAMPTZ,
  extracted_at   TIMESTAMPTZ,
  topic_at       TIMESTAMPTZ,
  skip_reason    TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_hedwig_msg_user ON hedwig_msg(user_id, seen_at DESC);

-- ── Embeddings (dimension-agnostic column; per-dims HNSW indexes are ensured at runtime) ──
CREATE TABLE IF NOT EXISTS hedwig_embeddings (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INT NOT NULL,
  embedding  vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_embeddings_user ON hedwig_embeddings(user_id, dims);

-- ── Entities: people and organisations, merged across addresses and accounts ──
CREATE TABLE IF NOT EXISTS hedwig_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('person','org','self')),
  display_name    TEXT,
  primary_email   TEXT,
  domain          TEXT,
  org_id          UUID REFERENCES hedwig_entities(id) ON DELETE SET NULL,
  message_count   INT NOT NULL DEFAULT 0,
  received_count  INT NOT NULL DEFAULT 0,
  sent_count      INT NOT NULL DEFAULT 0,
  first_seen      TIMESTAMPTZ,
  last_seen       TIMESTAMPTZ,
  is_bulk         BOOLEAN NOT NULL DEFAULT false,
  summary         TEXT,
  summary_at      TIMESTAMPTZ,
  summary_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hedwig_entities_key ON hedwig_entities(user_id, kind, lower(COALESCE(primary_email, domain)));
CREATE INDEX IF NOT EXISTS idx_hedwig_entities_recent ON hedwig_entities(user_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_entities_name_trgm ON hedwig_entities USING gin (display_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS hedwig_entity_addresses (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email     TEXT NOT NULL,
  entity_id UUID NOT NULL REFERENCES hedwig_entities(id) ON DELETE CASCADE,
  name      TEXT,
  PRIMARY KEY (user_id, email)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_entity_addresses_entity ON hedwig_entity_addresses(entity_id);

CREATE TABLE IF NOT EXISTS hedwig_message_entities (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity_id  UUID NOT NULL REFERENCES hedwig_entities(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('from','to','cc')),
  PRIMARY KEY (message_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_message_entities_entity ON hedwig_message_entities(entity_id);

-- ── Topics: clusters that span threads over time ──
CREATE TABLE IF NOT EXISTS hedwig_topics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT,
  summary         TEXT,
  summary_at      TIMESTAMPTZ,
  summary_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  centroid        vector,
  dims            INT,
  message_count   INT NOT NULL DEFAULT 0,
  first_seen      TIMESTAMPTZ,
  last_seen       TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  pinned          BOOLEAN NOT NULL DEFAULT false,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_topics_user ON hedwig_topics(user_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS hedwig_topic_members (
  topic_id   UUID NOT NULL REFERENCES hedwig_topics(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  thread_key TEXT,
  score      REAL,
  PRIMARY KEY (topic_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_topic_members_msg ON hedwig_topic_members(message_id);

-- ── Commitments and facts, with provenance ──
CREATE TABLE IF NOT EXISTS hedwig_commitments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction              TEXT NOT NULL CHECK (direction IN ('i_owe','they_owe')),
  counterparty_entity_id UUID REFERENCES hedwig_entities(id) ON DELETE SET NULL,
  counterparty           TEXT,
  what                   TEXT NOT NULL,
  due_at                 TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  source_message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  thread_key             TEXT,
  topic_id               UUID REFERENCES hedwig_topics(id) ON DELETE SET NULL,
  confidence             REAL,
  user_edited            BOOLEAN NOT NULL DEFAULT false,
  resolved_at            TIMESTAMPTZ,
  resolved_by_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_commitments_open ON hedwig_commitments(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_hedwig_commitments_entity ON hedwig_commitments(counterparty_entity_id);

CREATE TABLE IF NOT EXISTS hedwig_facts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id         UUID REFERENCES hedwig_entities(id) ON DELETE CASCADE,
  topic_id          UUID REFERENCES hedwig_topics(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  confidence        REAL,
  pinned            BOOLEAN NOT NULL DEFAULT false,
  user_edited       BOOLEAN NOT NULL DEFAULT false,
  dismissed         BOOLEAN NOT NULL DEFAULT false,
  plugin_id         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_facts_entity ON hedwig_facts(entity_id) WHERE NOT dismissed;
CREATE INDEX IF NOT EXISTS idx_hedwig_facts_topic ON hedwig_facts(topic_id) WHERE NOT dismissed;
CREATE INDEX IF NOT EXISTS idx_hedwig_facts_user_key ON hedwig_facts(user_id, key);

-- ── Triage ──
CREATE TABLE IF NOT EXISTS hedwig_triage (
  message_id        UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  priority          REAL NOT NULL DEFAULT 0,
  needs_you         BOOLEAN NOT NULL DEFAULT false,
  spam_score        REAL,
  confidence        REAL,
  stage             SMALLINT NOT NULL DEFAULT 1,
  reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_label      TEXT,
  model_version     INT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  overridden        BOOLEAN NOT NULL DEFAULT false,
  override_category TEXT,
  override_at       TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_list ON hedwig_triage(user_id, category, priority DESC, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_needs ON hedwig_triage(user_id, priority DESC) WHERE needs_you AND resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS hedwig_triage_feedback (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  label      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('explicit','implicit')),
  features   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_triage_feedback_user ON hedwig_triage_feedback(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hedwig_triage_feedback_implicit ON hedwig_triage_feedback(message_id) WHERE source = 'implicit';

CREATE TABLE IF NOT EXISTS hedwig_triage_models (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version    INT NOT NULL DEFAULT 1,
  model      JSONB NOT NULL,
  metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  samples    INT NOT NULL DEFAULT 0,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hedwig_sender_stats (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_email     TEXT NOT NULL,
  domain           TEXT,
  received         INT NOT NULL DEFAULT 0,
  opened           INT NOT NULL DEFAULT 0,
  replied          INT NOT NULL DEFAULT 0,
  starred          INT NOT NULL DEFAULT 0,
  archived_unread  INT NOT NULL DEFAULT 0,
  deleted_unread   INT NOT NULL DEFAULT 0,
  last_received    TIMESTAMPTZ,
  last_replied     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sender_email)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_sender_stats_domain ON hedwig_sender_stats(user_id, domain);

-- ── Model call log ──
CREATE TABLE IF NOT EXISTS hedwig_ai_calls (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  feature           TEXT NOT NULL,
  plugin_id         TEXT,
  model             TEXT,
  reasoning         TEXT,
  prompt_tokens     INT,
  completion_tokens INT,
  latency_ms        INT,
  ok                BOOLEAN NOT NULL,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_ai_calls_day ON hedwig_ai_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedwig_ai_calls_feature ON hedwig_ai_calls(feature, created_at DESC);

-- ── Insights and briefings ──
CREATE TABLE IF NOT EXISTS hedwig_insights (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  title        TEXT NOT NULL,
  body         TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  sources      JSONB NOT NULL DEFAULT '[]'::jsonb,
  severity     TEXT NOT NULL DEFAULT 'info',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_insights_user ON hedwig_insights(user_id, kind, created_at DESC);

-- ── Agent framework ──
CREATE TABLE IF NOT EXISTS hedwig_automations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  schedule      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  deliver       TEXT NOT NULL DEFAULT 'insight',
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_automations_due ON hedwig_automations(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS hedwig_agent_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL DEFAULT 'chat',
  automation_id UUID REFERENCES hedwig_automations(id) ON DELETE SET NULL,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  messages      JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  result        TEXT,
  error         TEXT,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_agent_runs_user ON hedwig_agent_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hedwig_agent_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES hedwig_agent_runs(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_agent_actions_pending ON hedwig_agent_actions(user_id, status);

-- ── Plugin runtime v2 ──
CREATE TABLE IF NOT EXISTS hedwig_plugins (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  location     TEXT,
  manifest     JSONB NOT NULL,
  sha256       TEXT,
  status       TEXT NOT NULL DEFAULT 'installed',
  error        TEXT,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hedwig_plugin_grants (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id  TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, plugin_id, permission)
);

-- ── Per-user settings and UI layouts ──
CREATE TABLE IF NOT EXISTS hedwig_user_settings (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hedwig_layouts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  device     TEXT NOT NULL DEFAULT 'desktop' CHECK (device IN ('desktop','tablet','phone')),
  tree       JSONB NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device, name)
);

-- ── Small key/value state (backfill cursors, schedule bookkeeping) ──
CREATE TABLE IF NOT EXISTS hedwig_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
