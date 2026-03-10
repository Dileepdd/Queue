import express from 'express';
import { ZodError, z } from 'zod';
import { requireAdminToken } from '../admin/middleware.js';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from '../admin/service.js';
import { createApiKeySchema, listApiKeysQuerySchema } from '../admin/schemas.js';
import { requireClientHmacAuth } from '../auth/middleware.js';
import { reprocessDeadLetter } from '../dead-letter/service.js';
import { closeDbPool } from '../infra/db.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { getJobStatusByJobId, getJobTimelineByJobId, listJobStatuses } from '../status/index.js';
import { enqueueJob, enqueueJobsBulk } from './enqueue-service.js';
import { closeAllQueues } from './queue-registry.js';
import { bulkEnqueueRequestSchema, enqueueRequestSchema } from './schemas.js';

const optionalQueryString = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, schema.optional());

const jobListQuerySchema = z.object({
  status: optionalQueryString(z.enum(['queued', 'active', 'completed', 'failed', 'dead-lettered', 'duplicate'])),
  jobName: optionalQueryString(z.enum(['webhook.dispatch'])),
  cursor: optionalQueryString(z.string().datetime()),
  limit: z
    .preprocess((value) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    }, z.coerce.number().int().min(1).max(200).optional())
    .default(50),
});

function getTenantIdFromAuth(res: express.Response): string {
  const auth = res.locals.auth as { tenantId?: string } | undefined;
  const tenantId = auth?.tenantId;
  if (!tenantId) {
    throw new AppError('Missing authenticated tenant context', {
      code: 'AUTH_CONTEXT_MISSING',
      statusCode: 401,
    });
  }
  return tenantId;
}

function mapInfrastructureError(error: unknown): AppError | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const maybeError = error as { message?: string; code?: string };
  const message = maybeError.message ?? '';
  const code = maybeError.code ?? '';

  // Supabase session pooler saturation and generic postgres connection pressure.
  if (
    message.includes('MaxClientsInSessionMode') ||
    code === '53300' ||
    message.includes('too many clients already')
  ) {
    return new AppError('Database is temporarily saturated, retry shortly', {
      code: 'DB_SATURATED',
      statusCode: 503,
      retryable: true,
    });
  }

  // Transient transport failures should be retried by callers.
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
    return new AppError('Database connection transient failure, retry shortly', {
      code: 'DB_TRANSIENT_ERROR',
      statusCode: 503,
      retryable: true,
    });
  }

  return undefined;
}

export function createProducerApp() {
  const app = express();
  const clientAuth = requireClientHmacAuth();
  const adminAuth = requireAdminToken();

  app.use(
    express.json({
      limit: '25mb',
      verify: (req, _res, buffer) => {
        // Preserve raw bytes for request signature verification.
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'producer' });
  });

  app.get('/admin/keys', adminAuth, async (req, res, next) => {
    try {
      const query = listApiKeysQuerySchema.parse(req.query);
      const rows = await listApiKeys(query);
      res.status(200).json({ items: rows });
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/keys', adminAuth, async (req, res, next) => {
    try {
      const payload = createApiKeySchema.parse(req.body);
      const created = await createApiKey(payload);
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/keys/:id/rotate', adminAuth, async (req, res, next) => {
    try {
      const keyId = req.params.id;
      if (!keyId || !keyId.trim()) {
        throw new AppError('Invalid API key id', {
          code: 'ADMIN_INVALID_KEY_ID',
          statusCode: 400,
        });
      }

      const rotated = await rotateApiKey(keyId.trim());
      res.status(200).json(rotated);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/keys/:id/revoke', adminAuth, async (req, res, next) => {
    try {
      const keyId = req.params.id;
      if (!keyId || !keyId.trim()) {
        throw new AppError('Invalid API key id', {
          code: 'ADMIN_INVALID_KEY_ID',
          statusCode: 400,
        });
      }

      const revoked = await revokeApiKey(keyId.trim());
      res.status(200).json(revoked);
    } catch (error) {
      next(error);
    }
  });

  app.post('/jobs', clientAuth, async (req, res, next) => {
    try {
      const authTenantId = (res.locals.auth as { tenantId?: string } | undefined)?.tenantId;
      const body = req.body as { uniqueId?: unknown; job?: { name?: unknown; metadata?: { correlationId?: unknown } } };
      logger.info(
        {
          route: '/jobs',
          tenantId: authTenantId,
          uniqueId: typeof body?.uniqueId === 'string' ? body.uniqueId : undefined,
          jobName: typeof body?.job?.name === 'string' ? body.job.name : undefined,
          correlationId:
            typeof body?.job?.metadata?.correlationId === 'string' ? body.job.metadata.correlationId : undefined,
        },
        'enqueue request received',
      );

      const parsed = enqueueRequestSchema.parse(req.body);
      const result = await enqueueJob({
        job: parsed.job,
        enqueueSource: 'individual',
        ...(parsed.uniqueId !== undefined ? { uniqueId: parsed.uniqueId } : {}),
        ...(parsed.executionMode !== undefined ? { executionMode: parsed.executionMode } : {}),
        ...(parsed.delayMs !== undefined ? { delayMs: parsed.delayMs } : {}),
        ...(parsed.retryCount !== undefined ? { retryCount: parsed.retryCount } : {}),
        ...(parsed.shardCount !== undefined ? { shardCount: parsed.shardCount } : {}),
        ...(authTenantId ? { tenantIdHint: authTenantId } : {}),
      });

      logger.info(
        {
          enqueueSource: 'individual',
          tenantId: authTenantId,
          queueName: result.queueName,
          jobId: result.jobId,
          delayed: result.delayed,
          delayMs: result.delayMs,
        },
        'job enqueued',
      );

      res.status(202).json({
        accepted: true,
        queueName: result.queueName,
        jobId: result.jobId,
        delayed: result.delayed,
        delayMs: result.delayMs,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/jobs/bulk', clientAuth, async (req, res, next) => {
    try {
      const authTenantId = (res.locals.auth as { tenantId?: string } | undefined)?.tenantId;
      const body = req.body as { items?: unknown[]; defaults?: { executionMode?: unknown } };
      logger.info(
        {
          route: '/jobs/bulk',
          tenantId: authTenantId,
          itemCount: Array.isArray(body?.items) ? body.items.length : undefined,
          defaultExecutionMode:
            body?.defaults?.executionMode === 'parallel' || body?.defaults?.executionMode === 'sequential'
              ? body.defaults.executionMode
              : undefined,
        },
        'bulk enqueue request received',
      );

      const parsed = bulkEnqueueRequestSchema.parse(req.body);

      const jobs = await enqueueJobsBulk(
        parsed.items.map((item) => ({
          job: item.job,
          enqueueSource: 'bulk',
          uniqueId: item.uniqueId ?? parsed.defaults?.uniqueId,
          executionMode: item.executionMode ?? parsed.defaults?.executionMode,
          delayMs: item.delayMs ?? parsed.defaults?.delayMs,
          retryCount: item.retryCount ?? parsed.defaults?.retryCount,
          shardCount: item.shardCount ?? parsed.defaults?.shardCount,
          ...(authTenantId ? { tenantIdHint: authTenantId } : {}),
          skipAdmissionRateLimit: true,
        })),
      );

      logger.info(
        {
          enqueueSource: 'bulk',
          tenantId: authTenantId,
          totalRequested: parsed.items.length,
          totalEnqueued: jobs.length,
        },
        'bulk jobs enqueued',
      );

      res.status(202).json({
        totalEnqueued: jobs.length,
        jobs,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId', clientAuth, async (req, res, next) => {
    try {
      const tenantId = getTenantIdFromAuth(res);
      const jobId = req.params.jobId?.trim();

      if (!jobId) {
        throw new AppError('Invalid job id', {
          code: 'INVALID_JOB_ID',
          statusCode: 400,
        });
      }

      const row = await getJobStatusByJobId(tenantId, jobId);
      if (!row) {
        throw new AppError('Job not found', {
          code: 'JOB_NOT_FOUND',
          statusCode: 404,
        });
      }

      res.status(200).json(row);
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId/events', clientAuth, async (req, res, next) => {
    try {
      const tenantId = getTenantIdFromAuth(res);
      const jobId = req.params.jobId?.trim();

      if (!jobId) {
        throw new AppError('Invalid job id', {
          code: 'INVALID_JOB_ID',
          statusCode: 400,
        });
      }

      const timeline = await getJobTimelineByJobId(tenantId, jobId);
      if (!timeline) {
        throw new AppError('Job not found', {
          code: 'JOB_NOT_FOUND',
          statusCode: 404,
        });
      }

      res.status(200).json(timeline);
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs', clientAuth, async (req, res, next) => {
    try {
      const tenantId = getTenantIdFromAuth(res);
      const parsed = jobListQuerySchema.parse(req.query);

      const result = await listJobStatuses({
        tenantId,
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.jobName ? { jobName: parsed.jobName } : {}),
        ...(parsed.cursor ? { updatedBefore: parsed.cursor } : {}),
        limit: parsed.limit,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/dead-letter/:id/reprocess', clientAuth, async (req, res, next) => {
    try {
      const deadLetterId = Number(req.params.id);
      if (!Number.isInteger(deadLetterId) || deadLetterId <= 0) {
        throw new AppError('Invalid dead-letter id', {
          code: 'INVALID_DLQ_ID',
          statusCode: 400,
        });
      }

      const result = await reprocessDeadLetter(deadLetterId);
      res.status(202).json({ accepted: true, queue: result.queue, jobId: result.newJobId });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const mappedInfraError = mapInfrastructureError(error);
    if (mappedInfraError) {
      res.setHeader('Retry-After', '5');
      return res.status(mappedInfraError.statusCode).json({
        code: mappedInfraError.code,
        message: mappedInfraError.message,
      });
    }

    if (error instanceof ZodError) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: error.issues,
      });
    }

    if (error instanceof AppError) {
      if (error.statusCode === 503 || error.statusCode === 429) {
        res.setHeader('Retry-After', '5');
      }

      return res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof Error) {
      logger.error({ message: error.message, stack: error.stack }, 'unhandled producer error');
    } else {
      logger.error({ error }, 'unhandled producer error');
    }
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'producer shutdown started');
    await closeAllQueues();
    await closeDbPool();
    logger.info({ signal }, 'producer shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  return app;
}
