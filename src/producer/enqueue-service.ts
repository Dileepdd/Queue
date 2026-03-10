import { randomUUID } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import { appConfig } from '../config/env.js';
import { resolveQueueName, validateJobEnvelope } from '../jobs/index.js';
import type { AnyJobEnvelope, JobName } from '../jobs/index.js';
import { AppError } from '../shared/errors.js';
import { upsertJobStatus } from '../status/index.js';
import { getOrCreateQueue } from './queue-registry.js';
import { assertTenantRateLimit } from './rate-limit.js';

export interface EnqueueInput {
  job: unknown;
  uniqueId?: string | undefined;
  delayMs?: number | undefined;
  retryCount?: number | undefined;
  shardCount?: number | undefined;
  tenantIdHint?: string | undefined;
  skipAdmissionRateLimit?: boolean | undefined;
}

export interface EnqueueResult {
  queueName: string;
  jobId: string;
  delayed: boolean;
  delayMs: number;
}

function toBullSafeJobId(input: string): string {
  return input.replace(/:/g, '__');
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Job envelope must be an object', {
      code: 'INVALID_JOB_ENVELOPE',
      statusCode: 400,
    });
  }
  return input as Record<string, unknown>;
}

function buildGeneratedIdempotencyKey(jobObj: Record<string, unknown>): string {
  const name = typeof jobObj.name === 'string' ? jobObj.name : 'unknown-job';
  const metadata = asObject(jobObj.metadata ?? {});
  const tenantId = typeof metadata.tenantId === 'string' ? metadata.tenantId : 'unknown-tenant';
  const partitionKey = typeof metadata.partitionKey === 'string' ? metadata.partitionKey : 'global';
  return `${tenantId}:${name}:${partitionKey}:auto:${randomUUID()}`;
}

function normalizeJobEnvelope(input: unknown, tenantIdHint?: string, uniqueId?: string): AnyJobEnvelope {
  const jobObj = asObject(input);
  const metadata = asObject(jobObj.metadata ?? {});

  const tenantIdFromBody = typeof metadata.tenantId === 'string' && metadata.tenantId.trim().length > 0 ? metadata.tenantId.trim() : undefined;
  if (tenantIdHint && tenantIdFromBody && tenantIdHint !== tenantIdFromBody) {
    throw new AppError('Request tenantId does not match authenticated tenant', {
      code: 'AUTH_TENANT_MISMATCH',
      statusCode: 403,
    });
  }

  const tenantId = tenantIdHint ?? tenantIdFromBody ?? 'public';
  const jobName = typeof jobObj.name === 'string' ? jobObj.name : 'webhook.dispatch';
  const partitionKeyFromMetadata = typeof metadata.partitionKey === 'string' && metadata.partitionKey.trim().length > 0 ? metadata.partitionKey.trim() : undefined;
  const partitionKeyFromUnique = typeof uniqueId === 'string' && uniqueId.trim().length > 0 ? uniqueId.trim() : undefined;
  const partitionKey = partitionKeyFromMetadata ?? partitionKeyFromUnique ?? tenantId;

  const idempotencyKey =
    typeof metadata.idempotencyKey === 'string' && metadata.idempotencyKey.length >= 8
      ? metadata.idempotencyKey
      : buildGeneratedIdempotencyKey({
          ...jobObj,
          name: jobName,
          metadata: {
            ...metadata,
            tenantId,
            partitionKey,
          },
        });

  const correlationId =
    typeof metadata.correlationId === 'string' && metadata.correlationId.length >= 8
      ? metadata.correlationId
      : `corr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const requestedAt =
    typeof metadata.requestedAt === 'string' && metadata.requestedAt.trim().length > 0 ? metadata.requestedAt : new Date().toISOString();

  const schemaVersion = typeof metadata.schemaVersion === 'number' ? metadata.schemaVersion : 1;
  const priority = metadata.priority === 'high' || metadata.priority === 'default' || metadata.priority === 'low' ? metadata.priority : 'default';
  const workload = metadata.workload === 'io-bound' || metadata.workload === 'cpu-heavy' ? metadata.workload : 'io-bound';

  const normalized = {
    ...jobObj,
    name: jobName,
    metadata: {
      ...metadata,
      idempotencyKey,
      correlationId,
      requestedAt,
      tenantId,
      schemaVersion,
      priority,
      workload,
      partitionKey,
    },
  };

  return validateJobEnvelope(normalized);
}

function getPayloadSizeBytes(input: unknown): number {
  return Buffer.byteLength(JSON.stringify(input), 'utf8');
}

function ensureWithinLimits(job: AnyJobEnvelope, delayMs: number) {
  if (delayMs > appConfig.queueMaxDelayedHorizonMs) {
    throw new AppError('Delay exceeds configured max horizon', {
      code: 'DELAY_HORIZON_EXCEEDED',
      statusCode: 400,
    });
  }

  const payloadBytes = getPayloadSizeBytes(job.payload);
  if (payloadBytes > appConfig.queueMaxPayloadBytes) {
    throw new AppError('Payload exceeds configured max size', {
      code: 'PAYLOAD_TOO_LARGE',
      statusCode: 413,
    });
  }
}

async function assertQueueCapacity(queueName: string) {
  const queue = getOrCreateQueue(queueName);
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
  const depth =
    (counts.waiting ?? 0) +
    (counts.active ?? 0) +
    (counts.delayed ?? 0) +
    (counts.prioritized ?? 0) +
    (counts['waiting-children'] ?? 0);

  if (depth >= appConfig.queueMaxDepth) {
    throw new AppError('Queue is overloaded, retry later', {
      code: 'QUEUE_OVERLOADED',
      statusCode: 503,
      retryable: true,
    });
  }
}

export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  const normalizedJob = normalizeJobEnvelope(input.job, input.tenantIdHint, input.uniqueId);
  const delayMs = input.delayMs ?? 0;
  ensureWithinLimits(normalizedJob, delayMs);

  if (!input.skipAdmissionRateLimit) {
    assertTenantRateLimit(normalizedJob.metadata.tenantId);
  }

  const queueRouteInput = {
    priority: normalizedJob.metadata.priority,
    workload: normalizedJob.metadata.workload,
    ...(normalizedJob.metadata.partitionKey !== undefined ? { partitionKey: normalizedJob.metadata.partitionKey } : {}),
    ...(input.shardCount !== undefined ? { shardCount: input.shardCount } : {}),
  };

  const queueName = resolveQueueName(queueRouteInput);

  await assertQueueCapacity(queueName);

  const queue = getOrCreateQueue(queueName);
  const rawJobId = `${normalizedJob.metadata.tenantId}:${normalizedJob.metadata.idempotencyKey}`;
  const jobOptions: JobsOptions = {
    jobId: toBullSafeJobId(rawJobId),
    ...(delayMs > 0 ? { delay: delayMs } : {}),
    ...(input.retryCount !== undefined ? { attempts: input.retryCount + 1 } : {}),
  };

  const enqueued = await queue.add(normalizedJob.name, normalizedJob, jobOptions);
  const resolvedJobId = enqueued.id ?? jobOptions.jobId ?? 'unknown';

  await upsertJobStatus({
    jobId: resolvedJobId,
    queue: queueName,
    jobName: normalizedJob.name as JobName,
    status: 'queued',
    metadata: normalizedJob.metadata,
    updatedAt: new Date().toISOString(),
  });

  return {
    queueName,
    jobId: resolvedJobId,
    delayed: delayMs > 0,
    delayMs,
  };
}
