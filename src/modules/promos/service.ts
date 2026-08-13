import { Types } from 'mongoose';
import { PromoCode } from '../../models/PromoCode.js';
import { AppError } from '../../lib/errors.js';

export type PromoInput = {
  code: string;
  discountType: 'percent' | 'fixed';
  value: number;
  minSubtotal?: number | null;
  categoryIds?: string[] | null;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  perCustomerCap?: number | null;
  active?: boolean;
};

export async function listPromos(tenantId: Types.ObjectId) {
  return PromoCode.find({ tenantId }).sort({ createdAt: -1 });
}

export async function createPromo(input: PromoInput) {
  return PromoCode.create({ ...input, code: input.code.toUpperCase() });
}

export async function updatePromo(id: string, input: Partial<PromoInput>) {
  const promo = await PromoCode.findByIdAndUpdate(
    id,
    { ...input, ...(input.code ? { code: input.code.toUpperCase() } : {}) },
    { new: true },
  );
  if (!promo) throw AppError.notFound('Promo');
  return promo;
}

export async function deletePromo(id: string) {
  const promo = await PromoCode.findByIdAndUpdate(id, { active: false }, { new: true });
  if (!promo) throw AppError.notFound('Promo');
  return promo;
}
