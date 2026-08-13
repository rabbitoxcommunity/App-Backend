import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { AppError } from '../../lib/errors.js';
import { realtime } from '../../realtime/io.js';

/** §4/CMS-SCOPE module 07 — the staff-facing arrival queue. */
export async function arrivalQueue(tenantId: Types.ObjectId) {
  return Order.find({
    tenantId,
    fulfillment: 'curbside',
    status: { $in: ['ready_for_pickup', 'customer_arrived'] },
  }).sort({ 'events.at': 1 });
}

export async function assignBay(tenantId: Types.ObjectId, orderId: string, bay: number) {
  const order = await Order.findOneAndUpdate({ _id: orderId, tenantId }, { bay }, { new: true });
  if (!order) throw AppError.notFound('Order');
  realtime.orderStatus(String(tenantId), String(order._id), null, order.toJSON());
  return order;
}
