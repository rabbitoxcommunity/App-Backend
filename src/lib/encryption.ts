import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM for at-rest secrets that must be written but never read back
 * over the API — currently just each tenant's payment gateway credentials
 * (Tenant.gateway.credentialsEnc, §4.1). The key is SHA-256'd from
 * ENCRYPTION_KEY rather than used directly, so a misconfigured (wrong-length)
 * env value degrades to "still 32 bytes" instead of a runtime crash.
 */
const key = createHash('sha256').update(env.ENCRYPTION_KEY || 'insecure-dev-key-change-me').digest();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
