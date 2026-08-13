import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';

/**
 * §1.3 of the design doc. Held for the life of one request and read by the
 * tenant-isolation Mongoose plugin (plugins/tenantScope.ts) so no query can
 * forget which tenant it belongs to.
 */
export type RequestContext = {
  tenantId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
  role: 'superAdmin' | 'storeAdmin' | 'deliveryStaff' | 'customer' | null;
  grade: 'owner' | 'manager' | 'staff' | null;
  requestId: string;
  /** Set by platform/tenants/:id/impersonate — audited on every write. */
  impersonatedBy: Types.ObjectId | null;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Used by the isolation plugin. Throws rather than silently scanning every
 * tenant's data — see §1.3 "fails closed".
 */
export function requireTenantId(): Types.ObjectId {
  const ctx = storage.getStore();
  if (!ctx || !ctx.tenantId) {
    throw new Error(
      'No tenantId in request context. A tenant-scoped query ran outside tenantContext ' +
        'middleware, or a superAdmin action forgot to pass an explicit tenantId.',
    );
  }
  return ctx.tenantId;
}
