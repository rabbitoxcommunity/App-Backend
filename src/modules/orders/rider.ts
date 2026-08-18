import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { logger } from '../../config/logger.js';

/**
 * §9.5 used to live here: automatic, workload-based rider allocation, with an
 * offer that expired after 120 seconds and cascaded to the next rider.
 *
 * THAT MODEL IS GONE. Delivery orders now go into an open pool that every
 * rider on the tenant can see, and a rider takes one by claiming it
 * (claimOrder in ./service.ts, where the race between two riders tapping the
 * same order is resolved atomically). A manager can still direct a specific
 * order at a specific rider from the dashboard — manualAssignRider, also in
 * ./service.ts.
 *
 * What remains here is only what the old model left behind.
 */

/**
 * Kept solely to drain BullMQ jobs enqueued by the removed allocation code
 * before it was removed. Nothing enqueues to this queue any more, so this
 * runs at most for whatever was still sitting in Redis at deploy time, and
 * must not resurrect an offer/timeout cycle that no longer exists.
 *
 * Safe to delete along with the queue itself once Redis has drained.
 */
export async function handleAssignmentTimeout(data: {
  tenantId: string;
  orderId: string;
  riderId: string;
}): Promise<void> {
  logger.info(
    { orderId: data.orderId, riderId: data.riderId },
    'Discarding a rider-timeout job left over from automatic allocation (open pool now)',
  );
}

/**
 * Marks an assignment as accepted. With the open pool a claim is already its
 * own acceptance, so this only applies to an order a manager pushed at a
 * rider from the dashboard.
 */
export async function acceptAssignment(tenantId: Types.ObjectId, orderId: string, riderId: Types.ObjectId) {
  const order = await Order.findOne({ _id: orderId, tenantId, 'rider.userId': riderId });
  if (!order) return null;
  order.assignment!.acceptedAt = new Date();
  await order.save();
  return order;
}
