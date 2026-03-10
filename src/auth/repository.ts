import { getDbPool } from '../infra/db.js';
import { hashAccessToken } from './token.js';

export type ApiClientRecord = {
  keyId: string;
  tenantId: string;
  clientName: string;
  secretValue: string;
  matchedByLegacyPlaintextToken?: boolean;
};

export async function findActiveApiClientByKeyId(keyId: string): Promise<ApiClientRecord | undefined> {
  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    secret_value: string;
  }>(
    `
      SELECT key_id, tenant_id, client_name, secret_value
      FROM api_clients
      WHERE key_id = $1
        AND status = 'active'
      LIMIT 1
    `,
    [keyId],
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    keyId: row.key_id,
    tenantId: row.tenant_id,
    clientName: row.client_name,
    secretValue: row.secret_value,
  };
}

export async function findActiveApiClientByToken(token: string): Promise<ApiClientRecord | undefined> {
  const tokenHash = hashAccessToken(token);
  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    secret_value: string;
    bearer_token_hash: string | null;
  }>(
    `
      SELECT key_id, tenant_id, client_name, secret_value, bearer_token_hash
      FROM api_clients
      WHERE (
          bearer_token_hash = $1
          OR secret_value = $2
        )
        AND status = 'active'
      ORDER BY
        CASE WHEN bearer_token_hash = $1 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `,
    [tokenHash, token],
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    keyId: row.key_id,
    tenantId: row.tenant_id,
    clientName: row.client_name,
    secretValue: row.secret_value,
    ...(row.bearer_token_hash ? {} : { matchedByLegacyPlaintextToken: true }),
  };
}

export async function setApiClientBearerTokenHash(keyId: string, token: string): Promise<void> {
  const tokenHash = hashAccessToken(token);
  await getDbPool().query(
    `
      UPDATE api_clients
      SET bearer_token_hash = $2,
          updated_at = NOW()
      WHERE key_id = $1
        AND bearer_token_hash IS NULL
    `,
    [keyId, tokenHash],
  );
}

export async function consumeRequestNonce(keyId: string, nonce: string, nonceTtlMs: number): Promise<boolean> {
  await getDbPool().query(
    `
      DELETE FROM api_request_nonces
      WHERE key_id = $1
        AND nonce = $2
        AND expires_at < NOW()
    `,
    [keyId, nonce],
  );

  const result = await getDbPool().query(
    `
      INSERT INTO api_request_nonces (key_id, nonce, expires_at)
      VALUES ($1, $2, NOW() + ($3::bigint * INTERVAL '1 millisecond'))
      ON CONFLICT (key_id, nonce) DO NOTHING
    `,
    [keyId, nonce, nonceTtlMs],
  );

  return result.rowCount === 1;
}

export async function touchApiClientUsage(keyId: string): Promise<void> {
  await getDbPool().query(
    `
      UPDATE api_clients
      SET last_used_at = NOW(), updated_at = NOW()
      WHERE key_id = $1
    `,
    [keyId],
  );
}
