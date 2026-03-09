import express from 'express';
import { ZodError } from 'zod';
import { reprocessDeadLetter } from '../dead-letter/service.js';
import { closeDbPool } from '../infra/db.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { enqueueJob } from './enqueue-service.js';
import { closeAllQueues } from './queue-registry.js';
import { enqueueRequestSchema } from './schemas.js';

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
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'producer' });
  });

  app.post('/jobs', async (req, res, next) => {
    try {
      const parsed = enqueueRequestSchema.parse(req.body);
      const result = await enqueueJob({
        job: parsed.job,
        ...(parsed.delayMs !== undefined ? { delayMs: parsed.delayMs } : {}),
        ...(parsed.shardCount !== undefined ? { shardCount: parsed.shardCount } : {}),
      });

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

  app.post('/dead-letter/:id/reprocess', async (req, res, next) => {
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
