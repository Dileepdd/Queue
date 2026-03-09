import { Queue } from 'bullmq';
import { baseQueueOptions } from '../config/queue.js';
import { evaluateRedisConnectionBudget } from '../scale/index.js';

const queueRegistry = new Map<string, Queue>();

export function getOrCreateQueue(queueName: string): Queue {
  const existing = queueRegistry.get(queueName);
  if (existing) {
    return existing;
  }

  const created = new Queue(queueName, baseQueueOptions);
  queueRegistry.set(queueName, created);
  evaluateRedisConnectionBudget('producer', queueRegistry.size);
  return created;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(queueRegistry.values()).map((queue) => queue.close()));
  queueRegistry.clear();
}
