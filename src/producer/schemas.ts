import { z } from 'zod';

export const enqueueRequestSchema = z.object({
  job: z.unknown(),
  uniqueId: z.string().min(1).max(256).optional(),
  executionMode: z.enum(['parallel', 'sequential']).optional(),
  delayMs: z.number().int().min(0).optional(),
  retryCount: z.number().int().min(0).max(20).optional(),
  shardCount: z.number().int().min(1).max(1024).optional(),
});

export const bulkEnqueueRequestSchema = z.object({
  defaults: z
    .object({
      uniqueId: z.string().min(1).max(256).optional(),
      executionMode: z.enum(['parallel', 'sequential']).optional(),
      delayMs: z.number().int().min(0).optional(),
      retryCount: z.number().int().min(0).max(20).optional(),
      shardCount: z.number().int().min(1).max(1024).optional(),
    })
    .optional(),
  items: z.array(enqueueRequestSchema).min(1).max(10000),
});

export type EnqueueRequest = z.infer<typeof enqueueRequestSchema>;
export type BulkEnqueueRequest = z.infer<typeof bulkEnqueueRequestSchema>;
