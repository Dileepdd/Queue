import { z } from 'zod';

export const enqueueRequestSchema = z.object({
  job: z.unknown(),
  delayMs: z.number().int().min(0).optional(),
  shardCount: z.number().int().min(1).max(1024).optional(),
});

export type EnqueueRequest = z.infer<typeof enqueueRequestSchema>;
