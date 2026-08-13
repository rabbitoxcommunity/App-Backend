import argon2 from 'argon2';
import { Types } from 'mongoose';
import { User } from '../../models/User.js';
import { OtpChallenge } from '../../models/OtpChallenge.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { PlatformUser } from '../../models/PlatformUser.js';
import { Tenant } from '../../models/Tenant.js';
import { getOtpProvider } from '../../lib/otpProvider.js';
import { generateOtpCode, generateOpaqueToken, sha256 } from '../../lib/crypto.js';
import { signAccessToken, type AccessTokenClaims } from '../../lib/jwt.js';
import { normalizePhone, isValidUaePhone } from '../../lib/phone.js';
import { verifyTotp } from '../../lib/totp.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const REFRESH_TTL_MS = env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

type TokenPair = { accessToken: string; refreshToken: string };

async function issueTokenPair(
  claims: Omit<AccessTokenClaims, 'jti'>,
  opts: { tenantId: Types.ObjectId | null; familyId?: Types.ObjectId; userAgent?: string; ip?: string },
): Promise<TokenPair> {
  const jti = new Types.ObjectId().toString();
  const accessToken = signAccessToken({ ...claims, jti });

  const refreshPlain = generateOpaqueToken();
  const familyId = opts.familyId ?? new Types.ObjectId();

  await RefreshToken.create({
    tenantId: opts.tenantId,
    userId: new Types.ObjectId(claims.sub),
    tokenHash: sha256(refreshPlain),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    userAgent: opts.userAgent ?? '',
    ip: opts.ip ?? '',
  });

  return { accessToken, refreshToken: refreshPlain };
}

// ---------------------------------------------------------------- customer OTP

export async function requestOtp(
  tenantId: Types.ObjectId,
  rawPhone: string,
  channel: 'sms' | 'whatsapp',
): Promise<{ challengeId: string; expiresIn: number }> {
  const phone = normalizePhone(rawPhone);
  if (!isValidUaePhone(phone)) {
    throw AppError.validationFailed({ phone: 'Not a valid UAE phone number.' });
  }

  const code = generateOtpCode();
  const codeHash = await argon2.hash(code);

  const challenge = await OtpChallenge.create({
    tenantId,
    phone,
    codeHash,
    channel,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  await getOtpProvider().send(phone, code, channel);

  return { challengeId: String(challenge._id), expiresIn: OTP_TTL_MS / 1000 };
}

export async function verifyOtp(
  tenantId: Types.ObjectId,
  challengeId: string,
  code: string,
  meta: { userAgent?: string; ip?: string },
): Promise<TokenPair & { user: InstanceType<typeof User> }> {
  if (!Types.ObjectId.isValid(challengeId)) {
    throw new AppError('OTP_INVALID', 'Unknown challenge.');
  }

  const challenge = await OtpChallenge.findOne({ _id: challengeId, tenantId }).select('+codeHash');
  if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
    throw new AppError('OTP_EXPIRED', 'This code has expired. Request a new one.');
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts.');
  }

  const valid = await argon2.verify(challenge.codeHash, code);
  if (!valid) {
    challenge.attempts += 1;
    await challenge.save();
    throw new AppError('OTP_INVALID', 'Incorrect code.');
  }

  challenge.consumedAt = new Date();
  await challenge.save();

  let user = await User.findOne({ tenantId, phone: challenge.phone, role: 'customer' });
  if (!user) {
    user = await User.create({
      tenantId,
      role: 'customer',
      name: 'New Customer',
      phone: challenge.phone,
    });
  }
  if (user.status === 'blocked') {
    throw new AppError('ACCOUNT_BLOCKED', 'This account has been blocked.');
  }

  user.lastLoginAt = new Date();
  await user.save();

  const pair = await issueTokenPair(
    { sub: String(user._id), role: 'customer', tenantId: String(tenantId) },
    { tenantId, userAgent: meta.userAgent, ip: meta.ip },
  );

  return { ...pair, user };
}

// ------------------------------------------------------------- refresh rotation

/**
 * §5.5 — rotating refresh tokens with reuse detection. A rotated token
 * presented again means it was stolen: the entire family is revoked and the
 * caller must re-authenticate from scratch.
 */
export async function refreshTokenPair(
  refreshPlain: string,
  meta: { userAgent?: string; ip?: string },
): Promise<TokenPair> {
  const tokenHash = sha256(refreshPlain);
  const row = await RefreshToken.findOne({ tokenHash });

  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    throw new AppError('UNAUTHENTICATED', 'Refresh token is invalid or expired.');
  }

  if (row.replacedBy) {
    // Reuse of an already-rotated token — assume theft, burn the family.
    await RefreshToken.updateMany({ familyId: row.familyId, revokedAt: null }, { revokedAt: new Date() });
    throw new AppError('TOKEN_REUSED', 'This refresh token was already used. All sessions revoked.');
  }

  let claims: Omit<AccessTokenClaims, 'jti'>;

  if (row.tenantId) {
    // Filter already carries an explicit tenantId, so the isolation plugin
    // trusts it without needing request context (there is none yet here —
    // this runs before any tenant is known to this request).
    const found = await User.findOne({ _id: row.userId, tenantId: row.tenantId });
    if (!found || found.status === 'blocked') {
      throw new AppError('UNAUTHENTICATED', 'Account is no longer active.');
    }
    claims = {
      sub: String(found._id),
      role: found.role as AccessTokenClaims['role'],
      grade: found.permissions as AccessTokenClaims['grade'],
      tenantId: String(row.tenantId),
    };
  } else {
    const admin = await PlatformUser.findById(row.userId);
    if (!admin || !admin.active) {
      throw new AppError('UNAUTHENTICATED', 'Account is no longer active.');
    }
    claims = { sub: String(admin._id), role: 'superAdmin' };
  }

  const newPair = await issueTokenPair(claims, {
    tenantId: row.tenantId ?? null,
    familyId: row.familyId,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  const newHash = sha256(newPair.refreshToken);
  const newRow = await RefreshToken.findOne({ tokenHash: newHash });
  row.replacedBy = newRow?._id ?? null;
  await row.save();

  return newPair;
}

export async function revokeRefreshToken(refreshPlain: string): Promise<void> {
  await RefreshToken.updateOne({ tokenHash: sha256(refreshPlain) }, { revokedAt: new Date() });
}

// ------------------------------------------------------------------ staff login

const LOCK_THRESHOLD = 10;
const LOCK_MINUTES = 15;

export async function staffLogin(
  tenantSlug: string,
  email: string,
  password: string,
  meta: { userAgent?: string; ip?: string },
): Promise<TokenPair & { user: InstanceType<typeof User> }> {
  const tenant = await Tenant.findOne({ slug: tenantSlug.toLowerCase() });
  if (!tenant) throw AppError.notFound('Tenant');
  if (tenant.status === 'suspended') {
    throw new AppError('TENANT_SUSPENDED', 'This store is currently suspended.');
  }

  const user = await User.findOne({
    tenantId: tenant._id,
    email: email.toLowerCase(),
    role: { $in: ['storeAdmin', 'deliveryStaff'] },
  }).select('+passwordHash');

  if (!user || !user.passwordHash) throw AppError.unauthenticated('Invalid email or password.');

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= LOCK_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    throw AppError.unauthenticated('Invalid email or password.');
  }

  if (user.status !== 'active') {
    throw new AppError('ACCOUNT_BLOCKED', 'This account is not active.');
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  const pair = await issueTokenPair(
    {
      sub: String(user._id),
      role: user.role as AccessTokenClaims['role'],
      grade: user.permissions as AccessTokenClaims['grade'],
      tenantId: String(tenant._id),
    },
    { tenantId: tenant._id, userAgent: meta.userAgent, ip: meta.ip },
  );

  // Fetched with .select('+passwordHash') above to verify the password —
  // must not leak the hash in the response. No further .save() happens
  // after this, so clearing it in-memory doesn't affect what's persisted.
  user.passwordHash = null;
  return { ...pair, user };
}

// --------------------------------------------------------------- platform login

export async function platformLogin(
  email: string,
  password: string,
  totp: string,
  meta: { userAgent?: string; ip?: string },
): Promise<TokenPair> {
  const admin = await PlatformUser.findOne({ email: email.toLowerCase() }).select(
    '+passwordHash +mfaSecret',
  );
  if (!admin) throw AppError.unauthenticated('Invalid credentials.');

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }

  const valid = await argon2.verify(admin.passwordHash, password);
  if (!valid || !admin.active) {
    admin.failedLoginAttempts += 1;
    if (admin.failedLoginAttempts >= LOCK_THRESHOLD) {
      admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      admin.failedLoginAttempts = 0;
    }
    await admin.save();
    throw AppError.unauthenticated('Invalid credentials.');
  }

  if (!admin.mfaSecret || !verifyTotp(admin.mfaSecret, totp)) {
    throw AppError.unauthenticated('Invalid authenticator code.');
  }

  admin.failedLoginAttempts = 0;
  admin.lockedUntil = null;
  admin.lastLoginAt = new Date();
  await admin.save();

  return issueTokenPair(
    { sub: String(admin._id), role: 'superAdmin' },
    { tenantId: null, userAgent: meta.userAgent, ip: meta.ip },
  );
}
