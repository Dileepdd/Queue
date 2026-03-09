import type { ConnectionOptions } from 'bullmq';
import { appConfig } from './env.js';

export function createRedisConnectionOptions(clientName: string): ConnectionOptions {
  return {
    url: appConfig.redisUrl,
    username: appConfig.redisUsername,
    password: appConfig.redisPassword,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    retryStrategy(times: number) {
      return Math.min(1000 * Math.pow(2, times), 30000);
    },
    tls: appConfig.redisTls ? {} : undefined,
    connectionName: `${appConfig.serviceName}:${clientName}`,
  } as ConnectionOptions;
}
