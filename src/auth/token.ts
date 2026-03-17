import crypto from 'node:crypto';

export function hashAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
