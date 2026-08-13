import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** §5.5 — access token claims. */
export type AccessTokenClaims = {
  sub: string; // userId, or platformUsers _id for superAdmin
  role: 'superAdmin' | 'storeAdmin' | 'deliveryStaff' | 'customer';
  grade?: 'owner' | 'manager' | 'staff'; // storeAdmin only
  tenantId?: string; // absent for superAdmin
  jti: string;
  imp?: string; // §10 impersonation — the acting superAdmin's id
};

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenClaims;
}
