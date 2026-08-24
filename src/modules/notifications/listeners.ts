import { domainEvents } from '../../lib/domainEvents.js';
import { sendPush } from '../../lib/push.js';
import { User } from '../../models/User.js';
import { NotifyRequest } from '../../models/NotifyRequest.js';
import { pickLanguage } from '../../lib/localized.js';
import { logger } from '../../config/logger.js';
import type { OrderDoc } from '../../models/Order.js';
import type { CreditEntryDoc } from '../../models/CreditEntry.js';

/**
 * §15 NOTIFICATIONS — the consumer side of the domain events emitted from
 * orders/credit/catalog. Registered once from jobs/index.ts (well outside
 * the HTTP request path — these are fire-and-forget side effects, never on
 * the critical path of the write that triggered them).
 */
export function registerNotificationListeners(): void {
  domainEvents.on('order.status.changed', (payload: { tenantId: string; order: OrderDoc }) => {
    notifyOrderStatus(payload).catch((err) => logger.error({ err }, 'order.status.changed notify failed'));
  });

  domainEvents.on('order.assigned', (payload: { tenantId: string; order: OrderDoc; riderId: string }) => {
    notifyRiderAssigned(payload).catch((err) => logger.error({ err }, 'order.assigned notify failed'));
  });

  domainEvents.on('order.lines.changed', (payload: { tenantId: string; order: OrderDoc }) => {
    notifyLinesChanged(payload).catch((err) => logger.error({ err }, 'order.lines.changed notify failed'));
  });

  domainEvents.on(
    'credit.payment.recorded',
    (payload: { tenantId: string; customerId: string; entry: CreditEntryDoc }) => {
      notifyCreditPayment(payload).catch((err) => logger.error({ err }, 'credit.payment notify failed'));
    },
  );

  domainEvents.on('stock.backInStock', (payload: { tenantId: string; variantId: string; productName: string }) => {
    notifyBackInStock(payload).catch((err) => logger.error({ err }, 'stock.backInStock notify failed'));
  });
}

/** §20.2 — notifications use the recipient's stored `language`. */
async function pushToUser(
  userId: unknown,
  title: string,
  body: string | { en: string; ar: string },
  data: Record<string, unknown> = {},
) {
  const user = await User.findById(userId);
  if (!user || user.pushTokens.length === 0) return;
  const text = typeof body === 'string' ? body : pickLanguage(body, (user.language as 'en' | 'ar') ?? 'en');

  const { invalidTokens } = await sendPush(
    user.pushTokens.map((t) => ({ token: t.token, title, body: text, data })),
  );

  /**
   * Drop tokens FCM has told us are dead (app uninstalled, token rotated).
   * Without this every stale token is retried on every future notification for
   * the life of the account, and a customer who reinstalls a few times
   * accumulates tokens that can never deliver.
   */
  if (invalidTokens.length > 0) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { pushTokens: { token: { $in: invalidTokens } } } },
    );
  }
}

async function notifyOrderStatus({ order }: { tenantId: string; order: OrderDoc }) {
  const copy: Record<string, { en: string; ar: string }> = {
    packed: { en: 'Your order is being packed.', ar: 'جارٍ تجهيز طلبك.' },
    out_for_delivery: { en: 'Your order is on its way!', ar: 'طلبك في الطريق!' },
    delivered: { en: 'Your order has been delivered.', ar: 'تم توصيل طلبك.' },
    ready_for_pickup: { en: 'Your order is ready for pickup.', ar: 'طلبك جاهز للاستلام.' },
    handed_over: { en: 'Enjoy! Your order has been handed over.', ar: 'استمتع! تم تسليم طلبك.' },
    cancelled: { en: 'Your order was cancelled.', ar: 'تم إلغاء طلبك.' },
  };
  const message = copy[order.status];
  if (!message) return;
  await pushToUser(order.customerId, `Order #${order.reference}`, message, {
    orderId: String(order._id),
    status: order.status,
  });
}

async function notifyRiderAssigned({ riderId, order }: { tenantId: string; order: OrderDoc; riderId: string }) {
  await pushToUser(riderId, 'New delivery assigned', `Order #${order.reference} needs pickup.`, {
    orderId: String(order._id),
  });
}

async function notifyLinesChanged({ order }: { tenantId: string; order: OrderDoc }) {
  const hasSubstitution = order.lines.some((l) => (l.fulfilledQty ?? l.quantity) < l.quantity);
  if (!hasSubstitution) return;
  await pushToUser(
    order.customerId,
    `Order #${order.reference} updated`,
    {
      en: 'Some items in your order were substituted or unavailable — check your receipt.',
      ar: 'بعض المنتجات في طلبك تم استبدالها أو كانت غير متوفرة — راجع الفاتورة.',
    },
    { orderId: String(order._id) },
  );
}

async function notifyCreditPayment({ customerId, entry }: { tenantId: string; customerId: string; entry: CreditEntryDoc }) {
  await pushToUser(
    customerId,
    'Payment received',
    `We've recorded your payment. New balance: ${entry.balanceAfter / 100} AED.`,
  );
}

async function notifyBackInStock({ tenantId, variantId, productName }: { tenantId: string; variantId: string; productName: string }) {
  const requests = await NotifyRequest.find({ tenantId, variantId, notifiedAt: null });
  for (const request of requests) {
    await pushToUser(request.customerId, 'Back in stock', `${productName} is back in stock.`, {
      productId: String(request.productId),
    });
    request.notifiedAt = new Date();
    await request.save();
  }
}
