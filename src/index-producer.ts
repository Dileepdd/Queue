import { createProducerApp } from './producer/app.js';
import { appConfig } from './config/env.js';
import { logger } from './shared/logger.js';

const app = createProducerApp();

app.listen(appConfig.port, () => {
  logger.info({ port: appConfig.port, service: appConfig.serviceName }, 'producer started');
});
