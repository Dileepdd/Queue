import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { appConfig } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { buildCanonicalRequest, parseTimestampMs, sha256Hex, signCanonicalRequest, timingSafeEqualHex } from './hmac.js';
import {
  consumeRequestNonce,
  findActiveApiClientByKeyId,
  findActiveApiClientByToken,
  setApiClientBearerTokenHash,
  touchApiClientUsage,
} from './repository.js';

type RawBodyRequest = Request & { rawBody?: Buffer };

function getRequiredHeader(req: Request, headerName: string): string {
  const value = req.header(headerName);
  if (!value || !value.trim()) {
    throw new AppError(`Missing required header: ${headerName}`, {
      code: 'AUTH_MISSING_HEADERS',
      statusCode: 401,
    });
  }
  return value.trim();
}

function validateTimestamp(timestampMs: number): void {
  const now = Date.now();
  const skew = Math.abs(now - timestampMs);

  if (skew > appConfig.authClockSkewMs) {
    throw new AppError('Request timestamp is outside allowed clock skew window', {
      code: 'AUTH_TIMESTAMP_SKEW',
      statusCode: 401,
    });
  }
}

function getBearerToken(req: Request): string | undefined {
  const value = req.header('Authorization');
  if (!value) {
    return undefined;
  }

  const [scheme, token] = value.trim().split(/\s+/, 2);
  if (!scheme || !token) {
    return undefined;
  }

  if (scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

export function requireClientHmacAuth(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearerToken = getBearerToken(req);
      if (appConfig.authBearerEnabled && bearerToken) {
        const apiClient = await findActiveApiClientByToken(bearerToken);
        if (!apiClient) {
          throw new AppError('Invalid access token', {
            code: 'AUTH_INVALID_TOKEN',
            statusCode: 401,
          });
        }

        res.locals.auth = {
          tenantId: apiClient.tenantId,
          keyId: apiClient.keyId,
          clientName: apiClient.clientName,
        };

        if (apiClient.matchedByLegacyPlaintextToken) {
          await setApiClientBearerTokenHash(apiClient.keyId, bearerToken);
        }

        await touchApiClientUsage(apiClient.keyId);
        return next();
      }

      // If HMAC is not required, bearer is the only accepted client auth mode.
      if (!appConfig.authHmacRequired) {
        if (appConfig.authBearerEnabled) {
          throw new AppError('Missing bearer token', {
            code: 'AUTH_MISSING_TOKEN',
            statusCode: 401,
          });
        }

        return next();
      }

      const keyId = getRequiredHeader(req, 'X-Access-Key-Id');
      const timestampRaw = getRequiredHeader(req, 'X-Timestamp');
      const nonce = getRequiredHeader(req, 'X-Nonce');
      const providedSignature = getRequiredHeader(req, 'X-Signature').toLowerCase();

      const parsedTimestampMs = parseTimestampMs(timestampRaw);
      if (!parsedTimestampMs) {
        throw new AppError('Invalid timestamp format', {
          code: 'AUTH_INVALID_TIMESTAMP',
          statusCode: 401,
        });
      }
      validateTimestamp(parsedTimestampMs);

      const apiClient = await findActiveApiClientByKeyId(keyId);
      if (!apiClient) {
        throw new AppError('Invalid API key', {
          code: 'AUTH_INVALID_KEY',
          statusCode: 401,
        });
      }

      const nonceAccepted = await consumeRequestNonce(apiClient.keyId, nonce, appConfig.authNonceTtlMs);
      if (!nonceAccepted) {
        throw new AppError('Nonce already used', {
          code: 'AUTH_NONCE_REPLAY',
          statusCode: 401,
        });
      }

      const rawBody = (req as RawBodyRequest).rawBody;
      const bodyHash = sha256Hex(rawBody ?? Buffer.alloc(0));
      const canonical = buildCanonicalRequest({
        method: req.method,
        pathWithQuery: req.originalUrl,
        timestampMs: String(parsedTimestampMs),
        nonce,
        bodyHash,
      });

      const expectedSignature = signCanonicalRequest(apiClient.secretValue, canonical);
      if (!timingSafeEqualHex(providedSignature, expectedSignature)) {
        throw new AppError('Invalid request signature', {
          code: 'AUTH_INVALID_SIGNATURE',
          statusCode: 401,
        });
      }

      res.locals.auth = {
        tenantId: apiClient.tenantId,
        keyId: apiClient.keyId,
        clientName: apiClient.clientName,
      };

      await touchApiClientUsage(apiClient.keyId);
      return next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }

      logger.error({ error }, 'unexpected auth middleware failure');
      return next(
        new AppError('Authentication failed', {
          code: 'AUTH_INTERNAL_ERROR',
          statusCode: 500,
        }),
      );
    }
  };
}
