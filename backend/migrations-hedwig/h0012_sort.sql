-- Stream C: sorting (People / Reading / Records, Screener, bundles, rules, spam rescue).
-- Additive and idempotent. Owned by backend/src/hedwig/sort/. Other modules may read these tables.

-- Sender decisions. One active row per (user, scope, key); undoing or replacing a decision stamps
-- undone_at on the old row instead of deleting it, so "Hedwig today" can restore it.
CREATE TABLE IF NOT EXISTS hedwig_senders (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('address','domain','list')),
  decision    TEXT NOT NULL CHECK (decision IN ('people','reading','records','block')),
  source      TEXT NOT NULL CHECK (source IN ('user','auto','import','rule')),
  confidence  REAL,
  reason      TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_senders_active ON hedwig_senders(user_id, scope, key) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_senders_user ON hedwig_senders(user_id, decided_at DESC);

-- What Hedwig would decide for an undecided sender (aggregated from message layers, refined by the
-- sort.screener prompt). Shown in the Screener; accepted proposals become hedwig_senders rows.
CREATE TABLE IF NOT EXISTS hedwig_sender_proposals (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('address','domain','list')),
  proposed       TEXT NOT NULL CHECK (proposed IN ('people','reading','records','block')),
  confidence     REAL,
  reason         TEXT,
  source         TEXT NOT NULL DEFAULT 'layers',
  prompt_version TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scope, key)
);

-- One sorting decision per message.
CREATE TABLE IF NOT EXISTS hedwig_sort (
  message_id        UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  stream            TEXT NOT NULL CHECK (stream IN ('people','reading','records','screener','spam')),
  proposed_stream   TEXT CHECK (proposed_stream IS NULL OR proposed_stream IN ('people','reading','records','block')),
  bundle            TEXT,
  held              BOOLEAN NOT NULL DEFAULT false,
  needs_you         BOOLEAN NOT NULL DEFAULT false,
  needs_you_reason  TEXT,
  spam              TEXT NOT NULL DEFAULT 'clean' CHECK (spam IN ('clean','suspected','phishing','rescued')),
  spam_reason       TEXT,
  confidence        REAL,
  layer             TEXT NOT NULL CHECK (layer IN ('rule','classifier','reflex','reasoning','user')),
  reason            TEXT,
  signals           JSONB NOT NULL DEFAULT '[]'::jsonb,
  features          JSONB,
  labels            TEXT[] NOT NULL DEFAULT '{}',
  notify            BOOLEAN NOT NULL DEFAULT false,
  rule_id           UUID,
  rule_matches      JSONB NOT NULL DEFAULT '[]'::jsonb,
  sender_key        TEXT,
  sender_scope      TEXT,
  own               BOOLEAN NOT NULL DEFAULT false,
  in_spam_folder    BOOLEAN NOT NULL DEFAULT false,
  pending           TEXT,
  prompt_id         TEXT,
  prompt_version    TEXT,
  model             TEXT,
  ai_call_id        BIGINT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_seen         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_stream ON hedwig_sort(user_id, stream) WHERE NOT held AND NOT own;
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_needs_you ON hedwig_sort(user_id) WHERE needs_you AND NOT own;
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_sender ON hedwig_sort(user_id, sender_scope, sender_key);
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_pending ON hedwig_sort(user_id) WHERE pending IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_held ON hedwig_sort(user_id, bundle) WHERE held;
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_decided ON hedwig_sort(user_id, decided_at DESC);

-- Bundles and their delivery schedules. schedule = {"mode":"instant"} | {"mode":"daily","at":"HH:MM"}
-- | {"mode":"weekly","day":0-6,"at":"HH:MM"} in the user's insights.timezone.
CREATE TABLE IF NOT EXISTS hedwig_bundles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  hint              TEXT,
  keywords          JSONB NOT NULL DEFAULT '[]'::jsonb,
  stream            TEXT NOT NULL DEFAULT 'records' CHECK (stream IN ('reading','records')),
  schedule          JSONB NOT NULL DEFAULT '{"mode":"instant"}'::jsonb,
  builtin           BOOLEAN NOT NULL DEFAULT false,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  position          INT NOT NULL DEFAULT 0,
  last_delivered_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS hedwig_bundle_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  bundle_id    UUID NOT NULL REFERENCES hedwig_bundles(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_ids  UUID[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_hedwig_bundle_deliveries ON hedwig_bundle_deliveries(bundle_id, delivered_at DESC);

-- Ordered user rules. conditions = {"match":"all"|"any","items":[{field, op, value, name?}]};
-- actions = [{type, value?}]. created_from_correction_id is text so it holds whatever id type
-- hedwig_corrections uses.
CREATE TABLE IF NOT EXISTS hedwig_rules (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position                   INT NOT NULL DEFAULT 0,
  name                       TEXT NOT NULL,
  enabled                    BOOLEAN NOT NULL DEFAULT true,
  conditions                 JSONB NOT NULL,
  actions                    JSONB NOT NULL,
  source                     TEXT NOT NULL DEFAULT 'user',
  created_from_correction_id TEXT,
  hits                       INT NOT NULL DEFAULT 0,
  last_hit_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_rules_user ON hedwig_rules(user_id, position);

-- "Hedwig today": everything sorting did on its own or at the user's request, with undo.
CREATE TABLE IF NOT EXISTS hedwig_sort_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  "from"      JSONB,
  "to"        JSONB,
  by          TEXT NOT NULL DEFAULT 'auto',
  undone_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_sort_log_user ON hedwig_sort_log(user_id, created_at DESC);

-- Per-user classifier heads for sorting (stream one-vs-rest and spam), trained with triage/model.js.
CREATE TABLE IF NOT EXISTS hedwig_sort_models (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  head       TEXT NOT NULL,
  version    INT NOT NULL DEFAULT 1,
  model      JSONB NOT NULL,
  metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  samples    INT NOT NULL DEFAULT 0,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, head)
);
