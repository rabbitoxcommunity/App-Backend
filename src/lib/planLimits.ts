import { Types } from 'mongoose';
import { Tenant } from '../models/Tenant.js';
import { Plan } from '../models/Plan.js';
import { Product } from '../models/Product.js';
import { User } from '../models/User.js';
import { AppError } from './errors.js';

/**
 * §19.2 PLAN LIMITS — enforced at write time. RULE: never block an ORDER
 * because of a billing limit — see checkOrdersPerMonth's comment. Only
 * products and staffSeats block; ordersPerMonth is a warn-only signal
 * surfaced to /admin/analytics, not enforced here.
 */

async function getPlanLimits(tenantId: Types.ObjectId) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant?.plan?.planId) return null;
  const plan = await Plan.findById(tenant.plan.planId);
  return plan?.limits ?? null;
}

export async function assertProductLimit(tenantId: Types.ObjectId, adding = 1): Promise<void> {
  const limits = await getPlanLimits(tenantId);
  if (!limits) return; // no plan assigned yet (trial) — unlimited until onboarded onto a plan
  const count = await Product.countDocuments({ tenantId, archivedAt: null });
  if (count + adding > limits.products) {
    throw new AppError('PLAN_LIMIT_REACHED', `Plan allows ${limits.products} products; already at ${count}.`, {
      limit: limits.products,
      current: count,
    });
  }
}

export async function assertStaffSeatLimit(tenantId: Types.ObjectId): Promise<void> {
  const limits = await getPlanLimits(tenantId);
  if (!limits) return;
  const count = await User.countDocuments({ tenantId, role: { $in: ['storeAdmin', 'deliveryStaff'] } });
  if (count >= limits.staffSeats) {
    throw new AppError('PLAN_LIMIT_REACHED', `Plan allows ${limits.staffSeats} staff seats; already at ${count}.`, {
      limit: limits.staffSeats,
    });
  }
}
