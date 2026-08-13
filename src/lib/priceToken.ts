import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * §8 — `priceToken` is a short-lived signed hash of the priced basket. The
 * app sends it back to POST /orders, which re-prices from the database
 * anyway (§8 RE-PRICING AT SUBMIT) — the token's job is only to let /orders
 * cheaply detect "this doesn't match what /cart/price just quoted" without
 * re-deriving the whole basket from the request body, and to bound how long
 * a quote is honoured.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for checkout, short enough that a stale quote is rare

export type PricedBasketFingerprint = {
  lines: Array<{ variantId: string; quantity: number; unitPrice: number }>;
  fulfillment: 'delivery' | 'curbside';
  promoCode: string | null;
  total: number;
};

function fingerprint(basket: PricedBasketFingerprint): string {
  const canonical = JSON.stringify({
    lines: [...basket.lines].sort((a, b) => a.variantId.localeCompare(b.variantId)),
    fulfillment: basket.fulfillment,
    promoCode: basket.promoCode,
    total: basket.total,
  });
  return canonical;
}

export function signPriceToken(basket: PricedBasketFingerprint): string {
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${expiresAt}.${fingerprint(basket)}`;
  const signature = createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
  return Buffer.from(`${expiresAt}.${signature}`).toString('base64url');
}

export function verifyPriceToken(token: string, basket: PricedBasketFingerprint): boolean {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const [expiresAtStr, signature] = decoded.split('.');
    const expiresAt = Number(expiresAtStr);
    if (!expiresAt || Date.now() > expiresAt) return false;

    const payload = `${expiresAt}.${fingerprint(basket)}`;
    const expected = createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
    return expected === signature;
  } catch {
    return false;
  }
}
