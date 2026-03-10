import { getDbPool } from '../infra/db.js';

export type ApiKeyListRecord = {
  keyId: string;
  tenantId: string;
  clientName: string;
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export async function insertApiClient(input: {
  keyId: string;
  tenantId: string;
  clientName: string;
  secretValue: string;
  bearerTokenHash: string;
}): Promise<ApiKeyListRecord> {
  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    status: 'active' | 'revoked';
    created_at: Date;
    updated_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
  }>(
    `
      INSERT INTO api_clients (key_id, tenant_id, client_name, secret_value, bearer_token_hash, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
      RETURNING key_id, tenant_id, client_name, status, created_at, updated_at, revoked_at, last_used_at
    `,
    [input.keyId, input.tenantId, input.clientName, input.secretValue, input.bearerTokenHash],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create API client');
  }

  return mapListRecord(row);
}

export async function listApiClients(filter: { tenantId?: string; status?: 'active' | 'revoked' }): Promise<ApiKeyListRecord[]> {
  const params: Array<string> = [];
  const where: string[] = [];

  if (filter.tenantId) {
    params.push(filter.tenantId);
    where.push(`tenant_id = $${params.length}`);
  }

  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    status: 'active' | 'revoked';
    created_at: Date;
    updated_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
  }>(
    `
      SELECT key_id, tenant_id, client_name, status, created_at, updated_at, revoked_at, last_used_at
      FROM api_clients
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT 500
    `,
    params,
  );

  return result.rows.map(mapListRecord);
}

export async function rotateApiClientSecret(
  keyId: string,
  secretValue: string,
  bearerTokenHash: string,
): Promise<ApiKeyListRecord | undefined> {
  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    status: 'active' | 'revoked';
    created_at: Date;
    updated_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
  }>(
    `
      UPDATE api_clients
      SET secret_value = $2,
          bearer_token_hash = $3,
          updated_at = NOW(),
          revoked_at = NULL,
          status = 'active'
      WHERE key_id = $1
      RETURNING key_id, tenant_id, client_name, status, created_at, updated_at, revoked_at, last_used_at
    `,
    [keyId, secretValue, bearerTokenHash],
  );

  const row = result.rows[0];
  return row ? mapListRecord(row) : undefined;
}

export async function revokeApiClient(keyId: string): Promise<ApiKeyListRecord | undefined> {
  const result = await getDbPool().query<{
    key_id: string;
    tenant_id: string;
    client_name: string;
    status: 'active' | 'revoked';
    created_at: Date;
    updated_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
  }>(
    `
      UPDATE api_clients
      SET status = 'revoked',
          revoked_at = NOW(),
          updated_at = NOW()
      WHERE key_id = $1
      RETURNING key_id, tenant_id, client_name, status, created_at, updated_at, revoked_at, last_used_at
    `,
    [keyId],
  );

  const row = result.rows[0];
  return row ? mapListRecord(row) : undefined;
}

function mapListRecord(row: {
  key_id: string;
  tenant_id: string;
  client_name: string;
  status: 'active' | 'revoked';
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}): ApiKeyListRecord {
  return {
    keyId: row.key_id,
    tenantId: row.tenant_id,
    clientName: row.client_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}
