import { Types } from 'mongoose';
import { Queue, Worker } from 'bullmq';
import { Order } from '../models/Order.js';
import { CreditAccount } from '../models/CreditAccount.js';
import { User } from '../models/User.js';
import { Tenant } from '../models/Tenant.js';
import { Product } from '../models/Product.js';
import { DailyRollup } from '../models/DailyRollup.js';
import { dateKeyInTimezone, startOfDayInTimezone } from '../lib/timezone.js';
import { queueConnection, QUEUE_NAMES, withTenantJobContext } from './queues.js';
import { logger } from '../config/logger.js';

/**
 * §18 ANALYTICS. A nightly job per tenant writes one dailyRollups document
 * for the previous day, bucketed in the TENANT's timezone (§20.3 — never
 * UTC, or a 4am Dubai order lands on the wrong day).
 */
export async function computeRollup(tenantId: Types.ObjectId, dateKey: string): Promise<void> {
  const tenant = await Tenant.findById(tenantId);
  const timezone = tenant?.locale!.timezone ?? 'Asia/Dubai';

  const start = startOfDayInTimezone(dateKey, timezone);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const orders = await Order.find({ tenantId, placedAt: { $gte: start, $lt: end } });

  const byStatus: Record<string, number> = {};
  const byFulfillment: Record<string, number> = {};
  let gross = 0;
  let discount = 0;
  let deliveryFees = 0;
  const productTotals = new Map<string, { units: number; revenue: number }>();

  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
    byFulfillment[order.fulfillment] = (byFulfillment[order.fulfillment] ?? 0) + 1;
    if (order.status !== 'cancelled') {
      gross += order.subtotal;
      discount += order.discount;
      deliveryFees += order.deliveryFee;
      for (const line of order.lines) {
        const key = String(line.productId);
        const entry = productTotals.get(key) ?? { units: 0, revenue: 0 };
        entry.units += line.fulfilledQty ?? line.quantity;
        entry.revenue += line.lineTotal;
        productTotals.set(key, entry);
      }
    }
  }

  const topProducts = Array.from(productTotals.entries())
    .map(([productId, v]) => ({ productId: new Types.ObjectId(productId), ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  const productIds = Array.from(productTotals.keys());
  const products = productIds.length
    ? await Product.find({ tenantId, _id: { $in: productIds } }, { categoryId: 1 })
    : [];
  const categoryRevenue = new Map<string, number>();
  for (const [productId, v] of productTotals) {
    const product = products.find((p) => String(p._id) === productId);
    const catKey = product?.categoryId ? String(product.categoryId) : 'uncategorised';
    categoryRevenue.set(catKey, (categoryRevenue.get(catKey) ?? 0) + v.revenue);
  }
  const totalCatRevenue = Array.from(categoryRevenue.values()).reduce((a, b) => a + b, 0) || 1;
  const topCategories = Array.from(categoryRevenue.entries())
    .filter(([catKey]) => catKey !== 'uncategorised')
    .map(([categoryId, revenue]) => ({
      categoryId: new Types.ObjectId(categoryId),
      revenue,
      share: Math.round((revenue / totalCatRevenue) * 100),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const newCustomers = await User.countDocuments({
    tenantId,
    role: 'customer',
    createdAt: { $gte: start, $lt: end },
  });

  const accounts = await CreditAccount.find({ tenantId, balance: { $gt: 0 } });
  const creditExposure = accounts.reduce((sum, a) => sum + a.balance, 0);

  await DailyRollup.findOneAndUpdate(
    { tenantId, date: dateKey },
    {
      tenantId,
      date: dateKey,
      orders: { count: orders.length, byStatus, byFulfillment },
      revenue: { gross, discount, deliveryFees, net: gross - discount + deliveryFees },
      topProducts,
      topCategories,
      newCustomers,
      creditExposure,
    },
    { upsert: true },
  );
}

export function startRollupWorker(): void {
  new Worker(
    QUEUE_NAMES.rollups,
    withTenantJobContext<{ tenantId: string; date: string }>(async (data) => {
      await computeRollup(new Types.ObjectId(data.tenantId), data.date);
    }),
    { connection: queueConnection },
  ).on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Rollup job failed'));
}

/** Fires once daily; fans out one job per active tenant for "yesterday" in that tenant's own timezone. */
export async function scheduleRollups(): Promise<void> {
  const trigger = new Queue('rollup-trigger', { connection: queueConnection });
  await trigger.upsertJobScheduler('nightly', { pattern: '10 0 * * *' }, { name: 'fan-out' });

  new Worker(
    'rollup-trigger',
    async () => {
      const rollupQueue = new Queue(QUEUE_NAMES.rollups, { connection: queueConnection });
      const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } });
      for (const tenant of tenants) {
        const timezone = tenant.locale!.timezone ?? 'Asia/Dubai';
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const dateKey = dateKeyInTimezone(yesterday, timezone);
        await rollupQueue.add('compute', { tenantId: String(tenant._id), date: dateKey });
      }
    },
    { connection: queueConnection },
  );
}
