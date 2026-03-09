import { appConfig } from '../config/env.js';
import { logger } from '../shared/logger.js';

interface RetryWindowState {
  startedAt: number;
  failures: number;
}

const RETRY_WINDOW_MS = 60_000;
const RETRY_THRESHOLD = Math.max(50, appConfig.queueRateLimitMax * 2);
const retryWindows = new Map<string, RetryWindowState>();

export function recordFailureAndCheckStorm(queueName: string): void {
  const now = Date.now();
  const existing = retryWindows.get(queueName);

  if (!existing || now - existing.startedAt >= RETRY_WINDOW_MS) {
    retryWindows.set(queueName, { startedAt: now, failures: 1 });
    return;
  }

  existing.failures += 1;
  if (existing.failures >= RETRY_THRESHOLD) {
    logger.warn(
      { queue: queueName, failures: existing.failures, windowMs: RETRY_WINDOW_MS },
      'retry storm safeguard threshold reached',
    );
  }
}
