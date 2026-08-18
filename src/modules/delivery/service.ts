import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { User } from '../../models/User.js';
import { Tenant } from '../../models/Tenant.js';
import { AppError } from '../../lib/errors.js';
import { todayKey, startOfDayInTimezone } from '../../lib/timezone.js';
import { withCustomerInfo } from '../orders/service.js';

/** §20.3 — a rider's "today" is the shop's day, not UTC's. */
async function startOfShopToday(tenantId: Types.ObjectId): Promise<Date> {
  const tenant = await Tenant.findById(tenantId);
  const timezone = tenant?.locale!.timezone ?? 'Asia/Dubai';
  return startOfDayInTimezone(todayKey(timezone), timezone);
}

/**
 * The rider app's home screen in one round trip: what is still in hand, what
 * has already been dropped today, and the "3 of 7" counter across both.
 *
 * `fulfillment: 'delivery'` is explicit rather than implied. Riders are only
 * ever assigned delivery orders today (assignRider bails on curbside), but
 * curbside is handed over by counter staff in the Admin dashboard and must
 * never surface here — so the filter states the rule instead of relying on
 * the assignment path continuing to enforce it.
 */
export async function myOrders(tenantId: Types.ObjectId, riderId: Types.ObjectId) {
  const dayStart = await startOfShopToday(tenantId);

  const [available, active, completed] = await Promise.all([
    // THE OPEN POOL — every delivery order nobody has taken yet. There is no
    // allocation any more: these are visible to every rider on the tenant at
    // once, and the first to claim one gets it.
    Order.find({
      tenantId,
      fulfillment: 'delivery',
      'rider.userId': null,
      status: { $nin: ['delivered', 'handed_over', 'cancelled'] },
    }).sort({ placedAt: 1 }),
    Order.find({
      tenantId,
      fulfillment: 'delivery',
      'rider.userId': riderId,
      status: { $nin: ['delivered', 'cancelled'] },
    }).sort({ placedAt: 1 }),
    // Completed orders are matched on the `delivered` event's timestamp, not
    // placedAt: an order placed at 11pm and delivered at 12:20am belongs to
    // the shift that dropped it, which is the one being reconciled.
    Order.find({
      tenantId,
      fulfillment: 'delivery',
      'rider.userId': riderId,
      status: 'delivered',
      events: { $elemMatch: { status: 'delivered', at: { $gte: dayStart } } },
    }).sort({ 'events.at': -1 }),
  ]);

  const [openPool, toDeliver, completedToday] = await Promise.all([
    withCustomerInfo(available.map((o) => o.toJSON() as unknown as { customerId: Types.ObjectId })),
    withCustomerInfo(active.map((o) => o.toJSON() as unknown as { customerId: Types.ObjectId })),
    withCustomerInfo(completed.map((o) => o.toJSON() as unknown as { customerId: Types.ObjectId })),
  ]);

  return {
    available: openPool,
    toDeliver,
    completedToday,
    // Progress counts only what this rider took on — the pool is everyone's,
    // so folding it in would make the counter drop whenever a colleague's
    // order arrived.
    progress: { done: completedToday.length, total: completedToday.length + toDeliver.length },
  };
}

export async function setAvailability(
  tenantId: Types.ObjectId,
  riderId: Types.ObjectId,
  availability: 'available' | 'off_shift',
) {
  const rider = await User.findOneAndUpdate(
    { _id: riderId, tenantId, role: 'deliveryStaff' },
    { availability },
    { new: true },
  );
  if (!rider) throw AppError.notFound('Rider');
  return rider;
}

/**
 * End-of-shift reconciliation. `stats.completedToday` on the User is a
 * counter incremented on each delivery and reset by a nightly job — fine for
 * the assignment heuristic, but it carries no money, so the cash figures are
 * recomputed from the orders themselves.
 *
 * `proof.amountCollected` is the source of truth rather than `total`: it is
 * what the rider actually took at the door, and for a credit order that is
 * an optional repayment which may be absent or differ from the order value.
 */
export async function mySummary(tenantId: Types.ObjectId, riderId: Types.ObjectId) {
  const rider = await User.findOne({ _id: riderId, tenantId, role: 'deliveryStaff' });
  if (!rider) throw AppError.notFound('Rider');

  const dayStart = await startOfShopToday(tenantId);

  const delivered = await Order.find({
    tenantId,
    fulfillment: 'delivery',
    'rider.userId': riderId,
    status: 'delivered',
    events: { $elemMatch: { status: 'delivered', at: { $gte: dayStart } } },
  });

  let cashCollected = 0;
  let creditCollected = 0;
  let cardOrders = 0;
  let creditOrders = 0;
  let cashOrders = 0;

  for (const order of delivered) {
    const collected = order.proof?.amountCollected ?? 0;
    if (order.paymentKind === 'cash') {
      cashOrders += 1;
      cashCollected += collected;
    } else if (order.paymentKind === 'credit') {
      creditOrders += 1;
      creditCollected += collected;
    } else {
      cardOrders += 1;
    }
  }

  return {
    deliveriesCompleted: delivered.length,
    // fils, like every other money field on the API (§2 CONVENTIONS).
    cashCollected,
    creditCollected,
    totalCollected: cashCollected + creditCollected,
    breakdown: { cashOrders, creditOrders, cardOrders },
    avgMinutes: rider.stats!.avgMinutes,
    activeOrders: rider.activeOrderIds.length,
    availability: rider.availability,
  };
}
