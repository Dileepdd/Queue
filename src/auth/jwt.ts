import jwt from 'jsonwebtoken';
import { appConfig } from '../config/env.js';

const JWT_SECRET = appConfig.jwtSecret || 'changeme';
const JWT_EXPIRES_IN = '1h';

export interface JwtPayload {
  userType: 'admin' | 'client';
  tenantId?: string;
  keyId?: string;
  clientName?: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
