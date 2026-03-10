import { z } from 'zod';

export const createApiKeySchema = z.object({
  tenantId: z.string().min(1),
  clientName: z.string().min(1),
  keyId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
});

export const listApiKeysQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  status: z.enum(['active', 'revoked']).optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;
