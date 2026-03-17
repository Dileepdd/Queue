import { randomUUID } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import { appConfig } from '../config/env.js';
import { resolveQueueName, validateJobEnvelope } from '../jobs/index.js';
import type { AnyJobEnvelope, EnqueueSource, ExecutionMode, JobName } from '../jobs/index.js';
import { AppError } from '../shared/errors.js';
import { upsertJobStatus, upsertJobStatusBatch } from '../status/index.js';
import { getOrCreateQueue } from './queue-registry.js';
import { assertTenantRateLimit } from './rate-limit.js';

const BULK_REDIS_BATCH_SIZE = 100;

export interface EnqueueInput {
  job: unknown;
  enqueueSource?: EnqueueSource | undefined;
  uniqueId?: string | undefined;
  executionMode?: ExecutionMode | undefined;
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

export interface BulkEnqueueResultItem {
  queue: string;
  jobId: string;
}

interface PreparedEnqueue {
  queueName: string;
  envelope: AnyJobEnvelope;
  jobOptions: JobsOptions;
  delayMs: number;
}

/* -------------------- HELPERS -------------------- */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getStringOrDefault(value: unknown, defaultValue: string): string {
  return typeof value === 'string' ? value : defaultValue;
}

function getValidEnum<T extends string>(value: unknown, allowed: T[], defaultValue: T): T {
  return allowed.includes(value as T) ? (value as T) : defaultValue;
}

/* -------------------- CORE UTILS -------------------- */

function toBullSafeJobId(input: string): string {
  return input.replaceAll(':', '__');
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

/* -------------------- NORMALIZATION (FIXED) -------------------- */

function normalizeJobEnvelope(
  input: unknown,
  tenantIdHint?: string,
  uniqueId?: string,
  executionMode?: ExecutionMode,
  enqueueSource?: EnqueueSource,
): AnyJobEnvelope {
  const jobObj = asObject(input);
  const metadata = asObject(jobObj.metadata ?? {});

  const tenantIdFromBody = isNonEmptyString(metadata.tenantId)
    ? metadata.tenantId.trim()
    : undefined;

  if (tenantIdHint && tenantIdFromBody && tenantIdHint !== tenantIdFromBody) {
    throw new AppError('Request tenantId does not match authenticated tenant', {
      code: 'AUTH_TENANT_MISMATCH',
      statusCode: 403,
    });
  }

  const tenantId = tenantIdHint ?? tenantIdFromBody ?? 'public';
  const jobName = getStringOrDefault(jobObj.name, 'webhook.dispatch');

  const partitionKey =
    (isNonEmptyString(metadata.partitionKey) && metadata.partitionKey.trim()) ||
    (isNonEmptyString(uniqueId) && uniqueId.trim()) ||
    tenantId;

  const idempotencyKey =
    isNonEmptyString(metadata.idempotencyKey) && metadata.idempotencyKey.length >= 8
      ? metadata.idempotencyKey
      : buildGeneratedIdempotencyKey({
          ...jobObj,
          name: jobName,
          metadata: { ...metadata, tenantId, partitionKey },
        });

  const correlationId =
    isNonEmptyString(metadata.correlationId) && metadata.correlationId.length >= 8
      ? metadata.correlationId
      : `corr-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  const requestedAt = isNonEmptyString(metadata.requestedAt)
    ? metadata.requestedAt
    : new Date().toISOString();

  const schemaVersion =
    typeof metadata.schemaVersion === 'number' ? metadata.schemaVersion : 1;

  const priority = getValidEnum(metadata.priority, ['high', 'default', 'low'], 'default');
  const workload = getValidEnum(metadata.workload, ['io-bound', 'cpu-heavy'], 'io-bound');

  const normalized = {
    ...jobObj,
    name: jobName,
    executionMode:
      jobObj.executionMode === 'parallel' || jobObj.executionMode === 'sequential'
        ? jobObj.executionMode
        : executionMode ?? 'parallel',
    metadata: {
      ...metadata,
      idempotencyKey,
      correlationId,
      requestedAt,
      tenantId,
      enqueueSource: getValidEnum(
        metadata.enqueueSource,
        ['individual', 'bulk'],
        enqueueSource ?? 'individual',
      ),
      schemaVersion,
      priority,
      workload,
      partitionKey,
    },
  };

  return validateJobEnvelope(normalized);
}

/* -------------------- LIMITS -------------------- */

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

/* -------------------- QUEUE CAPACITY -------------------- */

const QUEUE_DEPTH_CACHE_TTL_MS = 2000;
const queueDepthCache = new Map<string, { depth: number; cachedAt: number }>();

async function assertQueueCapacity(queueName: string) {
  const now = Date.now();
  const cached = queueDepthCache.get(queueName);

  if (cached && now - cached.cachedAt < QUEUE_DEPTH_CACHE_TTL_MS) {
    if (cached.depth >= appConfig.queueMaxDepth) {
      throw new AppError('Queue is overloaded, retry later', {
        code: 'QUEUE_OVERLOADED',
        statusCode: 503,
        retryable: true,
      });
    }
    return;
  }

  const queue = getOrCreateQueue(queueName);
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'waiting-children',
  );

  const depth =
    (counts.waiting ?? 0) +
    (counts.active ?? 0) +
    (counts.delayed ?? 0) +
    (counts.prioritized ?? 0) +
    (counts['waiting-children'] ?? 0);

  queueDepthCache.set(queueName, { depth, cachedAt: now });

  if (depth >= appConfig.queueMaxDepth) {
    throw new AppError('Queue is overloaded, retry later', {
      code: 'QUEUE_OVERLOADED',
      statusCode: 503,
      retryable: true,
    });
  }
}

/* -------------------- PREPARE -------------------- */

async function prepareEnqueue(input: EnqueueInput): Promise<PreparedEnqueue> {
  const normalizedJob = normalizeJobEnvelope(
    input.job,
    input.tenantIdHint,
    input.uniqueId,
    input.executionMode,
    input.enqueueSource,
  );

  const delayMs = input.delayMs ?? 0;
  ensureWithinLimits(normalizedJob, delayMs);

  const shouldApplyRateLimit = !input.skipAdmissionRateLimit;
  if (shouldApplyRateLimit) {
    assertTenantRateLimit(normalizedJob.metadata.tenantId);
  }

  const queueRouteInput = {
    priority: normalizedJob.metadata.priority,
    workload: normalizedJob.metadata.workload,
    ...(normalizedJob.metadata.partitionKey !== undefined && {
      partitionKey: normalizedJob.metadata.partitionKey,
    }),
    ...(input.shardCount !== undefined && { shardCount: input.shardCount }),
  };

  const queueName = resolveQueueName(queueRouteInput);
  await assertQueueCapacity(queueName);

  const rawJobId = `${normalizedJob.metadata.tenantId}:${normalizedJob.metadata.idempotencyKey}`;

  const jobOptions: JobsOptions = {
    jobId: toBullSafeJobId(rawJobId),
    ...(delayMs > 0 && { delay: delayMs }),
    ...(input.retryCount !== undefined && { attempts: input.retryCount + 1 }),
  };

  return {
    queueName,
    envelope: normalizedJob,
    jobOptions,
    delayMs,
  };
}

/* -------------------- ENQUEUE -------------------- */

export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  const prepared = await prepareEnqueue(input);
  const queue = getOrCreateQueue(prepared.queueName);

  const enqueued = await queue.add(
    prepared.envelope.name,
    prepared.envelope,
    prepared.jobOptions,
  );

  const resolvedJobId =
    enqueued.id ?? prepared.jobOptions.jobId ?? 'unknown';

  await upsertJobStatus({
    jobId: resolvedJobId,
    queue: prepared.queueName,
    jobName: prepared.envelope.name as JobName,
    status: 'queued',
    metadata: prepared.envelope.metadata,
    updatedAt: new Date().toISOString(),
  });

  return {
    queueName: prepared.queueName,
    jobId: resolvedJobId,
    delayed: prepared.delayMs > 0,
    delayMs: prepared.delayMs,
  };
}

/* -------------------- BULK -------------------- */

export async function enqueueJobsBulk(
  inputs: EnqueueInput[],
): Promise<BulkEnqueueResultItem[]> {
  const preparedWithIndex = await Promise.all(
    inputs.map(async (input, index) => ({
      index,
      prepared: await prepareEnqueue(input),
    })),
  );

  const grouped = new Map<
    string,
    Array<{ index: number; prepared: PreparedEnqueue }>
  >();

  for (const row of preparedWithIndex) {
    let list = grouped.get(row.prepared.queueName);
    if (!list) {
      list = [];
      grouped.set(row.prepared.queueName, list);
    }
    list.push(row);
  }

  const output: BulkEnqueueResultItem[] = new Array(inputs.length);

  for (const [queueName, rows] of grouped.entries()) {
    const queue = getOrCreateQueue(queueName);

    for (let offset = 0; offset < rows.length; offset += BULK_REDIS_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BULK_REDIS_BATCH_SIZE);

      const added = await queue.addBulk(
        batch.map(({ prepared }) => ({
          name: prepared.envelope.name,
          data: prepared.envelope,
          opts: prepared.jobOptions,
        })),
      );

      const statusRecords = batch.map(({ prepared }, idx) => {
        const resolvedJobId =
          added[idx]?.id ?? prepared.jobOptions.jobId ?? 'unknown';

        return {
          jobId: resolvedJobId,
          queue: prepared.queueName,
          jobName: prepared.envelope.name as JobName,
          status: 'queued' as const,
          metadata: prepared.envelope.metadata,
          updatedAt: new Date().toISOString(),
        };
      });

      await upsertJobStatusBatch(statusRecords);

      for (let idx = 0; idx < batch.length; idx++) {
        const entry = batch[idx]!;
        output[entry.index] = {
          queue: entry.prepared.queueName,
          jobId: statusRecords[idx]!.jobId,
        };
      }
    }
  }

  return output;
}