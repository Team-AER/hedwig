-- Hedwig v2 wave 3, stream I: the memory profile. Additive and idempotent. Owned by
-- backend/src/hedwig/profile/. Onboarding and the admin routing table keep their state in config
-- (hedwig_user_settings / system_settings), so they need no tables.
--
-- One row per version of a user's profile: a short second-person text (at most profile.maxLines
-- lines), rebuilt weekly from behaviour and edited by the user. User-written lines are pinned and
-- survive every rebuild verbatim; lines the user deleted are remembered in `dismissed` so a rebuild
-- never brings them back. `diff` is the unified diff from the previous version. Versions are never
-- updated or deleted by Hedwig (the history is the audit trail).
CREATE TABLE IF NOT EXISTS hedwig_profile (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  pinned      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- the user's own lines, kept verbatim
  dismissed   JSONB NOT NULL DEFAULT '[]'::jsonb,   -- lines the user deleted; never generated again
  lines       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ text, kind, pinned, evidence: [factId] }]
  evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- the SQL-computed facts a rebuild was given
  diff        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL CHECK (source IN ('rebuild','user')),
  provenance  JSONB,                                -- runPrompt provenance + dropped lines (rebuilds)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_hedwig_profile_latest ON hedwig_profile (user_id, version DESC);
