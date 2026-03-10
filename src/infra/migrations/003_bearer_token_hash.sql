-- Add hashed bearer token storage for API client auth.
ALTER TABLE api_clients
  ADD COLUMN IF NOT EXISTS bearer_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_api_clients_bearer_token_hash_status
  ON api_clients (bearer_token_hash, status);
