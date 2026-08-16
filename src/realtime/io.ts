import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../lib/jwt.js';
import { logger } from '../config/logger.js';

/**
 * §14 REALTIME. One namespace per tenant (`/t/<tenantId>`), joined only with
 * a valid JWT whose tenantId matches — the same isolation check as HTTP,
 * because a socket is an authenticated channel and leaks the same data if
 * it isn't checked.
 *
 * RULE (§14): sockets carry NOTIFICATIONS, never authority. A client that
 * misses an event must reach the same state by re-fetching. Nothing here is
 * the only source of a value — every emit below mirrors state already
 * committed to MongoDB before the emit happens.
 */

let io: Server | null = null;

export function attachSocketServer(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: true, credentials: true },
  });

  // MUST be a single `io.of(regex)` instance shared by both the middleware and
  // the connection handler. Each `io.of(regex)` call constructs a SEPARATE
  // ParentNamespace; the first one to match a connecting client is the one that
  // spawns the child namespace, so handlers registered on any other instance
  // never fire for that child. Registering `.use()` and `.on('connection')` on
  // two different instances silently skipped every `socket.join(...)` below —
  // auth still ran, but no socket ever joined `queue`/`rider:`/`customer:`, so
  // every room-targeted emit (i.e. all order events) reached nobody.
  const tenantNsp = io.of(/^\/t\/[a-f0-9]{24}$/);

  tenantNsp.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    // Anonymous connections are allowed: categories/products/payment methods
    // are already public, unauthenticated REST data (§10), so a customer
    // browsing before login still gets live storefront updates. They get no
    // role and join no rooms, so they only ever receive namespace-wide
    // broadcasts — never `queue`, `rider:<id>`, or `customer:<id>`.
    if (!token) {
      socket.data.role = null;
      socket.data.userId = null;
      return next();
    }
    try {
      const claims = verifyAccessToken(token);
      const namespaceTenantId = socket.nsp.name.split('/t/')[1];
      if (claims.role !== 'superAdmin' && claims.tenantId !== namespaceTenantId) {
        return next(new Error('Tenant mismatch'));
      }
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  tenantNsp.on('connection', (socket: Socket) => {
    const { role, userId } = socket.data as { role: string | null; userId: string | null };

    if (role === 'storeAdmin') {
      socket.join('queue');
    }
    if (role === 'deliveryStaff') {
      socket.join(`rider:${userId}`);
    }
    // Credit balance is private — only this customer's own connections (and
    // the admin queue) should receive `credit.changed`.
    if (role === 'customer') {
      socket.join(`customer:${userId}`);
    }

    socket.on('order:watch', (orderId: string) => {
      socket.join(`order:${orderId}`);
    });
    socket.on('order:unwatch', (orderId: string) => {
      socket.leave(`order:${orderId}`);
    });
  });

  logger.info('Socket.io attached');
  return io;
}

/**
 * Returns null rather than throwing when Socket.io hasn't been attached —
 * true for the seed script, unit tests, and any one-off script that imports
 * a service module without booting the HTTP server. §14's own rule is that
 * sockets carry notifications, never authority, so a missing socket layer
 * must never be able to break a write that already committed to MongoDB.
 */
function nsp(tenantId: string) {
  if (!io) return null;
  return io.of(`/t/${tenantId}`);
}

/**
 * The owning customer's private room, read off the emitted order itself.
 *
 * Without this, a customer only received events for orders whose
 * `order:<id>` room they had explicitly joined via `order:watch` — and the
 * app only ever watches ONE order at a time. A customer with several orders
 * in flight silently got no updates for any but that one. Every customer
 * connection already joins `customer:<userId>` on connect, so routing here
 * covers all of their orders with no per-order subscription bookkeeping.
 */
function customerRoom(order: unknown): string | null {
  const customerId = (order as { customerId?: unknown } | null)?.customerId;
  return customerId ? `customer:${String(customerId)}` : null;
}

/** §14 event emitters — call after the triggering write has committed. */
export const realtime = {
  orderCreated(tenantId: string, order: unknown): void {
    const rooms = ['queue', customerRoom(order)].filter(Boolean) as string[];
    nsp(tenantId)?.to(rooms).emit('order.created', order);
  },
  orderStatus(tenantId: string, orderId: string, riderId: string | null, order: unknown): void {
    const rooms = ['queue', `order:${orderId}`, customerRoom(order)].filter(Boolean) as string[];
    if (riderId) rooms.push(`rider:${riderId}`);
    nsp(tenantId)?.to(rooms).emit('order.status', order);
  },
  orderAssigned(tenantId: string, riderId: string, order: unknown): void {
    const rooms = ['queue', `rider:${riderId}`, customerRoom(order)].filter(Boolean) as string[];
    nsp(tenantId)?.to(rooms).emit('order.assigned', order);
  },
  orderArrived(tenantId: string, order: unknown): void {
    const rooms = ['queue', customerRoom(order)].filter(Boolean) as string[];
    nsp(tenantId)?.to(rooms).emit('order.arrived', order);
  },
  /** §9 curbside — the customer's "on the way" / "near" ping, distinct from the customer_arrived status transition above. */
  orderArrival(tenantId: string, orderId: string, order: unknown): void {
    const rooms = ['queue', `order:${orderId}`, customerRoom(order)].filter(Boolean) as string[];
    nsp(tenantId)?.to(rooms).emit('order.arrival', order);
  },
  orderLines(tenantId: string, orderId: string, order: unknown): void {
    const rooms = ['queue', `order:${orderId}`, customerRoom(order)].filter(Boolean) as string[];
    nsp(tenantId)?.to(rooms).emit('order.lines', order);
  },
  /** Stock is already public via the product REST endpoints, so this reaches everyone — admin queue and browsing customers alike. */
  stockChanged(tenantId: string, variant: unknown): void {
    nsp(tenantId)?.emit('stock.changed', variant);
  },
  categoryChanged(tenantId: string, category: unknown): void {
    nsp(tenantId)?.emit('category.changed', category);
  },
  productChanged(tenantId: string, product: unknown): void {
    nsp(tenantId)?.emit('product.changed', product);
  },
  paymentMethodChanged(tenantId: string, method: unknown): void {
    nsp(tenantId)?.emit('payment-method.changed', method);
  },
  /** Private to the customer whose balance changed, plus the admin queue (Credit/Customers screens). */
  creditChanged(tenantId: string, customerId: string, account: unknown): void {
    nsp(tenantId)?.to(['queue', `customer:${customerId}`]).emit('credit.changed', account);
  },
};
