import { webhookProcessor } from './handlers/webhook.js';
import { getDefaultWorkerQueues, startWorkerRuntimes } from './worker/runtime.js';

void startWorkerRuntimes(getDefaultWorkerQueues(), webhookProcessor);
