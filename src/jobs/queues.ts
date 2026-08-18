import { Queue, Worker, type Processor } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { runWithContext } from '../context/requestContext.js';
import { Types } from 'mongoose';

/**
 * §2/§17/§9.5/§18/§19.3 — BullMQ backs Excel import commits, rider offer
 * timeouts, nightly analytics rollups and monthly invoice generation.
 * One Node process runs both the API and these workers in v1; split them
 * into a dedicated worker process before traffic makes that necessary.
 */

// BullMQ requires its own connection with maxRetriesPerRequest: null.
export const queueConnection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = {
  import: 'import-commit',
  riderTimeout: 'rider-offer-timeout',
  rollups: 'daily-rollups',
  invoices: 'monthly-invoices',
  popularity: 'popularity-recompute',
} as const;

export const importQueue = new Queue(QUEUE_NAMES.import, { connection: queueConnection });
export const riderTimeoutQueue = new Queue(QUEUE_NAMES.riderTimeout, { connection: queueConnection });
export const rollupQueue = new Queue(QUEUE_NAMES.rollups, { connection: queueConnection });
export const invoiceQueue = new Queue(QUEUE_NAMES.invoices, { connection: queueConnection });

/**
 * Every job body carries tenantId explicitly (jobs run with no HTTP request,
 * so there is no tenantContext middleware to populate AsyncLocalStorage).
 * Wrap processors with this so tenant-scoped model calls work unchanged.
 */
export function withTenantJobContext<T extends { tenantId: string }>(
  handler: (data: T) => Promise<void>,
): Processor<T> {
  return async (job) => {
    await runWithContext(
      {
        tenantId: new Types.ObjectId(job.data.tenantId),
        userId: null,
        role: 'superAdmin',
        grade: null,
        requestId: `job:${job.id}`,
        impersonatedBy: null,
      },
      () => handler(job.data),
    );
  };
}

const workers: Worker[] = [];

export function registerWorker<T extends { tenantId: string }>(
  queueName: string,
  handler: (data: T) => Promise<void>,
): void {
  const worker = new Worker(queueName, withTenantJobContext(handler), { connection: queueConnection });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, err }, 'Job failed');
  });
  workers.push(worker);
}

export async function closeWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}
