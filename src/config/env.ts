import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .transform((value) => {
      if (typeof value === 'boolean') {
        return value;
      }

      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
        return true;
      }

      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
        return false;
      }

      throw new Error(`Invalid boolean value: ${value}`);
    })
    .default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('queue-system'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().min(1).optional(),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  REDIS_USERNAME: z.string().min(1).optional(),
  REDIS_PASSWORD: z.string().min(1).optional(),
  REDIS_TLS: envBoolean(false),

  DATABASE_URL: z.string().min(1),
  DB_SSL: envBoolean(true),
  DB_SSL_REJECT_UNAUTHORIZED: envBoolean(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  QUEUE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  QUEUE_BACKOFF_MS: z.coerce.number().int().min(100).default(1000),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(10),
  QUEUE_LOCK_DURATION_MS: z.coerce.number().int().min(5000).default(60000),
  QUEUE_STALLED_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  QUEUE_MAX_STALLED_COUNT: z.coerce.number().int().min(0).max(10).default(1),

  QUEUE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  QUEUE_RATE_LIMIT_DURATION_MS: z.coerce.number().int().min(100).default(1000),
  JOB_TIMEOUT_DEFAULT_MS: z.coerce.number().int().min(1000).default(120000),

  QUEUE_MAX_DEPTH: z.coerce.number().int().min(1000).default(200000),
  QUEUE_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).default(262144),
  QUEUE_MAX_DELAYED_HORIZON_MS: z.coerce.number().int().min(1000).default(604800000),

  SCALE_SIGNAL_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  REDIS_CONNECTION_BUDGET_PRODUCER: z.coerce.number().int().min(1).default(100),
  REDIS_CONNECTION_BUDGET_WORKER: z.coerce.number().int().min(1).default(100),
  DB_IDEMPOTENCY_CLAIM_WARN_MS: z.coerce.number().int().min(1).default(150),

  RETENTION_ENABLED: envBoolean(true),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),
  RETENTION_IDEMPOTENCY_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_STATUS_EVENT_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_DEAD_LETTER_DAYS: z.coerce.number().int().min(1).default(90),

  AUTH_HMAC_REQUIRED: envBoolean(false),
  AUTH_BEARER_ENABLED: envBoolean(true),
  AUTH_CLOCK_SKEW_MS: z.coerce.number().int().min(1000).default(300000),
  AUTH_NONCE_TTL_MS: z.coerce.number().int().min(1000).default(300000),
  ADMIN_API_TOKEN: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${formatted}`);
}

const hasRedisUrl = Boolean(parsed.data.REDIS_URL);
const hasRedisHostPort = Boolean(parsed.data.REDIS_HOST && parsed.data.REDIS_PORT);

if (!hasRedisUrl && !hasRedisHostPort) {
  throw new Error('Invalid environment configuration: provide REDIS_URL or REDIS_HOST + REDIS_PORT');
}

const redisUrl = parsed.data.REDIS_URL ?? `redis://${parsed.data.REDIS_HOST}:${parsed.data.REDIS_PORT}`;

export const appConfig = Object.freeze({
  nodeEnv: parsed.data.NODE_ENV,
  serviceName: parsed.data.SERVICE_NAME,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  redisUrl,
  redisUsername: parsed.data.REDIS_USERNAME,
  redisPassword: parsed.data.REDIS_PASSWORD,
  redisTls: parsed.data.REDIS_TLS,
  databaseUrl: parsed.data.DATABASE_URL,
  dbSsl: parsed.data.DB_SSL,
  dbSslRejectUnauthorized: parsed.data.DB_SSL_REJECT_UNAUTHORIZED,
  dbPoolMax: parsed.data.DB_POOL_MAX,
  dbStatementTimeoutMs: parsed.data.DB_STATEMENT_TIMEOUT_MS,
  queueAttempts: parsed.data.QUEUE_ATTEMPTS,
  queueBackoffMs: parsed.data.QUEUE_BACKOFF_MS,
  queueConcurrency: parsed.data.QUEUE_CONCURRENCY,
  queueLockDurationMs: parsed.data.QUEUE_LOCK_DURATION_MS,
  queueStalledIntervalMs: parsed.data.QUEUE_STALLED_INTERVAL_MS,
  queueMaxStalledCount: parsed.data.QUEUE_MAX_STALLED_COUNT,
  queueRateLimitMax: parsed.data.QUEUE_RATE_LIMIT_MAX,
  queueRateLimitDurationMs: parsed.data.QUEUE_RATE_LIMIT_DURATION_MS,
  jobTimeoutDefaultMs: parsed.data.JOB_TIMEOUT_DEFAULT_MS,
  queueMaxDepth: parsed.data.QUEUE_MAX_DEPTH,
  queueMaxPayloadBytes: parsed.data.QUEUE_MAX_PAYLOAD_BYTES,
  queueMaxDelayedHorizonMs: parsed.data.QUEUE_MAX_DELAYED_HORIZON_MS,
  scaleSignalIntervalMs: parsed.data.SCALE_SIGNAL_INTERVAL_MS,
  redisConnectionBudgetProducer: parsed.data.REDIS_CONNECTION_BUDGET_PRODUCER,
  redisConnectionBudgetWorker: parsed.data.REDIS_CONNECTION_BUDGET_WORKER,
  dbIdempotencyClaimWarnMs: parsed.data.DB_IDEMPOTENCY_CLAIM_WARN_MS,
  retentionEnabled: parsed.data.RETENTION_ENABLED,
  retentionIntervalMs: parsed.data.RETENTION_INTERVAL_MS,
  retentionIdempotencyDays: parsed.data.RETENTION_IDEMPOTENCY_DAYS,
  retentionStatusEventDays: parsed.data.RETENTION_STATUS_EVENT_DAYS,
  retentionDeadLetterDays: parsed.data.RETENTION_DEAD_LETTER_DAYS,
  authHmacRequired: parsed.data.AUTH_HMAC_REQUIRED,
  authBearerEnabled: parsed.data.AUTH_BEARER_ENABLED,
  authClockSkewMs: parsed.data.AUTH_CLOCK_SKEW_MS,
  authNonceTtlMs: parsed.data.AUTH_NONCE_TTL_MS,
  adminApiToken: parsed.data.ADMIN_API_TOKEN,
});

export type AppConfig = typeof appConfig;
