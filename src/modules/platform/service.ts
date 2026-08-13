import { Types } from 'mongoose';
import argon2 from 'argon2';
import { Tenant } from '../../models/Tenant.js';
import { Plan } from '../../models/Plan.js';
import { Invoice } from '../../models/Invoice.js';
import { PlatformUser } from '../../models/PlatformUser.js';
import { DailyRollup } from '../../models/DailyRollup.js';
import { AuditLog } from '../../models/AuditLog.js';
import { signAccessToken } from '../../lib/jwt.js';
import { generateOpaqueToken, sha256 } from '../../lib/crypto.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { AppError } from '../../lib/errors.js';
import { onboardTenant, type OnboardTenantInput } from '../tenants/service.js';
import { env } from '../../config/env.js';

export async function listTenants(opts: { page: number; limit: number; status?: string }) {
  const filter: Record<string, unknown> = {};
  if (opts.status) filter.status = opts.status;
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    Tenant.find(filter).skip(skip).limit(opts.limit).sort({ createdAt: -1 }),
    Tenant.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

export async function getTenant(id: string) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

export const onboard = onboardTenant;

export async function configureTenant(id: string, input: Record<string, unknown>) {
  const tenant = await Tenant.findByIdAndUpdate(id, { $set: input }, { new: true });
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

/** §19.4 — SUSPENSION IS A DELIBERATE HUMAN ACTION, never automatic. */
export async function suspendTenant(id: string) {
  const tenant = await Tenant.findByIdAndUpdate(id, { status: 'suspended', suspendedAt: new Date() }, { new: true });
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

export async function reactivateTenant(id: string) {
  const tenant = await Tenant.findByIdAndUpdate(id, { status: 'active', suspendedAt: null }, { new: true });
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

/**
 * §10 impersonate — issues a normal storeAdmin token scoped to the tenant,
 * carrying an `imp` claim naming the acting super admin. Every action it
 * takes writes an audit row attributing BOTH identities (see lib/audit.ts,
 * which reads ctx.impersonatedBy — wire that through tenantContext's JWT
 * decode, already done in middleware/tenantContext.ts).
 */
export async function impersonate(tenantId: string, superAdminId: Types.ObjectId, ownerUserId: string) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant');

  const jti = new Types.ObjectId().toString();
  const accessToken = signAccessToken({
    sub: ownerUserId,
    role: 'storeAdmin',
    grade: 'owner',
    tenantId,
    jti,
    imp: String(superAdminId),
  });

  const refreshPlain = generateOpaqueToken();
  await RefreshToken.create({
    tenantId: new Types.ObjectId(tenantId),
    userId: new Types.ObjectId(ownerUserId),
    tokenHash: sha256(refreshPlain),
    familyId: new Types.ObjectId(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // impersonation sessions are short-lived
  });

  await AuditLog.create({
    tenantId,
    actorId: superAdminId,
    actorRole: 'superAdmin',
    action: 'platform.impersonate',
    collection: 'tenants',
    documentId: tenantId,
    changes: {},
  });

  return { accessToken, refreshToken: refreshPlain };
}

// ------------------------------------------------------------------- plans

export async function listPlans() {
  return Plan.find({}).sort({ priceMonthly: 1 });
}
export async function createPlan(input: {
  code: string;
  name: { en: string; ar: string };
  priceMonthly: number;
  limits?: { products?: number; ordersPerMonth?: number; staffSeats?: number };
  features?: string[];
}) {
  return Plan.create(input);
}
export async function updatePlan(id: string, input: Partial<Parameters<typeof createPlan>[0]>) {
  const plan = await Plan.findByIdAndUpdate(id, input, { new: true });
  if (!plan) throw AppError.notFound('Plan');
  return plan;
}
export async function deletePlan(id: string) {
  const plan = await Plan.findByIdAndUpdate(id, { active: false }, { new: true });
  if (!plan) throw AppError.notFound('Plan');
  return plan;
}

// ---------------------------------------------------------------- invoices

export async function listInvoices(opts: { tenantId?: string; status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (opts.tenantId) filter.tenantId = opts.tenantId;
  if (opts.status) filter.status = opts.status;
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    Invoice.find(filter).skip(skip).limit(opts.limit).sort({ createdAt: -1 }),
    Invoice.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

export async function issueInvoice(id: string) {
  const invoice = await Invoice.findByIdAndUpdate(id, { status: 'issued', issuedAt: new Date() }, { new: true });
  if (!invoice) throw AppError.notFound('Invoice');
  return invoice;
}

/** D14 — payment collection is manual in v1; there is no gateway (D12). */
export async function markInvoicePaid(id: string, paymentRef: string) {
  const invoice = await Invoice.findByIdAndUpdate(
    id,
    { status: 'paid', paidAt: new Date(), paymentRef },
    { new: true },
  );
  if (!invoice) throw AppError.notFound('Invoice');
  return invoice;
}

// -------------------------------------------------------- cross-tenant analytics

export async function platformAnalytics() {
  // Tenant is platform-level (never tenant-scoped) so this needs no opt-out.
  const tenantCounts = await Tenant.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);

  // DailyRollup IS tenant-scoped, so a genuine cross-tenant sum must opt out
  // explicitly via the §1.3 escape hatch — only honoured for role superAdmin.
  const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const dateFrom = last30.toISOString().slice(0, 10);
  const revenue = await DailyRollup.aggregate([
    { $match: { date: { $gte: dateFrom } } },
    { $group: { _id: null, gross: { $sum: '$revenue.gross' }, net: { $sum: '$revenue.net' }, orders: { $sum: '$orders.count' } } },
  ]).option({ skipTenantScope: true } as never);

  return {
    tenantsByStatus: tenantCounts,
    last30Days: revenue[0] ?? { gross: 0, net: 0, orders: 0 },
  };
}

// ------------------------------------------------------------ platform users

export async function listPlatformUsers() {
  return PlatformUser.find({});
}

export async function createPlatformUser(input: { email: string; name: string; password: string }) {
  const passwordHash = await argon2.hash(input.password, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });
  return PlatformUser.create({ email: input.email.toLowerCase(), name: input.name, passwordHash });
}
