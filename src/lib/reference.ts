import { randomInt } from 'node:crypto';

/**
 * §9.8 — server-issued order reference, e.g. "FC-2841". Cryptographically
 * random within a 4-digit band, retried on collision by the caller (orders
 * service checks uniqueness inside the placement transaction).
 *
 * EXTENSION BEYOND THE DESIGN DOC: §9.8 hardcodes the "FC-" prefix because
 * it matches the single demo app's fixtures. In genuine multi-tenancy each
 * supermarket is a different business and "FC-" on every receipt would be
 * wrong once a second tenant exists. `prefix` defaults to "FC" so the seeded
 * demo tenant still matches the app's fixtures exactly, but every other
 * tenant is onboarded with its own short prefix (tenant.settings.orderRefPrefix).
 */
export function generateOrderReference(prefix = 'FC'): string {
  const n = randomInt(1000, 10000);
  return `${prefix}-${n}`;
}
