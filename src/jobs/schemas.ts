import { z } from 'zod';
import type { AnyJobEnvelope, JobMetadata, JobName, JobPayload, JobPayloadMap } from './types.js';

const metadataSchema = z.object({
  idempotencyKey: z.string().min(8),
  correlationId: z.string().min(8),
  requestedAt: z.string().datetime(),
  tenantId: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  priority: z.enum(['high', 'default', 'low']),
  workload: z.enum(['io-bound', 'cpu-heavy']),
  partitionKey: z.string().min(1).optional(),
});

const payloadSchemas = {
  'webhook.dispatch': z.object({
    endpoint: z.string().url(),
    method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
    headers: z.record(z.string()).optional(),
    eventType: z.string().min(1),
    data: z.record(z.unknown()),
  }),
} satisfies { [K in JobName]: z.ZodType<JobPayloadMap[K], z.ZodTypeDef, unknown> };

const envelopeSchemaMap = {
  'webhook.dispatch': z.object({ name: z.literal('webhook.dispatch'), metadata: metadataSchema, payload: payloadSchemas['webhook.dispatch'] }),
} as const;

export const anyJobEnvelopeSchema: z.ZodType<AnyJobEnvelope, z.ZodTypeDef, unknown> = envelopeSchemaMap['webhook.dispatch'];

export function validateJobEnvelope(input: unknown): AnyJobEnvelope {
  return anyJobEnvelopeSchema.parse(input);
}

export function validateJobPayload<K extends JobName>(name: K, payload: unknown): JobPayload<K> {
  return payloadSchemas[name].parse(payload) as JobPayload<K>;
}

export { metadataSchema, payloadSchemas };
