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

const payloadSchemas: { [K in JobName]: z.ZodType<JobPayloadMap[K]> } = {
  'email.send': z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  'report.generate': z.object({
    reportId: z.string().min(1),
    format: z.enum(['csv', 'pdf']),
  }),
  'webhook.dispatch': z.object({
    endpoint: z.string().url(),
    eventType: z.string().min(1),
    data: z.record(z.unknown()),
  }),
};

const envelopeSchemaMap = {
  'email.send': z.object({ name: z.literal('email.send'), metadata: metadataSchema, payload: payloadSchemas['email.send'] }),
  'report.generate': z.object({ name: z.literal('report.generate'), metadata: metadataSchema, payload: payloadSchemas['report.generate'] }),
  'webhook.dispatch': z.object({ name: z.literal('webhook.dispatch'), metadata: metadataSchema, payload: payloadSchemas['webhook.dispatch'] }),
} as const;

export const anyJobEnvelopeSchema: z.ZodType<AnyJobEnvelope> = z.discriminatedUnion('name', [
  envelopeSchemaMap['email.send'],
  envelopeSchemaMap['report.generate'],
  envelopeSchemaMap['webhook.dispatch'],
]);

export function validateJobEnvelope(input: unknown): AnyJobEnvelope {
  return anyJobEnvelopeSchema.parse(input);
}

export function validateJobPayload<K extends JobName>(name: K, payload: unknown): JobPayload<K> {
  return payloadSchemas[name].parse(payload) as JobPayload<K>;
}

export { metadataSchema, payloadSchemas };
