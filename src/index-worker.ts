import { getDefaultWorkerQueues, startWorkerRuntimes } from './worker/runtime.js';

void startWorkerRuntimes(getDefaultWorkerQueues());
