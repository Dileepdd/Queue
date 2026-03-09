import type { QueuePriority, QueueWorkload } from './queues.js';

export type JobName = 'email.send' | 'report.generate' | 'webhook.dispatch';

export interface JobMetadata {
  idempotencyKey: string;
  correlationId: string;
  requestedAt: string;
  tenantId: string;
  schemaVersion: number;
  priority: QueuePriority;
  workload: QueueWorkload;
  partitionKey?: string | undefined;
}

export interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
}

export interface GenerateReportPayload {
  reportId: string;
  format: 'csv' | 'pdf';
}

export interface DispatchWebhookPayload {
  endpoint: string;
  eventType: string;
  data: Record<string, unknown>;
}

export interface JobPayloadMap {
  'email.send': SendEmailPayload;
  'report.generate': GenerateReportPayload;
  'webhook.dispatch': DispatchWebhookPayload;
}

export interface JobResultMap {
  'email.send': { accepted: boolean };
  'report.generate': { storageKey: string };
  'webhook.dispatch': { statusCode: number };
}

export type JobPayload<K extends JobName> = JobPayloadMap[K];
export type JobResult<K extends JobName> = JobResultMap[K];

export type AnyJobEnvelope = {
  [K in JobName]: {
    name: K;
    metadata: JobMetadata;
    payload: JobPayload<K>;
  };
}[JobName];
