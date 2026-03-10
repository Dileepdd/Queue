import type { QueuePriority, QueueWorkload } from './queues.js';

export type JobName = 'webhook.dispatch';
export type ExecutionMode = 'parallel' | 'sequential';
export type EnqueueSource = 'individual' | 'bulk';

export interface JobMetadata {
  idempotencyKey: string;
  correlationId: string;
  requestedAt: string;
  tenantId: string;
  enqueueSource?: EnqueueSource | undefined;
  schemaVersion: number;
  priority: QueuePriority;
  workload: QueueWorkload;
  partitionKey?: string | undefined;
}

export interface DispatchWebhookPayload {
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string> | undefined;
  eventType: string;
  data: Record<string, unknown>;
}

export interface JobPayloadMap {
  'webhook.dispatch': DispatchWebhookPayload;
}

export interface JobResultMap {
  'webhook.dispatch': { statusCode: number };
}

export type JobPayload<K extends JobName> = JobPayloadMap[K];
export type JobResult<K extends JobName> = JobResultMap[K];

export type AnyJobEnvelope = {
  [K in JobName]: {
    name: K;
    executionMode: ExecutionMode;
    metadata: JobMetadata;
    payload: JobPayload<K>;
  };
}[JobName];
