import { randomInt, randomBytes, createHash } from 'node:crypto';

/** §9.4 — cryptographically random, not Math.random (CMS-SCOPE §2, HIGH). */
export function generateConfirmationCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

/** §5.3 — 4-digit OTP, matches the app's 4-box input. */
export function generateOtpCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

/** §5.5 — opaque refresh token, stored hashed. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
