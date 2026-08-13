import mongoose, { Types } from 'mongoose';
import { Order, type OrderDoc } from '../../models/Order.js';
import { PromoCode } from '../../models/PromoCode.js';
import { PromoRedemption } from '../../models/PromoRedemption.js';
import { Address } from '../../models/Address.js';
import { User } from '../../models/User.js';
import { priceBasket, type CartInput } from '../cart/service.js';
import { appendLedgerEntry } from '../credit/service.js';
import { AppError } from '../../lib/errors.js';
import { generateOrderReference } from '../../lib/reference.js';
import { generateConfirmationCode } from '../../lib/crypto.js';
import { verifyPriceToken } from '../../lib/priceToken.js';
import { canTransition, type OrderStatus } from '../../lib/orderFlow.js';
import { assignRider, acceptAssignment } from './rider.js';
import { realtime } from '../../realtime/io.js';
import { decodeCursor, encodeCursor, cursorFilter } from '../../lib/cursorPagination.js';
import { Tenant } from '../../models/Tenant.js';
import { domainEvents } from '../../lib/domainEvents.js';

export type PlaceOrderInput = CartInput & {
  priceToken: string;
  paymentKind: 'card' | 'credit' | 'cash';
  car?: {
    plate: string;
    colour: { en: string; ar: string };
    colourHex: string;
    bodyType: 'sedan' | 'suv' | 'pickup' | 'coupe';
  };
};

/**
 * §13.3 PLACE ORDER — the big one. Everything inside one transaction:
 * re-price, claim the promo, issue reference + confirmation code, append
 * the credit charge if paying on credit, write the order. Rider
 * assignment, sockets and pushes happen AFTER commit — never network I/O
 * inside a transaction.
 */
export async function placeOrder(
  tenantId: Types.ObjectId,
  customerId: Types.ObjectId,
  input: PlaceOrderInput,
  idempotencyKey: string,
): Promise<OrderDoc> {
  const session = await mongoose.startSession();
  let order!: OrderDoc;

  try {
    await session.withTransaction(async () => {
      const priced = await priceBasket(tenantId, String(customerId), input, session);

      // §8 RE-PRICING AT SUBMIT — never trust a client total.
      if (priced.unavailable.length > 0) {
        throw new AppError('BASKET_CHANGED', 'Some items in your basket are no longer available.', {
          unavailable: priced.unavailable,
        });
      }
      const tokenValid = verifyPriceToken(input.priceToken, {
        lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice })),
        fulfillment: input.fulfillment,
        promoCode: priced.promo.applied ? priced.promo.code : null,
        total: priced.total,
      });
      if (!tokenValid) {
        throw new AppError('PRICE_CHANGED', 'The price of your basket has changed.', {
          corrected: {
            subtotal: priced.subtotal,
            deliveryFee: priced.deliveryFee,
            discount: priced.discount,
            total: priced.total,
          },
        });
      }
      if (priced.minOrderReason) {
        throw new AppError('MIN_ORDER_NOT_MET', priced.minOrderReason);
      }

      // §13.4 PROMO CLAIM — the guarded $inc is the lock, not the unique index alone.
      let claimedPromo: InstanceType<typeof PromoCode> | null = null;
      if (priced.promo.applied && priced.promo.code) {
        claimedPromo = await PromoCode.findOneAndUpdate(
          { tenantId, code: priced.promo.code, active: true, $or: [{ maxRedemptions: null }, { $expr: { $lt: ['$redemptions', '$maxRedemptions'] } }] },
          { $inc: { redemptions: 1 } },
          { new: true, session },
        );
        if (!claimedPromo) {
          throw new AppError('PROMO_LIMIT_REACHED', 'This promo code just reached its redemption limit.');
        }
      }

      let addressSnapshot: OrderDoc['addressSnapshot'] = undefined;
      if (input.fulfillment === 'delivery') {
        if (!input.addressId) throw AppError.validationFailed({ addressId: 'Required for delivery orders.' });
        const address = await Address.findOne({ _id: input.addressId, tenantId, customerId }).session(session);
        if (!address) throw AppError.notFound('Address');
        addressSnapshot = {
          label: address.label,
          lines: address.lines,
          phone: address.phone ?? undefined,
          geo: address.geo ?? undefined,
        };
      }

      const tenant = await Tenant.findById(tenantId).session(session);
      const reference = await uniqueReference(tenantId, tenant?.settings!.orderRefPrefix, session);
      const confirmationCode = generateConfirmationCode();

      const [created] = await Order.create(
        [
          {
            tenantId,
            reference,
            customerId,
            fulfillment: input.fulfillment,
            status: 'placed',
            placedAt: new Date(),
            events: [{ status: 'placed', at: new Date() }],
            lines: priced.lines.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              lineTotal: l.lineTotal,
              name: l.name,
              variantLabel: l.variantLabel,
              icon: l.icon,
              fulfilledQty: l.quantity,
            })),
            subtotal: priced.subtotal,
            deliveryFee: priced.deliveryFee,
            discount: priced.discount,
            total: priced.total,
            paymentKind: input.paymentKind,
            paymentStatus: input.paymentKind === 'cash' ? 'pending' : 'pending',
            confirmationCode,
            promoCode: priced.promo.applied ? priced.promo.code : null,
            addressSnapshot,
            car: input.fulfillment === 'curbside' ? input.car : undefined,
            idempotencyKey,
          },
        ],
        { session },
      );
      order = created!;

      if (claimedPromo) {
        await PromoRedemption.create(
          [{ tenantId, promoId: claimedPromo._id, customerId, orderId: order._id }],
          { session },
        );
      }

      // §13.2 — credit charge happens inside the same transaction as order creation.
      if (input.paymentKind === 'credit') {
        await appendLedgerEntry(
          {
            tenantId,
            customerId,
            kind: 'charge',
            title: { en: `Order #${reference}`, ar: `الطلب ${reference}` },
            subtitle: { en: `${priced.lines.length} item(s)`, ar: `${priced.lines.length} منتج` },
            amount: priced.total,
            orderId: order._id,
          },
          session,
        );
      }
    });
  } finally {
    await session.endSession();
  }

  // Outside the transaction — network I/O and non-critical side effects.
  realtime.orderCreated(String(tenantId), order.toJSON());
  if (order.fulfillment === 'delivery') {
    await assignRider(tenantId, order._id);
  }

  return order;
}

async function uniqueReference(
  tenantId: Types.ObjectId,
  prefix: string | undefined,
  session: mongoose.ClientSession,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateOrderReference(prefix);
    const exists = await Order.exists({ tenantId, reference: candidate }).session(session);
    if (!exists) return candidate;
  }
  throw new AppError('INTERNAL', 'Could not generate a unique order reference.');
}

// ---------------------------------------------------------------- reads

/**
 * ADMIN GAP FILL — the CMS order screens (live queue, history, drawer) need
 * the customer's name and phone prominently, but Order only stores
 * customerId. Batch-join rather than N+1: one User query per page of orders.
 */
async function withCustomerInfo<T extends { customerId: Types.ObjectId }>(
  orders: T[],
): Promise<Array<T & { customer: { name: string; phone: string } | null }>> {
  if (orders.length === 0) return [];
  const ids = [...new Set(orders.map((o) => String(o.customerId)))];
  const customers = await User.find({ _id: { $in: ids } }, { name: 1, phone: 1 });
  const byId = new Map(customers.map((c) => [String(c._id), { name: c.name, phone: c.phone }]));
  return orders.map((o) => ({ ...o, customer: byId.get(String(o.customerId)) ?? null }));
}

export async function getOrder(tenantId: Types.ObjectId, orderId: string, customerId?: Types.ObjectId) {
  const filter: Record<string, unknown> = { _id: orderId, tenantId };
  if (customerId) filter.customerId = customerId;
  const order = await Order.findOne(filter);
  if (!order) throw AppError.notFound('Order');
  const [withCustomer] = await withCustomerInfo([order.toJSON() as unknown as { customerId: Types.ObjectId }]);
  return withCustomer;
}

export async function listCustomerOrders(
  tenantId: Types.ObjectId,
  customerId: Types.ObjectId,
  opts: { cursor?: string; limit: number },
) {
  const cursor = decodeCursor(opts.cursor);
  const filter = { tenantId, customerId, ...cursorFilter('placedAt', cursor) };
  const items = await Order.find(filter)
    .sort({ placedAt: -1, _id: -1 })
    .limit(opts.limit + 1);
  const hasMore = items.length > opts.limit;
  const page = items.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(last.placedAt.getTime(), String(last._id)) : null,
  };
}

export async function listAdminOrders(
  tenantId: Types.ObjectId,
  opts: { cursor?: string; limit: number; status?: string; fulfillment?: string; q?: string },
) {
  const cursor = decodeCursor(opts.cursor);
  const filter: Record<string, unknown> = { tenantId, ...cursorFilter('placedAt', cursor) };
  if (opts.status) filter.status = opts.status;
  if (opts.fulfillment) filter.fulfillment = opts.fulfillment;
  if (opts.q) filter.reference = new RegExp(opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const items = await Order.find(filter)
    .sort({ placedAt: -1, _id: -1 })
    .limit(opts.limit + 1);
  const hasMore = items.length > opts.limit;
  const page = items.slice(0, opts.limit);
  const last = page[page.length - 1];
  const withCustomers = await withCustomerInfo(
    page.map((o) => o.toJSON() as unknown as { customerId: Types.ObjectId }),
  );
  return {
    items: withCustomers,
    nextCursor: hasMore && last ? encodeCursor(last.placedAt.getTime(), String(last._id)) : null,
  };
}

// ------------------------------------------------------------ state machine

export async function transitionStatus(
  tenantId: Types.ObjectId,
  orderId: string,
  targetStatus: OrderStatus,
  actor: { userId: Types.ObjectId | null; role: string | null },
): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('Order');

  // §9.2 — customer_arrived is the one transition the CUSTOMER may trigger.
  if (actor.role === 'customer' && targetStatus !== 'customer_arrived') {
    throw AppError.forbidden('Customers may only mark themselves as arrived.');
  }
  if (targetStatus === 'customer_arrived' && actor.role === 'customer' && String(order.customerId) !== String(actor.userId)) {
    throw AppError.forbidden();
  }

  if (!canTransition(order.fulfillment as 'delivery' | 'curbside', order.status as OrderStatus, targetStatus)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot move a "${order.fulfillment}" order from "${order.status}" to "${targetStatus}".`,
    );
  }

  // §9.2 — handed_over requires customer_arrived first.
  if (targetStatus === 'handed_over') {
    const arrived = order.events.some((e) => e.status === 'customer_arrived');
    if (!arrived) {
      throw new AppError('INVALID_TRANSITION', 'The customer must be marked arrived before hand-over.');
    }
  }

  order.status = targetStatus;
  order.events.push({ status: targetStatus, at: new Date(), byUserId: actor.userId ?? undefined });

  if (targetStatus === 'ready_for_pickup' || targetStatus === 'packed') {
    // §9.6 — totals are recomputed from fulfilled quantities on leaving `packed`;
    // handled by updateOrderLines. Nothing to do here if no short-pick occurred.
  }
  if (targetStatus === 'delivered' || targetStatus === 'handed_over') {
    if (order.paymentKind === 'card' || order.paymentKind === 'cash') {
      order.paymentStatus = 'collected';
    }
  }

  await order.save();

  if (order.fulfillment === 'delivery' && order.rider?.userId && (targetStatus === 'delivered' || targetStatus === 'cancelled')) {
    await User.findByIdAndUpdate(order.rider.userId, {
      $pull: { activeOrderIds: order._id },
      $inc: { 'stats.completedToday': targetStatus === 'delivered' ? 1 : 0 },
    });
  }

  realtime.orderStatus(String(tenantId), String(order._id), order.rider?.userId ? String(order.rider.userId) : null, order.toJSON());
  if (targetStatus === 'customer_arrived') {
    realtime.orderArrived(String(tenantId), order.toJSON());
  }
  domainEvents.emit('order.status.changed', { tenantId: String(tenantId), order });

  return order;
}

export async function markArrived(tenantId: Types.ObjectId, orderId: string, customerId: Types.ObjectId) {
  return transitionStatus(tenantId, orderId, 'customer_arrived', { userId: customerId, role: 'customer' });
}

/** §9 curbside — the customer's "on the way" / "near" ping, ahead of the customer_arrived transition. */
export async function setArrival(
  tenantId: Types.ObjectId,
  orderId: string,
  customerId: Types.ObjectId,
  arrival: 'on_way' | 'near',
): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId, customerId });
  if (!order) throw AppError.notFound('Order');
  if (order.fulfillment !== 'curbside') {
    throw new AppError('VALIDATION_FAILED', 'Only curbside orders track arrival.');
  }
  if (!['placed', 'packed', 'ready_for_pickup'].includes(order.status)) {
    throw new AppError('INVALID_TRANSITION', 'This order is no longer awaiting pickup.');
  }

  order.arrival = arrival;
  await order.save();

  realtime.orderArrival(String(tenantId), String(order._id), order.toJSON());
  return order;
}

export async function acceptRiderOffer(tenantId: Types.ObjectId, orderId: string, riderId: Types.ObjectId) {
  const order = await acceptAssignment(tenantId, orderId, riderId);
  if (!order) throw AppError.notFound('Assignment');
  return order;
}

// ---------------------------------------------------------------- cancellation

/** §9.7 — customer may cancel only while `placed`; a manager while `placed` or `packed`. */
export async function cancelOrder(
  tenantId: Types.ObjectId,
  orderId: string,
  actor: { userId: Types.ObjectId; role: string; grade?: string | null },
  reason: string,
): Promise<OrderDoc> {
  const session = await mongoose.startSession();
  let order!: OrderDoc;

  try {
    await session.withTransaction(async () => {
      const found = await Order.findOne({ _id: orderId, tenantId }).session(session);
      if (!found) throw AppError.notFound('Order');

      if (actor.role === 'customer') {
        if (String(found.customerId) !== String(actor.userId)) throw AppError.forbidden();
        if (found.status !== 'placed') {
          throw new AppError('INVALID_TRANSITION', 'This order can no longer be cancelled — it is already being packed.');
        }
      } else {
        if (!['placed', 'packed'].includes(found.status)) {
          throw new AppError('INVALID_TRANSITION', `Cannot cancel an order that is "${found.status}".`);
        }
      }

      found.status = 'cancelled';
      found.cancelledAt = new Date();
      found.cancelReason = reason;
      found.cancelledBy = actor.userId;
      found.events.push({ status: 'cancelled', at: new Date(), byUserId: actor.userId });

      // §9.7 — cancelling a credit order writes a compensating entry in the SAME transaction.
      if (found.paymentKind === 'credit') {
        await appendLedgerEntry(
          {
            tenantId,
            customerId: found.customerId,
            kind: 'payment',
            title: { en: `Cancelled order #${found.reference}`, ar: `إلغاء الطلب ${found.reference}` },
            amount: -found.total,
            orderId: found._id,
            recordedBy: actor.role === 'customer' ? null : actor.userId,
          },
          session,
        );
      }

      await found.save({ session });
      order = found;
    });
  } finally {
    await session.endSession();
  }

  if (order.fulfillment === 'delivery' && order.rider?.userId) {
    await User.findByIdAndUpdate(order.rider.userId, {
      availability: 'available',
      $pull: { activeOrderIds: order._id },
    });
  }

  realtime.orderStatus(String(tenantId), String(order._id), null, order.toJSON());
  return order;
}

// -------------------------------------------------------- oversell / substitution

export type LineFulfillmentUpdate = { variantId: string; fulfilledQty: number };

/**
 * §9.6 OVERSELL AND SUBSTITUTION. On leaving `packed`, staff may short-pick
 * or zero out a line. The order total is RECOMPUTED from fulfilled
 * quantities; original `lines[].quantity` is never rewritten. Credit orders
 * get a compensating ledger entry for the difference, in the same
 * transaction as the total change.
 */
export async function updateOrderLines(
  tenantId: Types.ObjectId,
  orderId: string,
  updates: LineFulfillmentUpdate[],
  actor: { userId: Types.ObjectId },
): Promise<OrderDoc> {
  const session = await mongoose.startSession();
  let order!: OrderDoc;

  try {
    await session.withTransaction(async () => {
      const found = await Order.findOne({ _id: orderId, tenantId }).session(session);
      if (!found) throw AppError.notFound('Order');
      if (!['placed', 'packed'].includes(found.status)) {
        throw new AppError('INVALID_TRANSITION', 'Lines can only be adjusted while packing.');
      }

      const originalTotal = found.total;

      for (const update of updates) {
        const line = found.lines.find((l) => String(l.variantId) === update.variantId);
        if (!line) continue;
        line.fulfilledQty = Math.max(0, Math.min(update.fulfilledQty, line.quantity));
      }

      const newSubtotal = found.lines.reduce(
        (sum, l) => sum + l.unitPrice * (l.fulfilledQty ?? l.quantity),
        0,
      );
      const newTotal = Math.max(0, newSubtotal - found.discount + found.deliveryFee);
      const difference = newTotal - originalTotal; // negative when the customer now owes less

      found.subtotal = newSubtotal;
      found.total = newTotal;

      if (difference !== 0 && found.paymentKind === 'credit') {
        await appendLedgerEntry(
          {
            tenantId,
            customerId: found.customerId,
            kind: difference > 0 ? 'charge' : 'payment',
            title: { en: `Adjustment on order #${found.reference}`, ar: `تعديل على الطلب ${found.reference}` },
            amount: difference,
            orderId: found._id,
            recordedBy: actor.userId,
          },
          session,
        );
      }

      await found.save({ session });
      order = found;
    });
  } finally {
    await session.endSession();
  }

  realtime.orderLines(String(tenantId), String(order._id), order.toJSON());
  domainEvents.emit('order.lines.changed', { tenantId: String(tenantId), order });
  return order;
}

// -------------------------------------------------------------- confirmation

/** §9.4 — required for `delivered` and `handed_over`. Captures proof of delivery. */
export async function confirmDelivery(
  tenantId: Types.ObjectId,
  orderId: string,
  input: { code: string; photoUrl: string; geo?: { lat: number; lng: number }; amountCollected?: number },
  actor: { userId: Types.ObjectId },
): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('Order');

  if (order.confirmationCode !== input.code) {
    throw new AppError('VALIDATION_FAILED', 'Confirmation code does not match.');
  }
  if (order.paymentKind === 'cash') {
    if (input.amountCollected == null || input.amountCollected !== order.total) {
      throw new AppError('AMOUNT_MISMATCH', 'The amount collected does not match the order total.', {
        expected: order.total,
        received: input.amountCollected ?? null,
      });
    }
  }

  order.proof = {
    code: true,
    photoUrl: input.photoUrl,
    geo: input.geo,
    amountCollected: input.amountCollected ?? null,
  };
  if (order.paymentKind === 'cash') order.paymentStatus = 'collected';
  await order.save();

  const targetStatus: OrderStatus = order.fulfillment === 'delivery' ? 'delivered' : 'handed_over';
  return transitionStatus(tenantId, orderId, targetStatus, { userId: actor.userId, role: 'deliveryStaff' });
}

export async function getReceipt(tenantId: Types.ObjectId, orderId: string, customerId: Types.ObjectId) {
  const order = await getOrder(tenantId, orderId, customerId);
  return order;
}

/** §10 POST /admin/orders/:id/verify-code — curbside staff typing in the code the customer reads out. */
export async function verifyCode(tenantId: Types.ObjectId, orderId: string, code: string): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('Order');
  if (order.confirmationCode !== code) {
    throw new AppError('VALIDATION_FAILED', 'Confirmation code does not match.');
  }
  order.proof!.code = true;
  await order.save();
  return order;
}

/** §10 POST /admin/orders/:id/rider — manual assign/reassign, overriding automatic §9.5 selection. */
export async function manualAssignRider(
  tenantId: Types.ObjectId,
  orderId: string,
  riderId: string,
): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('Order');
  if (order.fulfillment !== 'delivery') {
    throw new AppError('VALIDATION_FAILED', 'Only delivery orders carry a rider.');
  }

  const rider = await User.findOneAndUpdate(
    { _id: riderId, tenantId, role: 'deliveryStaff', status: 'active' },
    { availability: 'on_delivery' },
    { new: true },
  );
  if (!rider) throw new AppError('RIDER_UNAVAILABLE', 'That rider could not be assigned.');

  if (order.rider?.userId && String(order.rider.userId) !== riderId) {
    await User.findByIdAndUpdate(order.rider.userId, {
      availability: 'available',
      $pull: { activeOrderIds: order._id },
    });
  }

  order.rider = { userId: rider._id, name: { en: rider.name, ar: rider.name }, phone: rider.phone, etaMinutes: order.rider?.etaMinutes ?? 30 };
  order.assignment!.assignedAt = new Date();
  order.assignment!.acceptedAt = null;
  await order.save();
  await User.findByIdAndUpdate(rider._id, { $addToSet: { activeOrderIds: order._id } });

  realtime.orderAssigned(String(tenantId), String(rider._id), order.toJSON());
  return order;
}
