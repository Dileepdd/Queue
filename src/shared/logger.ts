import pino from 'pino';
import { appConfig } from '../config/env.js';

export const logger = pino({
  name: appConfig.serviceName,
  level: appConfig.logLevel,
  base: {
    service: appConfig.serviceName,
    env: appConfig.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
