/**
 * §20.4 PHONE — E.164 normalisation, UAE default region.
 * "+971 50 214 8873", "050 214 8873" and "971502148873" all normalise to
 * the same customer.
 *
 * This is a minimal UAE-only normaliser, not a full libphonenumber
 * replacement — sufficient for a single-region v1. Revisit if a tenant
 * outside the UAE is onboarded.
 */
const UAE_COUNTRY_CODE = '971';

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  if (digits.startsWith(UAE_COUNTRY_CODE)) {
    return `+${digits}`;
  }
  if (digits.startsWith('0')) {
    return `+${UAE_COUNTRY_CODE}${digits.slice(1)}`;
  }
  if (digits.length === 9) {
    // Bare local number without the leading 0, e.g. "502148873".
    return `+${UAE_COUNTRY_CODE}${digits}`;
  }
  return `+${digits}`;
}

export function isValidUaePhone(e164: string): boolean {
  return /^\+9715\d{8}$/.test(e164);
}
