import type { Response } from 'express';
import { AppError } from '../shared/errors.js';

export type AuthContext = {
  tenantId: string;
  keyId: string;
  clientName: string;
};

export function setAuthContext(res: Response, context: AuthContext): void {
  res.locals.auth = context;
}

export function getAuthContext(res: Response): AuthContext | undefined {
  return res.locals.auth as AuthContext | undefined;
}

export function requireTenantId(res: Response): string {
  const tenantId = getAuthContext(res)?.tenantId;
  if (!tenantId) {
    throw new AppError('Missing authenticated tenant context', {
      code: 'AUTH_CONTEXT_MISSING',
      statusCode: 401,
    });
  }

  return tenantId;
}
