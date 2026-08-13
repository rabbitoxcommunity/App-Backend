import { Types, type FilterQuery } from 'mongoose';
import { User } from '../../models/User.js';
import { AppError } from '../../lib/errors.js';

export async function listCustomers(
  tenantId: Types.ObjectId,
  opts: { page: number; limit: number; q?: string },
) {
  const filter: FilterQuery<typeof User> = { tenantId, role: 'customer' };
  if (opts.q) {
    const re = new RegExp(opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { phone: re }];
  }
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    User.find(filter).skip(skip).limit(opts.limit).sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

export async function getCustomer(tenantId: Types.ObjectId, id: string) {
  const customer = await User.findOne({ _id: id, tenantId, role: 'customer' });
  if (!customer) throw AppError.notFound('Customer');
  return customer;
}

export async function blockCustomer(tenantId: Types.ObjectId, id: string, blocked: boolean) {
  const customer = await User.findOneAndUpdate(
    { _id: id, tenantId, role: 'customer' },
    { status: blocked ? 'blocked' : 'active', blockedAt: blocked ? new Date() : null },
    { new: true },
  );
  if (!customer) throw AppError.notFound('Customer');
  return customer;
}
