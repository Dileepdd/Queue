-- Client API key registry for HMAC authentication
CREATE TABLE IF NOT EXISTS api_clients (
  key_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  secret_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_clients_tenant_status
  ON api_clients (tenant_id, status);

-- Replay protection store for request nonces.
CREATE TABLE IF NOT EXISTS api_request_nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_api_request_nonces_expires
  ON api_request_nonces (expires_at);
