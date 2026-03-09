import { appConfig } from '../config/env.js';
import { AppError } from '../shared/errors.js';

interface Bucket {
  windowStartedAt: number;
  count: number;
}

const tenantBuckets = new Map<string, Bucket>();

export function assertTenantRateLimit(tenantId: string): void {
  const now = Date.now();
  const duration = appConfig.queueRateLimitDurationMs;
  const max = appConfig.queueRateLimitMax;

  const current = tenantBuckets.get(tenantId);
  if (!current || now - current.windowStartedAt >= duration) {
    tenantBuckets.set(tenantId, { windowStartedAt: now, count: 1 });
    return;
  }

  if (current.count >= max) {
    throw new AppError('Rate limit exceeded for tenant', {
      code: 'TENANT_RATE_LIMITED',
      statusCode: 429,
      retryable: true,
    });
  }

  current.count += 1;
}
