import { Types } from 'mongoose';
import { Queue, Worker } from 'bullmq';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Tenant } from '../models/Tenant.js';
import { queueConnection, QUEUE_NAMES, withTenantJobContext } from './queues.js';
import { logger } from '../config/logger.js';

/**
 * Derives `Product.popularity` from what actually sold in the last 7 days.
 *
 * The field existed with an index but was NEVER written outside the demo seed,
 * so every real product sat at 0. That silently broke two things: Home's
 * "Popular this week" rail sorted 4,680 equal zeroes and therefore just showed
 * whichever products happened to come back first, and the category listing's
 * default `sort=popularity` was an equally meaningless no-op.
 */

/** Rolling window. Matches the "this week" the Home rail promises. */
const WINDOW_DAYS = 7;

export async function computePopularity(tenantId: Types.ObjectId): Promise<void> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Units sold, not revenue — a cheap item bought 50 times is more "popular"
  // than one expensive item, and the rail is a browsing shortcut, not a report.
  const counts = await Order.aggregate<{ _id: Types.ObjectId; units: number }>([
    { $match: { tenantId, placedAt: { $gte: since }, status: { $ne: 'cancelled' } } },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.productId',
        // fulfilledQty is what was actually packed; it defaults to null until
        // then, so fall back to the ordered quantity.
        units: { $sum: { $ifNull: ['$lines.fulfilledQty', '$lines.quantity'] } },
      },
    },
  ]);

  const sold = counts.filter((c) => c._id != null);

  /**
   * EVERY filter here carries tenantId explicitly. bulkWrite is not one of the
   * operations tenantScopePlugin hooks, so it is NOT auto-scoped — and the reset
   * below is an unbounded `$nin`, which without tenantId would zero out every
   * other shop's popularity on the platform.
   */
  const ops: Parameters<typeof Product.bulkWrite>[0] = sold.map((c) => ({
    updateOne: {
      filter: { _id: c._id, tenantId },
      update: { $set: { popularity: c.units } },
    },
  }));

  // Without this, a product that sold well a month ago stays "popular" forever.
  ops.push({
    updateMany: {
      filter: {
        tenantId,
        popularity: { $gt: 0 },
        _id: { $nin: sold.map((c) => c._id) },
      },
      update: { $set: { popularity: 0 } },
    },
  });

  const res = await Product.bulkWrite(ops, { ordered: false });
  logger.info(
    { tenantId: String(tenantId), productsWithSales: sold.length, modified: res.modifiedCount },
    'Popularity recomputed',
  );
}

export function startPopularityWorker(): void {
  new Worker(
    QUEUE_NAMES.popularity,
    withTenantJobContext<{ tenantId: string }>(async (data) => {
      await computePopularity(new Types.ObjectId(data.tenantId));
    }),
    { connection: queueConnection },
  ).on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Popularity job failed'));
}

/** Fires daily, fanning out one job per live tenant. */
export async function schedulePopularity(): Promise<void> {
  const trigger = new Queue('popularity-trigger', { connection: queueConnection });
  // 00:25, after the nightly rollup at 00:10 — they read the same orders and
  // there is no reason for them to contend.
  await trigger.upsertJobScheduler('daily', { pattern: '25 0 * * *' }, { name: 'fan-out' });

  new Worker(
    'popularity-trigger',
    async () => {
      const queue = new Queue(QUEUE_NAMES.popularity, { connection: queueConnection });
      const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } });
      for (const tenant of tenants) {
        await queue.add('compute', { tenantId: String(tenant._id) });
      }
    },
    { connection: queueConnection },
  );
}
