import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { appConfig } from '../config/env.js';
import { AppError } from '../shared/errors.js';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireAdminToken(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!appConfig.adminApiToken) {
      return next(
        new AppError('Invalid admin token', {
          code: 'ADMIN_AUTH_INVALID_TOKEN',
          statusCode: 401,
        }),
      );
    }

    const token = req.header('X-Admin-Token')?.trim();

    if (!token) {
      return next(
        new AppError('Missing required header: X-Admin-Token', {
          code: 'ADMIN_AUTH_MISSING_TOKEN',
          statusCode: 401,
        }),
      );
    }

    if (!safeEqual(token, appConfig.adminApiToken)) {
      return next(
        new AppError('Invalid admin token', {
          code: 'ADMIN_AUTH_INVALID_TOKEN',
          statusCode: 401,
        }),
      );
    }

    return next();
  };
}