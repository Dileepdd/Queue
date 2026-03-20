// Producer service constants

export const BULK_REDIS_BATCH_SIZE = 100;
export const QUEUE_DEPTH_CACHE_TTL_MS = 2000;

export const queueDepthCache = new Map<string, { depth: number; cachedAt: number }>();
