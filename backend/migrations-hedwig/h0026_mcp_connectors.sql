-- Connectors (2026-10-13): Hedwig as a remote MCP server that Claude, ChatGPT and other MCP clients
-- connect to with OAuth 2.1 (backend/src/hedwig/mcp/). Clients register themselves (RFC 7591); a
-- person approves one on Hedwig's /connect page, which makes a grant; the grant's tokens are
-- stored only as SHA-256 hashes. Disconnecting revokes the grant and deletes its tokens.

CREATE TABLE IF NOT EXISTS hedwig_mcp_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret_hash         TEXT,                 -- NULL for public clients (PKCE only)
  client_name                TEXT NOT NULL,
  client_uri                 TEXT,
  redirect_uris              TEXT[] NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An authorization request on its way through /connect: created by /mcp/oauth/authorize, given a
-- user and a one-time code when the person allows it, deleted when the code is exchanged.
CREATE TABLE IF NOT EXISTS hedwig_mcp_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        TEXT NOT NULL REFERENCES hedwig_mcp_clients(client_id) ON DELETE CASCADE,
  redirect_uri     TEXT NOT NULL,
  state            TEXT,
  code_challenge   TEXT NOT NULL,
  scopes           TEXT[] NOT NULL,
  resource         TEXT,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  code_hash        TEXT UNIQUE,
  code_expires_at  TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_mcp_requests_expires ON hedwig_mcp_requests (expires_at);

-- One connection: a person allowed a client. Settings → Connectors lists these.
CREATE TABLE IF NOT EXISTS hedwig_mcp_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES hedwig_mcp_clients(client_id) ON DELETE CASCADE,
  scopes        TEXT[] NOT NULL,
  resource      TEXT,
  calls         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hedwig_mcp_grants_user ON hedwig_mcp_grants (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hedwig_mcp_tokens (
  token_hash  TEXT PRIMARY KEY,
  grant_id    UUID NOT NULL REFERENCES hedwig_mcp_grants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_mcp_tokens_grant ON hedwig_mcp_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_hedwig_mcp_tokens_expires ON hedwig_mcp_tokens (expires_at);

-- What a connected app changed (tools that change mail or Hedwig's lists), for Settings → Connectors.
CREATE TABLE IF NOT EXISTS hedwig_mcp_activity (
  id          BIGSERIAL PRIMARY KEY,
  grant_id    UUID NOT NULL REFERENCES hedwig_mcp_grants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  summary     TEXT,
  ok          BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_mcp_activity_user ON hedwig_mcp_activity (user_id, created_at DESC);
