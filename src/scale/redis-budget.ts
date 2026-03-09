import { appConfig } from '../config/env.js';
import { logger } from '../shared/logger.js';

export type RedisRole = 'producer' | 'worker';

export function evaluateRedisConnectionBudget(role: RedisRole, estimatedConnections: number): void {
  const budget = role === 'producer' ? appConfig.redisConnectionBudgetProducer : appConfig.redisConnectionBudgetWorker;

  if (estimatedConnections > budget) {
    logger.warn({ role, estimatedConnections, budget }, 'redis connection budget exceeded');
    return;
  }

  logger.debug({ role, estimatedConnections, budget }, 'redis connection budget check');
}
