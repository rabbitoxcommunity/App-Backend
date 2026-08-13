import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { User } from '../../models/User.js';
import { Tenant } from '../../models/Tenant.js';
import { riderTimeoutQueue } from '../../jobs/queues.js';
import { realtime } from '../../realtime/io.js';
import { logger } from '../../config/logger.js';
import { domainEvents } from '../../lib/domainEvents.js';

const ACCEPT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/**
 * §13.5 — `findOneAndUpdate` with `availability: 'available'` in the filter
 * is the lock. If two orders race for the same idle rider, only one update
 * matches and the loser moves to the next candidate.
 */
async function selectAndClaimRider(tenantId: Types.ObjectId, excludeIds: Types.ObjectId[]) {
  const candidates = await User.find({
    tenantId,
    role: 'deliveryStaff',
    status: 'active',
    availability: 'available',
    _id: { $nin: excludeIds },
  });

  candidates.sort(
    (a, b) => a.activeOrderIds.length - b.activeOrderIds.length || a.stats!.avgMinutes - b.stats!.avgMinutes,
  );

  for (const candidate of candidates) {
    const claimed = await User.findOneAndUpdate(
      { _id: candidate._id, tenantId, availability: 'available' },
      { availability: 'on_delivery' },
      { new: true },
    );
    if (claimed) return claimed;
  }
  return null;
}

/**
 * §9.5 AUTOMATIC RIDER ASSIGNMENT. Runs on creation of a delivery order, and
 * again from the timeout worker on each reassignment attempt, up to
 * MAX_ATTEMPTS — after that the order is flagged for manual assignment in
 * the CMS queue rather than looping forever.
 */
export async function assignRider(tenantId: Types.ObjectId, orderId: Types.ObjectId): Promise<void> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order || order.fulfillment !== 'delivery' || order.status === 'cancelled') return;

  const rider = await selectAndClaimRider(tenantId, order.assignment!.lastOfferedTo);

  if (!rider) {
    if (order.assignment!.attempts >= MAX_ATTEMPTS) {
      order.assignment!.needsManualAssignment = true;
      await order.save();
      realtime.orderStatus(String(tenantId), String(order._id), null, order.toJSON());
    }
    return;
  }

  const tenant = await Tenant.findById(tenantId);

  order.rider = {
    userId: rider._id,
    name: { en: rider.name, ar: rider.name },
    phone: rider.phone,
    etaMinutes: tenant?.settings!.deliveryEtaMinutes ?? 30,
  };
  order.assignment!.assignedAt = new Date();
  order.assignment!.acceptedAt = null;
  order.assignment!.attempts += 1;
  await order.save();

  await User.findByIdAndUpdate(rider._id, { $addToSet: { activeOrderIds: order._id } });

  realtime.orderAssigned(String(tenantId), String(rider._id), order.toJSON());
  domainEvents.emit('order.assigned', { tenantId: String(tenantId), order, riderId: String(rider._id) });

  await riderTimeoutQueue.add(
    'timeout',
    { tenantId: String(tenantId), orderId: String(order._id), riderId: String(rider._id) },
    { delay: ACCEPT_TIMEOUT_MS },
  );
}

export async function acceptAssignment(tenantId: Types.ObjectId, orderId: string, riderId: Types.ObjectId) {
  const order = await Order.findOne({ _id: orderId, tenantId, 'rider.userId': riderId });
  if (!order) return null;
  order.assignment!.acceptedAt = new Date();
  await order.save();
  return order;
}

/** Runs from the delayed BullMQ job registered when a rider is offered an order. */
export async function handleAssignmentTimeout(data: {
  tenantId: string;
  orderId: string;
  riderId: string;
}): Promise<void> {
  const tenantId = new Types.ObjectId(data.tenantId);
  const order = await Order.findOne({ _id: data.orderId, tenantId });
  if (!order) return;

  const stillPendingWithThisRider =
    !order.assignment!.acceptedAt && String(order.rider?.userId) === data.riderId;

  if (!stillPendingWithThisRider) return; // already accepted, reassigned, or cancelled

  logger.info({ orderId: data.orderId, riderId: data.riderId }, 'Rider offer timed out — reassigning');

  await User.findByIdAndUpdate(data.riderId, {
    availability: 'available',
    $pull: { activeOrderIds: order._id },
  });

  order.assignment!.lastOfferedTo.push(new Types.ObjectId(data.riderId));
  order.rider = { userId: null, name: null, phone: null, etaMinutes: null };
  await order.save();

  await assignRider(tenantId, order._id);
}
