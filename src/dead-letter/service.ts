import { getOrCreateQueue } from '../producer/queue-registry.js';
import { AppError } from '../shared/errors.js';
import { getDeadLetterById, markDeadLetterReprocessed } from './repository.js';

export async function reprocessDeadLetter(deadLetterId: number): Promise<{ queue: string; newJobId: string }> {
  const record = await getDeadLetterById(deadLetterId);
  if (!record) {
    throw new AppError('Dead-letter record not found', {
      code: 'DLQ_NOT_FOUND',
      statusCode: 404,
    });
  }

  const queue = getOrCreateQueue(record.queue);
  const reprocessed = await queue.add(record.jobName, {
    name: record.jobName,
    payload: record.payloadJson,
    metadata: record.metadataJson,
  });

  await markDeadLetterReprocessed(deadLetterId);

  return {
    queue: record.queue,
    newJobId: reprocessed.id ?? 'unknown',
  };
}
