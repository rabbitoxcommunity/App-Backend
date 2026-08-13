import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { DailyRollup } from '../../models/DailyRollup.js';
import { SearchLog } from '../../models/SearchLog.js';
import { Tenant } from '../../models/Tenant.js';
import { User } from '../../models/User.js';
import { todayKey, startOfDayInTimezone } from '../../lib/timezone.js';

/** §18 — the ONLY live aggregation; everything historical reads dailyRollups. */
export async function today(tenantId: Types.ObjectId) {
  const tenant = await Tenant.findById(tenantId);
  const timezone = tenant?.locale!.timezone ?? 'Asia/Dubai';
  const dateKey = todayKey(timezone);
  const start = startOfDayInTimezone(dateKey, timezone);

  const orders = await Order.find({ tenantId, placedAt: { $gte: start } });
  const revenue = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.total, 0);

  const byStatus: Record<string, number> = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return { date: dateKey, orderCount: orders.length, revenue, byStatus };
}

export async function summary(tenantId: Types.ObjectId, from: string, to: string) {
  const rollups = await DailyRollup.find({ tenantId, date: { $gte: from, $lte: to } }).sort({ date: 1 });
  const totals = rollups.reduce(
    (acc, r) => ({
      orders: acc.orders + r.orders!.count!,
      gross: acc.gross + r.revenue!.gross!,
      net: acc.net + r.revenue!.net!,
      newCustomers: acc.newCustomers + r.newCustomers,
    }),
    { orders: 0, gross: 0, net: 0, newCustomers: 0 },
  );
  return { from, to, days: rollups, totals };
}

export async function topProducts(tenantId: Types.ObjectId, from: string, to: string) {
  const rollups = await DailyRollup.find({ tenantId, date: { $gte: from, $lte: to } });
  const merged = new Map<string, { units: number; revenue: number }>();
  for (const r of rollups) {
    for (const p of r.topProducts) {
      const key = String(p.productId);
      const entry = merged.get(key) ?? { units: 0, revenue: 0 };
      entry.units += p.units!;
      entry.revenue += p.revenue!;
      merged.set(key, entry);
    }
  }
  return Array.from(merged.entries())
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);
}

export async function categoryPerformance(tenantId: Types.ObjectId, from: string, to: string) {
  const rollups = await DailyRollup.find({ tenantId, date: { $gte: from, $lte: to } });
  const merged = new Map<string, number>();
  for (const r of rollups) {
    for (const c of r.topCategories) {
      const key = String(c.categoryId);
      merged.set(key, (merged.get(key) ?? 0) + c.revenue!);
    }
  }
  const total = Array.from(merged.values()).reduce((a, b) => a + b, 0) || 1;
  return Array.from(merged.entries())
    .map(([categoryId, revenue]) => ({ categoryId, revenue, share: Math.round((revenue / total) * 100) }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * §18 RFM top customers. Recency = days since last order, frequency =
 * orders in the trailing 90 days, monetary = net revenue in that window.
 * Scored 1-5 per axis on tenant-relative quintiles.
 */
export async function rfmCustomers(tenantId: Types.ObjectId) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const orders = await Order.find({ tenantId, placedAt: { $gte: since }, status: { $ne: 'cancelled' } });

  const byCustomer = new Map<string, { lastOrder: Date; count: number; revenue: number }>();
  for (const o of orders) {
    const key = String(o.customerId);
    const entry = byCustomer.get(key) ?? { lastOrder: o.placedAt, count: 0, revenue: 0 };
    if (o.placedAt > entry.lastOrder) entry.lastOrder = o.placedAt;
    entry.count += 1;
    entry.revenue += o.total;
    byCustomer.set(key, entry);
  }

  const rows = Array.from(byCustomer.entries()).map(([customerId, v]) => ({
    customerId,
    recencyDays: Math.floor((Date.now() - v.lastOrder.getTime()) / (24 * 60 * 60 * 1000)),
    frequency: v.count,
    monetary: v.revenue,
  }));

  const quintile = (values: number[], value: number, invert = false): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const rank = sorted.filter((v) => v <= value).length / sorted.length;
    const score = Math.max(1, Math.min(5, Math.ceil(rank * 5)));
    return invert ? 6 - score : score;
  };

  const recencies = rows.map((r) => r.recencyDays);
  const frequencies = rows.map((r) => r.frequency);
  const monetaries = rows.map((r) => r.monetary);

  const scored = rows
    .map((r) => ({
      ...r,
      rScore: quintile(recencies, r.recencyDays, true), // fewer days since = better = invert
      fScore: quintile(frequencies, r.frequency),
      mScore: quintile(monetaries, r.monetary),
    }))
    .sort((a, b) => b.mScore + b.fScore + b.rScore - (a.mScore + a.fScore + a.rScore))
    .slice(0, 50);

  // ADMIN GAP FILL — Insights' "top customers" cards need a name to show.
  const customers = await User.find({ _id: { $in: scored.map((r) => r.customerId) } }, { name: 1, phone: 1 });
  const byId = new Map(customers.map((c) => [String(c._id), { name: c.name, phone: c.phone }]));
  return scored.map((r) => ({ ...r, customer: byId.get(r.customerId) ?? null }));
}

/** §14 STAFF & REPORTING — zero-result queries are the cheapest catalogue-gap signal. */
export async function searchGaps(tenantId: Types.ObjectId, opts: { page: number; limit: number }) {
  const filter = { tenantId, resultCount: 0 };
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    SearchLog.find(filter).sort({ at: -1 }).skip(skip).limit(opts.limit),
    SearchLog.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}
