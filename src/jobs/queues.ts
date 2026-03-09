export type QueuePriority = 'high' | 'default' | 'low';
export type QueueWorkload = 'io-bound' | 'cpu-heavy';

export interface QueueRouteInput {
  priority: QueuePriority;
  workload: QueueWorkload;
  partitionKey?: string;
  shardCount?: number;
}

const BASE_QUEUE_NAMES: Record<QueuePriority, Record<QueueWorkload, string>> = {
  high: {
    'io-bound': 'high-io',
    'cpu-heavy': 'high-cpu',
  },
  default: {
    'io-bound': 'default-io',
    'cpu-heavy': 'default-cpu',
  },
  low: {
    'io-bound': 'low-io',
    'cpu-heavy': 'low-cpu',
  },
};

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getBaseQueueName(priority: QueuePriority, workload: QueueWorkload): string {
  return BASE_QUEUE_NAMES[priority][workload];
}

export function getShardIndex(partitionKey: string, shardCount: number): number {
  if (shardCount <= 1) {
    return 0;
  }
  return hashString(partitionKey) % shardCount;
}

export function withShardSuffix(baseQueueName: string, shardIndex: number): string {
  return `${baseQueueName}:shard-${shardIndex}`;
}

export function resolveQueueName(input: QueueRouteInput): string {
  const base = getBaseQueueName(input.priority, input.workload);
  const shardCount = input.shardCount ?? 1;
  const partitionKey = input.partitionKey;

  if (shardCount <= 1 || !partitionKey) {
    return base;
  }

  const shard = getShardIndex(partitionKey, shardCount);
  return withShardSuffix(base, shard);
}
