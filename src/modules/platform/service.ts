import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import argon2 from 'argon2';
import { Tenant } from '../../models/Tenant.js';
import { Plan } from '../../models/Plan.js';
import { Product } from '../../models/Product.js';
import { Invoice } from '../../models/Invoice.js';
import { PlatformUser } from '../../models/PlatformUser.js';
import { DailyRollup } from '../../models/DailyRollup.js';
import { AuditLog } from '../../models/AuditLog.js';
import { User } from '../../models/User.js';
import { signAccessToken } from '../../lib/jwt.js';
import { generateOpaqueToken, sha256 } from '../../lib/crypto.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { AppError } from '../../lib/errors.js';
import { onboardTenant, type OnboardTenantInput } from '../tenants/service.js';
import { env } from '../../config/env.js';
import { encrypt } from '../../lib/encryption.js';

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
  // `credentialsEnc` is `select: false` (never serialised), so the encrypted
  // blob itself never leaves the server — this just tells the UI whether a
  // "Credentials on file" state should show instead of an empty form.
  const withSecret = await Tenant.findById(id).select('+gateway.credentialsEnc');
  const json = tenant.toJSON() as Record<string, unknown>;
  const gateway = json.gateway as Record<string, unknown> | undefined;
  if (gateway) gateway.hasCredentials = Boolean(withSecret?.gateway?.credentialsEnc);
  return json;
}

export const onboard = onboardTenant;

/**
 * §4.1 — `gateway.credentialsEnc` must never hold plaintext despite the field
 * name suggesting it. The client sends plaintext `apiKey`/`apiSecret` (like
 * any "add payment credentials" form); this is the one place they get
 * encrypted before touching the database, and the field stays `select:
 * false` so a GET can never read it back out either way.
 */
/**
 * Flattens nested plain objects into dot-notation `$set` keys (arrays and
 * Dates pass through whole). A whole-object `$set: { settings: {...} }`
 * would silently wipe every sibling field the caller didn't mention —
 * `settings` alone has a dozen (carColours, orderRefPrefix, ...) that a
 * "just update the delivery fee" PATCH must never touch.
 */
function flattenPatch(input: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(out, flattenPatch(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

export async function configureTenant(id: string, input: Record<string, unknown>) {
  const { gateway, ...rest } = input as { gateway?: { provider?: string | null; apiKey?: string; apiSecret?: string } };
  const patch = flattenPatch(rest);

  if (gateway) {
    patch['gateway.provider'] = gateway.provider ?? null;
    if (gateway.apiKey || gateway.apiSecret) {
      patch['gateway.credentialsEnc'] = encrypt(JSON.stringify({ apiKey: gateway.apiKey, apiSecret: gateway.apiSecret }));
    }
  }

  const tenant = await Tenant.findByIdAndUpdate(id, { $set: patch }, { new: true });
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

/** §19.4 — SUSPENSION IS A DELIBERATE HUMAN ACTION, never automatic. */
/**
 * Puts a shop onto a paid plan, or extends the one it is on.
 *
 * This is the missing half of billing: onboarding always created a 14-day trial
 * with `planId: null`, and nothing anywhere could change that — so no tenant
 * could ever be invoiced. The only way to convert a shop was a hand-written
 * database script.
 *
 * Setting a plan ends the trial. `trialEndsAt` is cleared so the two expiry
 * signals can never both be live and disagree about why a shop is blocked.
 */
export async function setTenantSubscription(
  id: string,
  input: { planId: string; expiresAt?: string | Date | null },
) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw AppError.notFound('Tenant');

  const plan = await Plan.findById(input.planId);
  if (!plan) throw AppError.notFound('Plan');

  // Default term: a year for annual plans, a month for monthly ones. An explicit
  // date always wins, so a mid-cycle or contract-matched term is possible.
  let expiresAt: Date | null = input.expiresAt ? new Date(input.expiresAt) : null;
  if (!expiresAt) {
    expiresAt = new Date();
    if (plan.billingPeriod === 'yearly') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);
  }
  if (Number.isNaN(expiresAt.getTime())) {
    throw AppError.validationFailed({ expiresAt: 'Not a valid date.' });
  }
  if (expiresAt < new Date()) {
    throw AppError.validationFailed({ expiresAt: 'The term end must be in the future.' });
  }

  /**
   * A plan's product limit is only enforced once a plan exists (assertProductLimit
   * returns early when there is none). Attaching one to a shop that already has
   * more products than the plan allows would silently break every product create
   * and every Excel import from that moment — so refuse it here, where it can be
   * explained, rather than at 2am in an import job.
   */
  const productCount = await Product.countDocuments({ tenantId: tenant._id, archivedAt: null });
  if (plan.limits?.products != null && productCount > plan.limits.products) {
    throw new AppError(
      'PLAN_LIMIT_REACHED',
      `This shop has ${productCount} products but the "${plan.name.en}" plan allows ${plan.limits.products}. Raise the plan's product limit first.`,
      { current: productCount, limit: plan.limits.products },
    );
  }

  tenant.plan!.planId = plan._id;
  tenant.plan!.startedAt = tenant.plan!.startedAt ?? new Date();
  tenant.plan!.expiresAt = expiresAt;
  tenant.plan!.trialEndsAt = null;
  if (tenant.status === 'trial') tenant.status = 'active';
  await tenant.save();

  return tenant;
}

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
 * §10 Support — a shop owner locked out (forgotten password, compromised
 * account) gets a fresh one issued by the platform, not a self-service email
 * flow (there's no gateway/email provider wired for that in v1). Every
 * existing refresh token for the account is revoked in the same call, so a
 * stolen session can't outlive the reset.
 */
export async function resetOwnerAccess(tenantId: string) {
  const owner = await User.findOne({ tenantId, role: 'storeAdmin', permissions: 'owner' });
  if (!owner) throw AppError.notFound('Shop owner account');

  const newPassword = randomBytes(9).toString('base64url'); // 12 chars, URL-safe
  owner.passwordHash = await argon2.hash(newPassword, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });
  owner.failedLoginAttempts = 0;
  owner.lockedUntil = null;
  await owner.save();

  await RefreshToken.updateMany({ userId: owner._id, revokedAt: null }, { revokedAt: new Date() });

  return { email: owner.email, temporaryPassword: newPassword };
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
    // `collectionName` is the schema field; `collection` silently isn't, so
    // this required-field write threw — losing the audit row for the single
    // most sensitive action in the platform, after the session was issued.
    collectionName: 'tenants',
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
  const invoice = await Invoice.findById(id);
  if (!invoice) throw AppError.notFound('Invoice');
  // Guarded: this was a bare findByIdAndUpdate, so issuing an already-paid
  // invoice silently knocked it back to `issued` and lost the payment state.
  if (invoice.status !== 'draft') {
    throw new AppError('INVALID_TRANSITION', `Only a draft invoice can be issued — this one is "${invoice.status}".`);
  }
  invoice.status = 'issued';
  invoice.issuedAt = new Date();
  await invoice.save();
  return invoice;
}

/**
 * D14 — payment collection is manual in v1; there is no gateway (D12).
 *
 * Recording payment on an annual invoice is also what RENEWS the subscription:
 * it pushes `tenant.plan.expiresAt` forward a year from its own previous value,
 * never from today. Paying eight days late therefore costs the shop those eight
 * days rather than shifting every future anniversary later.
 */
export async function markInvoicePaid(id: string, paymentRef: string) {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw AppError.notFound('Invoice');
  if (invoice.status === 'paid') {
    throw new AppError('INVALID_TRANSITION', 'This invoice is already marked paid.');
  }
  if (invoice.status === 'void') {
    throw new AppError('INVALID_TRANSITION', 'This invoice has been voided.');
  }

  invoice.status = 'paid';
  invoice.paidAt = new Date();
  invoice.paymentRef = paymentRef;
  await invoice.save();

  const tenant = await Tenant.findById(invoice.tenantId);
  if (tenant?.plan?.planId) {
    const plan = await Plan.findById(tenant.plan.planId);
    if (plan?.billingPeriod === 'yearly') {
      // Extend from the existing term end when there is one, so anniversaries
      // hold; otherwise this is the first term and it starts now.
      const base = tenant.plan.expiresAt ?? new Date();
      const next = new Date(base);
      next.setFullYear(next.getFullYear() + 1);
      tenant.plan.expiresAt = next;
      await tenant.save();
    }
  }

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

  // Day-by-day, summed across every tenant — the Overview/Analytics growth
  // charts read this. Days with no rollup row for any tenant simply don't
  // appear; the client fills gaps rather than the server fabricating zeros.
  const series = await DailyRollup.aggregate([
    { $match: { date: { $gte: dateFrom } } },
    { $group: { _id: '$date', orders: { $sum: '$orders.count' }, revenue: { $sum: '$revenue.net' } } },
    { $sort: { _id: 1 } },
  ]).option({ skipTenantScope: true } as never);

  // Revenue by shop, for the "which shops are growing" / order-volume-by-shop
  // views — same 30-day window, grouped the other way.
  const byTenant = await DailyRollup.aggregate([
    { $match: { date: { $gte: dateFrom } } },
    { $group: { _id: '$tenantId', orders: { $sum: '$orders.count' }, revenue: { $sum: '$revenue.net' } } },
    { $sort: { revenue: -1 } },
  ]).option({ skipTenantScope: true } as never);
  const tenantIds = byTenant.map((t) => t._id);
  const tenants = tenantIds.length ? await Tenant.find({ _id: { $in: tenantIds } }, { name: 1, slug: 1 }) : [];
  const tenantById = new Map(tenants.map((t) => [String(t._id), t]));

  return {
    tenantsByStatus: tenantCounts,
    last30Days: revenue[0] ?? { gross: 0, net: 0, orders: 0 },
    series: series.map((s) => ({ date: s._id, orders: s.orders, revenue: s.revenue })),
    byTenant: byTenant.map((t) => ({
      tenantId: String(t._id),
      name: tenantById.get(String(t._id))?.name ?? null,
      slug: tenantById.get(String(t._id))?.slug ?? null,
      orders: t.orders,
      revenue: t.revenue,
    })),
  };
}

// --------------------------------------------------------------- audit trail

/** §19 — cross-tenant read of platform-level actions, for the Support screen. */
export async function platformAuditLog(opts: { page: number; limit: number }) {
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    AuditLog.find({ action: { $regex: '^platform\\.' } })
      .setOptions({ skipTenantScope: true })
      .sort({ at: -1 })
      .skip(skip)
      .limit(opts.limit),
    AuditLog.countDocuments({ action: { $regex: '^platform\\.' } }).setOptions({ skipTenantScope: true }),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
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
