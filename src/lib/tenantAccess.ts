import { AppError } from './errors.js';

/**
 * Days a lapsed subscription keeps working past `expiresAt`.
 *
 * A bank transfer clearing a day or two late must not take a paying shop
 * offline mid-trade, so expiry warns before it bites. Enforcement still
 * happens — it is not a warning-only model — just not on the stroke of
 * midnight.
 */
export const SUBSCRIPTION_GRACE_DAYS = 14;

type TenantLike = {
  status: string;
  plan?: { trialEndsAt?: Date | null; expiresAt?: Date | null } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A trial tenant that's past its `plan.trialEndsAt` is treated as blocked
 * without ever writing `status: 'suspended'` back to the document — status
 * and trial-expiry stay two independent signals. That keeps "extend this
 * trial" a one-field change (push trialEndsAt forward) instead of also
 * having to unwind a stored suspension no one asked for.
 */
export function isTrialExpired(tenant: TenantLike): boolean {
  const trialEndsAt = tenant.plan?.trialEndsAt;
  return tenant.status === 'trial' && !!trialEndsAt && trialEndsAt < new Date();
}

/** True once the paid term AND its grace period have both passed. */
export function isSubscriptionExpired(tenant: TenantLike): boolean {
  const expiresAt = tenant.plan?.expiresAt;
  if (!expiresAt) return false; // no paid term recorded — trial rules apply instead
  return expiresAt.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS < Date.now();
}

/** In grace: the term has lapsed but the shop still works. Surfaced to Superadmin so someone can chase payment before it cuts off. */
export function isInGracePeriod(tenant: TenantLike): boolean {
  const expiresAt = tenant.plan?.expiresAt;
  if (!expiresAt) return false;
  return expiresAt < new Date() && !isSubscriptionExpired(tenant);
}

/** Single gate for "can this tenant be used right now" — staff login, GET /config, and the public shop picker all call this instead of checking `status` themselves. */
export function assertTenantLive(tenant: TenantLike): void {
  if (tenant.status === 'suspended') {
    throw new AppError('TENANT_SUSPENDED', 'This store is currently suspended.');
  }
  if (tenant.status === 'cancelled') {
    throw new AppError('TENANT_SUSPENDED', 'This store is no longer active.');
  }
  if (isTrialExpired(tenant)) {
    throw new AppError('TENANT_SUSPENDED', "This store's trial period has ended.");
  }
  if (isSubscriptionExpired(tenant)) {
    throw new AppError('TENANT_SUSPENDED', "This store's subscription has expired.");
  }
}
