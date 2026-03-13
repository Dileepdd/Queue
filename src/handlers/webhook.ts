import { createHmac } from 'node:crypto';
import type { Processor } from 'bullmq';
import { appConfig } from '../config/env.js';
import type { AnyJobEnvelope, DispatchWebhookPayload } from '../jobs/types.js';
import { logger } from '../shared/logger.js';

const RESPONSE_BODY_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// SSRF protection — block private/internal IPs and non-http(s) schemes
// ---------------------------------------------------------------------------

const BLOCKED_IP_RANGES = [
  /^127\./,                         // loopback
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^169\.254\./,                    // link-local (AWS metadata)
  /^0\./,                           // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/,                          // IPv6 loopback
  /^fc00:/i,                        // IPv6 ULA
  /^fe80:/i,                        // IPv6 link-local
  /^fd/i,                           // IPv6 ULA
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

function assertSafeEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid webhook endpoint URL: ${endpoint}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook endpoint must use http or https, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Webhook endpoint hostname is blocked: ${hostname}`);
  }

  if (BLOCKED_IP_RANGES.some((re) => re.test(hostname))) {
    throw new Error(`Webhook endpoint resolves to a blocked IP range: ${hostname}`);
  }
}

// ---------------------------------------------------------------------------
// Request signing — HMAC-SHA256 signature in X-Webhook-Signature header
// ---------------------------------------------------------------------------

function signPayload(body: string, timestamp: number): string {
  const secret = appConfig.webhookSigningSecret;
  if (!secret) return '';

  const payload = `${timestamp}.${body}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Retryable vs non-retryable classification
// ---------------------------------------------------------------------------

function isRetryableStatusCode(statusCode: number): boolean {
  // 429 (rate limited) and 5xx are retryable
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  // 4xx (except 429) means the request itself is bad — retrying won't help
  return false;
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

async function dispatchWebhook(
  payload: DispatchWebhookPayload,
  attemptsMade: number,
): Promise<{ statusCode: number; body?: string }> {
  const { endpoint, method = 'POST', headers = {}, eventType, data } = payload;

  if (appConfig.webhookSsrfProtection) {
    assertSafeEndpoint(endpoint);
  }

  const jsonBody = JSON.stringify(data);
  const timestamp = Date.now();
  const signature = signPayload(jsonBody, timestamp);

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `${appConfig.serviceName}/1.0`,
    'X-Event-Type': eventType,
    'X-Delivery-Attempt': String(attemptsMade + 1),
    ...headers,
  };

  if (signature) {
    requestHeaders['X-Webhook-Signature'] = `sha256=${signature}`;
    requestHeaders['X-Webhook-Timestamp'] = String(timestamp);
  }

  const response = await fetch(endpoint, {
    method,
    headers: requestHeaders,
    body: jsonBody,
    redirect: 'error',
    signal: AbortSignal.timeout(appConfig.webhookTimeoutMs),
  });

  const rawBody = await response.text();
  const body = rawBody.length > RESPONSE_BODY_MAX_BYTES
    ? rawBody.slice(0, RESPONSE_BODY_MAX_BYTES) + '…[truncated]'
    : rawBody;

  return { statusCode: response.status, body };
}

// ---------------------------------------------------------------------------
// Non-retryable error — BullMQ will not retry when job.discard() is called
// ---------------------------------------------------------------------------

class NonRetryableWebhookError extends Error {
  constructor(statusCode: number, body?: string) {
    super(`Webhook endpoint returned non-retryable ${statusCode}: ${body ?? 'no body'}`);
    this.name = 'NonRetryableWebhookError';
  }
}

// ---------------------------------------------------------------------------
// Exported processor
// ---------------------------------------------------------------------------

export const webhookProcessor: Processor<AnyJobEnvelope, { statusCode: number }, string> = async (job) => {
  const envelope = job.data;
  const payload = envelope.payload as DispatchWebhookPayload;
  const attemptsMade = job.attemptsMade ?? 0;

  logger.info(
    {
      queue: job.queueName,
      jobId: job.id,
      jobName: job.name,
      endpoint: payload.endpoint,
      method: payload.method ?? 'POST',
      eventType: payload.eventType,
      attempt: attemptsMade + 1,
    },
    'dispatching webhook',
  );

  const result = await dispatchWebhook(payload, attemptsMade);

  if (result.statusCode >= 200 && result.statusCode < 300) {
    logger.info(
      { queue: job.queueName, jobId: job.id, statusCode: result.statusCode, attempt: attemptsMade + 1 },
      'webhook delivered',
    );
    return { statusCode: result.statusCode };
  }

  if (!isRetryableStatusCode(result.statusCode)) {
    logger.error(
      { queue: job.queueName, jobId: job.id, statusCode: result.statusCode, body: result.body, attempt: attemptsMade + 1 },
      'webhook endpoint returned non-retryable error',
    );
    await job.discard();
    throw new NonRetryableWebhookError(result.statusCode, result.body);
  }

  logger.warn(
    { queue: job.queueName, jobId: job.id, statusCode: result.statusCode, body: result.body, attempt: attemptsMade + 1 },
    'webhook endpoint returned retryable error',
  );
  throw new Error(`Webhook endpoint returned ${result.statusCode}: ${result.body ?? 'no body'}`);
};
