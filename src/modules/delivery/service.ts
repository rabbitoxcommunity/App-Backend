import { Types } from 'mongoose';
import { Order } from '../../models/Order.js';
import { User } from '../../models/User.js';
import { AppError } from '../../lib/errors.js';

export async function myOrders(tenantId: Types.ObjectId, riderId: Types.ObjectId) {
  return Order.find({
    tenantId,
    'rider.userId': riderId,
    status: { $nin: ['delivered', 'cancelled'] },
  }).sort({ placedAt: 1 });
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

export async function mySummary(tenantId: Types.ObjectId, riderId: Types.ObjectId) {
  const rider = await User.findOne({ _id: riderId, tenantId, role: 'deliveryStaff' });
  if (!rider) throw AppError.notFound('Rider');
  return {
    completedToday: rider.stats!.completedToday,
    avgMinutes: rider.stats!.avgMinutes,
    activeOrders: rider.activeOrderIds.length,
    availability: rider.availability,
  };
}
