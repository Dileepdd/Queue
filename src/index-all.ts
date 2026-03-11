import { appConfig } from './config/env.js';
import { createProducerApp } from './producer/app.js';
import { logger } from './shared/logger.js';
import { getDefaultWorkerQueues, startWorkerRuntimes } from './worker/runtime.js';

const app = createProducerApp();

void startWorkerRuntimes(getDefaultWorkerQueues());

app.listen(appConfig.port, () => {
  logger.info({ port: appConfig.port, service: appConfig.serviceName }, 'producer+worker started');
});
