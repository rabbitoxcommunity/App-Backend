import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP, minimal implementation — no external dependency needed for
 * one check on one login route (§5.4, superAdmin login requires TOTP).
 * 30-second step, 6 digits, SHA-1 (the near-universal authenticator default).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Decode(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * A real RFC4648 base32 encoding: 5 bits at a time across the whole byte
 * buffer, zero-padding only the trailing partial group. The previous version
 * of this function picked one independently-random symbol per source byte
 * instead — valid base32 *alphabet*, but not a valid base32 *encoding*, since
 * a properly-encoded value's final symbol must have zero, not random,
 * padding bits. Strict authenticator apps validate that and reject it as
 * "invalid key" — exactly what real base32 encoding avoids.
 */
function base32Encode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  // Pad the final group with zeros up to a multiple of 5 bits.
  while (bits.length % 5 !== 0) bits += '0';

  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

/** 10 bytes -> 16 base32 characters, byte-aligned with no partial final group — the same secret length Google Authenticator itself generates. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(10));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac.at(-1)! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Accepts the current 30s window and one step of clock drift either way. */
export function verifyTotp(base32Secret: string, token: string): boolean {
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    if (hotp(secret, counter + drift) === token) return true;
  }
  return false;
}
