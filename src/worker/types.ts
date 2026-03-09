import type { Job, Processor } from 'bullmq';
import type { AnyJobEnvelope, JobName } from '../jobs/types.js';

export type WorkerMode = 'sequential' | 'parallel';

export type JobProcessor = Processor<AnyJobEnvelope, unknown, string>;

export interface WorkerFactoryOptions {
  queueName: string;
  processor: JobProcessor;
  mode?: WorkerMode;
  concurrency?: number;
  timeoutByJobName?: Partial<Record<JobName, number>>;
  rateLimiter?: {
    max: number;
    duration: number;
  };
}

export type QueueJob = Job<AnyJobEnvelope, unknown, string>;
