import { EventEmitter } from 'node:events';

/**
 * §15 RULE — state transitions EMIT A DOMAIN EVENT; a notifier consumes it.
 * Nothing in the order/credit/catalog modules imports the push SDK
 * directly — this resolves the v1 contradiction where §7 said every
 * transition fires a push while §11 deferred push entirely. See
 * modules/notifications/listeners.ts for the consumer side.
 */
export const domainEvents = new EventEmitter();
domainEvents.setMaxListeners(50);

export type DomainEventName =
  | 'order.status.changed'
  | 'order.assigned'
  | 'order.lines.changed'
  | 'credit.payment.recorded'
  | 'stock.backInStock'
  | 'invoice.issued';
