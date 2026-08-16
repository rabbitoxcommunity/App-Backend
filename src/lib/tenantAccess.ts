import { AppError } from './errors.js';

type TenantLike = {
  status: string;
  plan?: { trialEndsAt?: Date | null } | null;
};

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
}
