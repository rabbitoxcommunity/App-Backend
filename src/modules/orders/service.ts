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
import { acceptAssignment } from './rider.js';
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
              imageUrl: l.imageUrl,
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
  //
  // NO AUTOMATIC RIDER ALLOCATION. A new delivery order goes into an open
  // pool and stays unassigned until a rider claims it themselves (see
  // claimOrder below). This replaces the workload-based auto-assignment that
  // used to run here: a shop with a couple of drivers who can see each
  // other and the shelves picks better than a heuristic can, and the old
  // model had orders stranded whenever nobody happened to be `available`.
  //
  // Managers can still direct a specific order at a specific rider from the
  // dashboard — see manualAssignRider.
  realtime.orderCreated(String(tenantId), order.toJSON());

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
export async function withCustomerInfo<T extends { customerId: Types.ObjectId }>(
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
    const rider = await User.findByIdAndUpdate(
      order.rider.userId,
      {
        $pull: { activeOrderIds: order._id },
        $inc: { 'stats.completedToday': targetStatus === 'delivered' ? 1 : 0 },
      },
      { new: true },
    );

    // §9.5 — hand the rider back to the assignment pool once their hands are
    // empty. Without this they stay `on_delivery` for ever: the order is
    // pulled off activeOrderIds but availability is never reset, and
    // selectAndClaimRider only ever matches `available`. One completed
    // delivery was enough to take a rider out of rotation permanently, and
    // once every rider had done one, new orders stopped being assigned to
    // anybody at all.
    //
    // `off_shift` is left alone on purpose — a rider who clocked out while
    // holding their last order must not be dragged back on by finishing it.
    if (rider && rider.availability === 'on_delivery' && rider.activeOrderIds.length === 0) {
      rider.availability = 'available';
      await rider.save();
    }
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

/**
 * OPEN POOL — a rider claims an unassigned order for themselves.
 *
 * The whole thing hangs on one atomic `findOneAndUpdate` with
 * `'rider.userId': null` IN THE FILTER. That predicate is the lock: when two
 * riders tap the same order at the same moment, MongoDB applies one update
 * and the other's filter no longer matches, so it returns null and that
 * rider is told someone beat them to it. Reading the order first and then
 * writing would let both through.
 */
export async function claimOrder(
  tenantId: Types.ObjectId,
  orderId: string,
  riderId: Types.ObjectId,
): Promise<OrderDoc> {
  const rider = await User.findOne({ _id: riderId, tenantId, role: 'deliveryStaff' });
  if (!rider) throw AppError.notFound('Rider');
  if (rider.status !== 'active') {
    throw new AppError('ACCOUNT_BLOCKED', 'This account is not active.');
  }

  const tenant = await Tenant.findById(tenantId);

  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      tenantId,
      fulfillment: 'delivery',
      'rider.userId': null,
      status: { $nin: ['delivered', 'handed_over', 'cancelled'] },
    },
    {
      $set: {
        rider: {
          userId: rider._id,
          name: { en: rider.name, ar: rider.name },
          phone: rider.phone,
          etaMinutes: tenant?.settings!.deliveryEtaMinutes ?? 30,
        },
        'assignment.assignedAt': new Date(),
        // A claim IS the acceptance — there is no offer to time out any more.
        'assignment.acceptedAt': new Date(),
        'assignment.needsManualAssignment': false,
      },
    },
    { new: true },
  );

  if (!order) {
    // Either another rider got there first, or it was cancelled/delivered
    // meanwhile. Both read the same way to whoever tapped.
    throw AppError.conflict('Another driver has already taken this order.');
  }

  await User.findByIdAndUpdate(rider._id, {
    availability: 'on_delivery',
    $addToSet: { activeOrderIds: order._id },
  });

  realtime.orderAssigned(String(tenantId), String(rider._id), order.toJSON());
  domainEvents.emit('order.assigned', { tenantId: String(tenantId), order, riderId: String(rider._id) });

  return order;
}

export async function acceptRiderOffer(tenantId: Types.ObjectId, orderId: string, riderId: Types.ObjectId) {
  const order = await acceptAssignment(tenantId, orderId, riderId);
  if (!order) throw AppError.notFound('Assignment');
  return order;
}

/**
 * §9.7 — records a refund. It does NOT move money: there is no payment gateway
 * in v1 (D12), so the actual return is done by hand in the provider's dashboard
 * and this marks the order so the books and the Insights figures agree.
 *
 * Previously the endpoint only wrote an audit row and returned the order
 * untouched, so a refunded order was indistinguishable from an unrefunded one
 * anywhere in the product.
 */
export async function refundOrder(
  tenantId: Types.ObjectId,
  orderId: string,
): Promise<OrderDoc> {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('Order');

  if (order.paymentStatus !== 'collected') {
    throw new AppError(
      'INVALID_TRANSITION',
      order.paymentStatus === 'refunded'
        ? 'This order has already been refunded.'
        : `Nothing to refund — payment was never collected (status "${order.paymentStatus}").`,
    );
  }

  order.paymentStatus = 'refunded';
  await order.save();
  realtime.orderStatus(String(tenantId), String(order._id), null, order.toJSON());
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

      // Customers and managers now share the same window: `placed` or `packed`.
      // Customer-cancel used to stop at `placed`, which on a shop that starts
      // packing within a minute meant nearly every real attempt was refused and
      // the customer had to phone anyway — the self-serve path existed but
      // almost never applied. Once a rider has it (`out_for_delivery`) or it is
      // waiting at the bay, cancelling is a conversation, not a button.
      const CANCELLABLE = ['placed', 'packed'];
      if (actor.role === 'customer' && String(found.customerId) !== String(actor.userId)) {
        throw AppError.forbidden();
      }
      if (!CANCELLABLE.includes(found.status)) {
        throw new AppError(
          'INVALID_TRANSITION',
          found.status === 'cancelled'
            ? 'This order has already been cancelled.'
            : `This order can no longer be cancelled — it is already "${found.status}".`,
        );
      }

      found.status = 'cancelled';
      found.cancelledAt = new Date();
      found.cancelReason = reason;
      found.cancelledBy = actor.userId;
      found.events.push({ status: 'cancelled', at: new Date(), byUserId: actor.userId });

      /**
       * Money already taken has to be given back, and the record has to say so.
       *
       * There is no payment gateway in v1 (§9.7 / D12), so nothing here moves
       * money — a card order is never charged at all, and its paymentStatus
       * stays `pending` for life. Marking `refunded` only when the payment was
       * actually `collected` keeps the field truthful today (a cancelled,
       * never-charged order is not "refunded"), and becomes correct on its own
       * the day a gateway starts setting `collected` at capture time.
       */
      if (found.paymentStatus === 'collected') {
        found.paymentStatus = 'refunded';
      }

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
/**
 * §9 — the rider's one write that closes an order out: proves the code,
 * records the proof (photo + GPS), banks whatever money changed hands, and
 * only then moves the status.
 *
 * The three payment kinds behave differently at the door:
 *   card   — already paid online. Nothing to collect; an amount is a bug.
 *   cash   — the full order total is due, exactly. Enforced.
 *   credit — the ledger was ALREADY charged when the order was placed
 *            (§13.2, inside placeOrder's transaction). So the money is not
 *            due at the door and `amountCollected` is optional. When the
 *            customer does hand over cash it is a repayment against their
 *            account, written as a `payment` entry (negative amount), NOT a
 *            second charge — the balance goes down, it does not double.
 */
export async function confirmDelivery(
  tenantId: Types.ObjectId,
  orderId: string,
  input: { code: string; photoUrl?: string; geo?: { lat: number; lng: number }; amountCollected?: number },
  actor: { userId: Types.ObjectId },
): Promise<OrderDoc> {
  const existing = await Order.findOne({ _id: orderId, tenantId });
  if (!existing) throw AppError.notFound('Order');

  if (existing.confirmationCode !== input.code) {
    throw new AppError('VALIDATION_FAILED', 'Confirmation code does not match.');
  }

  const collected = input.amountCollected ?? null;

  if (existing.paymentKind === 'cash') {
    if (collected == null || collected !== existing.total) {
      throw new AppError('AMOUNT_MISMATCH', 'The amount collected does not match the order total.', {
        expected: existing.total,
        received: collected,
      });
    }
  } else if (existing.paymentKind === 'card') {
    if (collected != null && collected !== 0) {
      throw new AppError('AMOUNT_MISMATCH', 'A card order is already paid — nothing is collected at the door.', {
        expected: 0,
        received: collected,
      });
    }
  } else if (collected != null) {
    // A repayment larger than the order it was taken against is a
    // back-office settlement, not a doorstep one — the rider is not
    // carrying that much reconciliation.
    if (collected <= 0 || collected > existing.total) {
      throw new AppError('AMOUNT_MISMATCH', 'A credit repayment must be between 0 and the order total.', {
        expected: existing.total,
        received: collected,
      });
    }
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: orderId, tenantId }).session(session);
      if (!order) throw AppError.notFound('Order');

      order.proof = {
        code: true,
        photoUrl: input.photoUrl ?? null,
        geo: input.geo,
        amountCollected: collected,
      };
      if (order.paymentKind === 'cash') order.paymentStatus = 'collected';

      if (order.paymentKind === 'credit' && collected != null) {
        await appendLedgerEntry(
          {
            tenantId,
            customerId: order.customerId,
            kind: 'payment',
            title: { en: 'Payment collected on delivery', ar: 'تم تحصيل الدفعة عند التسليم' },
            subtitle: { en: `Order ${order.reference}`, ar: `طلب ${order.reference}` },
            amount: -collected,
            orderId: order._id,
            recordedBy: actor.userId,
          },
          session,
        );
        order.paymentStatus = 'collected';
      }

      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  // Outside the transaction on purpose: transitionStatus emits sockets and
  // domain events, and the codebase's rule is that no network I/O runs
  // inside one.
  const targetStatus: OrderStatus = existing.fulfillment === 'delivery' ? 'delivered' : 'handed_over';
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
  // Placing it by hand IS the manual assignment this flag was asking for.
  // Leaving it set would keep the order flagged as needing attention in the
  // dashboard for ever, even though a rider now has it.
  order.assignment!.needsManualAssignment = false;
  await order.save();
  await User.findByIdAndUpdate(rider._id, { $addToSet: { activeOrderIds: order._id } });

  realtime.orderAssigned(String(tenantId), String(rider._id), order.toJSON());
  return order;
}
