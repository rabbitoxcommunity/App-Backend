import { Types } from 'mongoose';
import { Product } from '../../models/Product.js';
import { Tenant } from '../../models/Tenant.js';
import { PromoCode } from '../../models/PromoCode.js';
import { PromoRedemption } from '../../models/PromoRedemption.js';
import { signPriceToken } from '../../lib/priceToken.js';
import { AppError } from '../../lib/errors.js';
import type { Localized } from '../../lib/localized.js';

export type CartLineInput = { variantId: string; quantity: number };

export type CartInput = {
  lines: CartLineInput[];
  promoCode?: string;
  fulfillment: 'delivery' | 'curbside';
  addressId?: string;
};

export type PricedLine = {
  variantId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  name: Localized;
  variantLabel: Localized;
  icon: string;
  /** Product photo at the time of pricing; null when the shop has not set one. */
  imageUrl: string | null;
  stock: 'available' | 'low' | 'out';
  productId: string;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  promo: { code: string | null; applied: boolean; reason?: string };
  unavailable: string[];
  minOrderReason: string | null;
  priceToken: string;
};

type AxisLike = { _id: unknown; name: Localized; options: Array<{ _id: unknown; name: Localized }> };

function variantLabel(
  product: { axes: AxisLike[] },
  optionIds: Map<string, unknown> | Record<string, unknown>,
  fallbackLabel?: Localized | null,
): Localized {
  const entries = optionIds instanceof Map ? Array.from(optionIds.entries()) : Object.entries(optionIds ?? {});
  if (entries.length === 0) return fallbackLabel ?? { en: '', ar: '' };
  const parts: Localized[] = [];
  for (const axis of product.axes) {
    const optionId = entries.find(([axisId]) => axisId === String(axis._id))?.[1];
    const option = axis.options.find((o) => String(o._id) === String(optionId));
    if (option) parts.push(option.name);
  }
  return {
    en: parts.map((p) => p.en).join(', '),
    ar: parts.map((p) => p.ar).join(', '),
  };
}

/**
 * §8 THE PRICING ENGINE. Prices are read from the database, never accepted
 * from the client. Out-of-stock variants are excluded from totals. Promo
 * validation returns a reason on failure so the cart can explain itself.
 */
export async function priceBasket(
  tenantId: Types.ObjectId,
  customerId: string | null,
  input: CartInput,
  session?: import('mongoose').ClientSession,
): Promise<PricedCart> {
  const tenant = await Tenant.findById(tenantId).session(session ?? null);
  if (!tenant) throw AppError.notFound('Tenant');

  const variantIds = input.lines.map((l) => l.variantId);
  const products = await Product.find({
    'variants._id': { $in: variantIds.map((id) => new Types.ObjectId(id)) },
    status: 'published',
    archivedAt: null,
  }).session(session ?? null);

  const priced: PricedLine[] = [];
  const unavailable: string[] = [];

  for (const line of input.lines) {
    const product = products.find((p) => p.variants.some((v) => String(v._id) === line.variantId));
    const variant = product?.variants.find((v) => String(v._id) === line.variantId);

    if (!product || !variant || variant.archivedAt) {
      unavailable.push(line.variantId);
      continue;
    }
    if (variant.stock === 'out') {
      unavailable.push(line.variantId);
      continue;
    }

    const unitPrice = variant.price;
    priced.push({
      variantId: line.variantId,
      productId: String(product._id),
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice * line.quantity,
      name: product.name,
      variantLabel: variantLabel(product, variant.optionIds as never, variant.label),
      icon: product.icon,
      imageUrl: product.imageUrl ?? null,
      stock: variant.stock as 'available' | 'low' | 'out',
    });
  }

  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  const deliveryFee = input.fulfillment === 'curbside' ? 0 : tenant.settings!.deliveryFee;

  let discount = 0;
  let promoResult: PricedCart['promo'] = { code: null, applied: false };

  if (input.promoCode) {
    promoResult = await evaluatePromo(tenantId, input.promoCode, customerId, subtotal, priced, session);
    if (promoResult.applied) {
      const promo = await PromoCode.findOne({ tenantId, code: input.promoCode.toUpperCase() }).session(
        session ?? null,
      );
      if (promo) {
        discount =
          promo.discountType === 'percent'
            ? Math.round((subtotal * promo.value) / 100)
            : Math.min(promo.value, subtotal);
      }
    }
  }

  let minOrderReason: string | null = null;
  if (tenant.settings!.minOrder != null && subtotal < tenant.settings!.minOrder && subtotal > 0) {
    minOrderReason = `Minimum order is ${tenant.settings!.minOrder} fils.`;
  }

  const total = Math.max(0, subtotal - discount + deliveryFee);

  const priceToken = signPriceToken({
    lines: priced.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice })),
    fulfillment: input.fulfillment,
    promoCode: promoResult.applied ? input.promoCode!.toUpperCase() : null,
    total,
  });

  return {
    lines: priced,
    subtotal,
    deliveryFee,
    discount,
    total,
    promo: promoResult,
    unavailable,
    minOrderReason,
    priceToken,
  };
}

/** §8 RULE 4 — promo validation returns a reason on failure, never a bare rejection. */
export async function evaluatePromo(
  tenantId: Types.ObjectId,
  code: string,
  customerId: string | null,
  subtotal: number,
  lines: PricedLine[],
  session?: import('mongoose').ClientSession,
): Promise<PricedCart['promo']> {
  const promo = await PromoCode.findOne({ tenantId, code: code.toUpperCase() }).session(session ?? null);
  const normalized = code.toUpperCase();

  if (!promo || !promo.active) return { code: normalized, applied: false, reason: 'Code not found.' };

  const now = new Date();
  if (promo.startsAt && now < promo.startsAt) {
    return { code: normalized, applied: false, reason: 'This promo is not active yet.' };
  }
  if (promo.endsAt && now > promo.endsAt) {
    return { code: normalized, applied: false, reason: 'This promo code has expired.' };
  }
  if (promo.minSubtotal != null && subtotal < promo.minSubtotal) {
    return {
      code: normalized,
      applied: false,
      reason: `Add ${(promo.minSubtotal - subtotal) / 100} AED more to use this code.`,
    };
  }
  if (promo.categoryIds && promo.categoryIds.length > 0) {
    const eligible = lines.some((l) => promo.categoryIds!.some((c) => String(c) === l.productId));
    if (!eligible) return { code: normalized, applied: false, reason: 'No eligible items in your basket.' };
  }
  if (promo.maxRedemptions != null && promo.redemptions >= promo.maxRedemptions) {
    return { code: normalized, applied: false, reason: 'This promo has reached its redemption limit.' };
  }
  if (customerId && promo.perCustomerCap != null) {
    const used = await PromoRedemption.countDocuments({ tenantId, promoId: promo._id, customerId }).session(
      session ?? null,
    );
    if (used >= promo.perCustomerCap) {
      return { code: normalized, applied: false, reason: 'You have already used this promo.' };
    }
  }

  return { code: normalized, applied: true };
}
