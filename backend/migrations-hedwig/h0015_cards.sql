-- Hedwig v2 wave 2, stream G: Ask on the new index and cards (receipts, invoices, subscriptions,
-- deliveries, travel, events, one-time codes, deadlines). Additive and idempotent. Owned by
-- backend/src/hedwig/ask2/ and backend/src/hedwig/cards/. Everything here is derived from mail and
-- can be rebuilt, except user edits (user_edited) and dismissals.

-- ── Ask log: the plan, citation check, follow-ups, provenance and feedback ────────────────────
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS plan           JSONB;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS unsupported    BOOLEAN;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS not_found      BOOLEAN;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS follow_up_of   UUID REFERENCES hedwig_ask_log(id) ON DELETE SET NULL;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS model          TEXT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS ai_call_id     BIGINT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS prompt_id      TEXT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE hedwig_ask_log ADD COLUMN IF NOT EXISTS feedback       JSONB;

-- ── Cards ─────────────────────────────────────────────────────────────────────────────────────
-- One row per thing (an order, a parcel, a booking, an event), not per message: dedupe_key names the
-- thing (order number, carrier + tracking number, calendar UID, …) so a later mail about it updates
-- the same card. message_id is the first message; message_ids every message that contributed.
-- fields: the kind's values; sources: { <field>: { messageId, quote, attachment? } } for every field.
CREATE TABLE IF NOT EXISTS hedwig_cards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  message_ids    UUID[] NOT NULL DEFAULT '{}',
  kind           TEXT NOT NULL CHECK (kind IN ('receipt','invoice','subscription','delivery','travel','event','code','deadline')),
  dedupe_key     TEXT NOT NULL,
  fields         JSONB NOT NULL DEFAULT '{}'::jsonb,
  sources        JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence     REAL,
  layer          TEXT NOT NULL CHECK (layer IN ('schema_org','ics','pattern','reflex','reasoning','derived','user')),
  prompt_id      TEXT,
  prompt_version TEXT,
  model          TEXT,
  ai_call_id     BIGINT,
  user_edited    BOOLEAN NOT NULL DEFAULT false,
  event_at       TIMESTAMPTZ,              -- the date the card is about (delivery, due date, departure, event start, charge)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hedwig_cards_thing ON hedwig_cards(user_id, kind, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_hedwig_cards_user ON hedwig_cards(user_id, kind, updated_at DESC) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_cards_event ON hedwig_cards(user_id, event_at) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hedwig_cards_message ON hedwig_cards(message_id);
CREATE INDEX IF NOT EXISTS idx_hedwig_cards_messages ON hedwig_cards USING gin (message_ids);

-- Which sorted messages the card job has looked at, under which detector version.
CREATE TABLE IF NOT EXISTS hedwig_cards_scan (
  message_id  UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('done','waiting','deferred','error')),
  found       INT NOT NULL DEFAULT 0,
  reflex      BOOLEAN NOT NULL DEFAULT false,
  error       TEXT,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_cards_scan_user ON hedwig_cards_scan(user_id, state);

-- Raw calendar parts (.ics / text/calendar attachments), fetched with BODY.PEEK by an API-side job.
CREATE TABLE IF NOT EXISTS hedwig_card_parts (
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_index INT NOT NULL,
  filename         TEXT,
  mime             TEXT,
  text             TEXT,
  error            TEXT,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, attachment_index)
);

-- Deadline cards are the open commitments with a due date: a view, so nothing is copied and an edit
-- to either side is the same edit. Everything the card routes read goes through this view.
CREATE OR REPLACE VIEW hedwig_cards_all AS
  SELECT c.id, c.user_id, c.message_id, c.message_ids, c.kind, c.dedupe_key, c.fields, c.sources, c.confidence, c.layer,
         c.prompt_id, c.prompt_version, c.model, c.ai_call_id, c.user_edited, c.event_at, c.created_at, c.updated_at, c.dismissed_at
    FROM hedwig_cards c
  UNION ALL
  SELECT k.id, k.user_id, k.source_message_id,
         CASE WHEN k.source_message_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[k.source_message_id] END,
         'deadline', 'commitment:' || k.id::text,
         jsonb_build_object('what', k.what, 'dueAt', k.due_at, 'direction', k.direction, 'counterparty', k.counterparty, 'status', k.status),
         jsonb_build_object('what', jsonb_build_object('messageId', k.source_message_id, 'quote', k.what),
                            'dueAt', jsonb_build_object('messageId', k.source_message_id, 'quote', k.what)),
         k.confidence, 'derived', NULL, NULL, NULL, NULL, k.user_edited, k.due_at, k.created_at, k.updated_at,
         CASE WHEN k.status = 'open' THEN NULL ELSE COALESCE(k.resolved_at, k.updated_at) END
    FROM hedwig_commitments k
   WHERE k.due_at IS NOT NULL;
