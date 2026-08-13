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

  io.of(/^\/t\/[a-f0-9]{24}$/).use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Missing token'));
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

  io.of(/^\/t\/[a-f0-9]{24}$/).on('connection', (socket: Socket) => {
    const { role, userId } = socket.data as { role: string; userId: string };

    if (role === 'storeAdmin') {
      socket.join('queue');
    }
    if (role === 'deliveryStaff') {
      socket.join(`rider:${userId}`);
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

/** §14 event emitters — call after the triggering write has committed. */
export const realtime = {
  orderCreated(tenantId: string, order: unknown): void {
    nsp(tenantId)?.to('queue').emit('order.created', order);
  },
  orderStatus(tenantId: string, orderId: string, riderId: string | null, order: unknown): void {
    const rooms = ['queue', `order:${orderId}`];
    if (riderId) rooms.push(`rider:${riderId}`);
    nsp(tenantId)?.to(rooms).emit('order.status', order);
  },
  orderAssigned(tenantId: string, riderId: string, order: unknown): void {
    nsp(tenantId)?.to(['queue', `rider:${riderId}`]).emit('order.assigned', order);
  },
  orderArrived(tenantId: string, order: unknown): void {
    nsp(tenantId)?.to('queue').emit('order.arrived', order);
  },
  orderLines(tenantId: string, orderId: string, order: unknown): void {
    nsp(tenantId)?.to(['queue', `order:${orderId}`]).emit('order.lines', order);
  },
  stockChanged(tenantId: string, variant: unknown): void {
    nsp(tenantId)?.to('queue').emit('stock.changed', variant);
  },
};
