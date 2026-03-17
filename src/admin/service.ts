import crypto from 'node:crypto';
import type { DatabaseError } from 'pg';
import { hashAccessToken } from '../auth/token.js';
import { AppError } from '../shared/errors.js';
import type { CreateApiKeyInput, ListApiKeysQuery } from './schemas.js';
import { insertApiClient, listApiClients, revokeApiClient, rotateApiClientSecret } from './repository.js';

function generateKeyId(): string {
  return `client_${crypto.randomBytes(8).toString('hex')}`;
}

function generateSecretValue(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createApiKey(input: CreateApiKeyInput): Promise<{
  keyId: string;
  tenantId: string;
  clientName: string;
  status: 'active' | 'revoked';
  createdAt: string;
  secretValue: string;
}> {
  const keyId = input.keyId ?? generateKeyId();
  const secretValue = generateSecretValue();
  const bearerTokenHash = hashAccessToken(secretValue);

  try {
    const created = await insertApiClient({
      keyId,
      tenantId: input.tenantId,
      clientName: input.clientName,
      secretValue,
      bearerTokenHash,
    });

    return {
      keyId: created.keyId,
      tenantId: created.tenantId,
      clientName: created.clientName,
      status: created.status,
      createdAt: created.createdAt,
      secretValue,
    };
  } catch (error) {
    const maybeDbError = error as Partial<DatabaseError>;
    if (maybeDbError.code === '23505') {
      throw new AppError('API key id already exists', {
        code: 'ADMIN_KEY_EXISTS',
        statusCode: 409,
      });
    }
    throw error;
  }
}

export async function listApiKeys(query: ListApiKeysQuery) {
  return listApiClients({
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.status ? { status: query.status } : {}),
  });
}

export async function rotateApiKey(keyId: string): Promise<{ keyId: string; secretValue: string; rotatedAt: string }> {
  const secretValue = generateSecretValue();
  const bearerTokenHash = hashAccessToken(secretValue);
  const updated = await rotateApiClientSecret(keyId, secretValue, bearerTokenHash);

  if (!updated) {
    throw new AppError('API key not found', {
      code: 'ADMIN_KEY_NOT_FOUND',
      statusCode: 404,
    });
  }

  return {
    keyId: updated.keyId,
    secretValue,
    rotatedAt: updated.updatedAt,
  };
}

export async function revokeApiKey(keyId: string): Promise<{ keyId: string; revoked: boolean; revokedAt: string }> {
  const updated = await revokeApiClient(keyId);

  if (!updated) {
    throw new AppError('API key not found', {
      code: 'ADMIN_KEY_NOT_FOUND',
      statusCode: 404,
    });
  }

  return {
    keyId: updated.keyId,
    revoked: true,
    revokedAt: updated.revokedAt ?? updated.updatedAt,
  };
}
