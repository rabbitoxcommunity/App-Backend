import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { AppError } from '../../lib/errors.js';
import { writePlatformAudit } from '../../lib/audit.js';

const localizedSchema = z.object({ en: z.string(), ar: z.string() });
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const onboardSchema = z.object({
  slug: z.string().min(1),
  name: localizedSchema,
  ownerName: z.string().min(1),
  ownerEmail: z.string().email(),
  ownerPhone: z.string().min(6),
  ownerPassword: z.string().min(8),
  storeName: localizedSchema,
  /**
   * Optional: sell a shop straight onto a paid plan. Omit both and it is
   * created on the 14-day trial exactly as before, which is still the right
   * default for a shop that has not signed yet.
   */
  planId: z.string().min(1).optional(),
  expiresAt: z.string().min(1).nullable().optional(),
});

// The bare object is exported too: PATCH needs `.partial()`, which does not
// exist on the refined (ZodEffects) version.
export const planBaseSchema = z.object({
    code: z.string().min(1),
    name: localizedSchema,
    /**
     * The term the plan is sold on. Without this in the schema, `validate()`
     * stripped it from the body — so a plan created through Superadmin was
     * always monthly no matter what the form sent, and `priceYearly` was
     * silently discarded.
     */
    billingPeriod: z.enum(['monthly', 'yearly']).default('monthly'),
    priceMonthly: z.number().int().min(0).default(0),
    priceYearly: z.number().int().min(0).default(0),
    limits: z.object({ products: z.number().optional(), ordersPerMonth: z.number().optional(), staffSeats: z.number().optional() }).optional(),
  features: z.array(z.string()).optional(),
});

// A plan priced at 0 for its own term is almost certainly a mistake reaching
// the database, not a free tier someone meant to create.
export const planSchema = planBaseSchema.superRefine((data, ctx) => {
    const price = data.billingPeriod === 'yearly' ? data.priceYearly : data.priceMonthly;
    if (price <= 0 && data.code !== 'trial') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [data.billingPeriod === 'yearly' ? 'priceYearly' : 'priceMonthly'],
        message: `A ${data.billingPeriod} plan needs a price above zero.`,
      });
    }
  });

export const subscriptionSchema = z.object({
  planId: z.string().min(1),
  /** Optional — omitted means "one full term from today". */
  expiresAt: z.string().datetime().or(z.string().min(1)).nullable().optional(),
});

export const platformUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

export async function listTenants(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.extend({ status: z.string().optional() }).parse(req.query);
  res.json(await service.listTenants(q));
}

export async function getTenant(req: Request, res: Response): Promise<void> {
  res.json(await service.getTenant(req.params.id!));
}

export async function onboard(req: Request, res: Response): Promise<void> {
  const { planId, expiresAt, ...onboardInput } = req.body;
  const result = await service.onboard(onboardInput);

  /**
   * Composed server-side rather than asking the client to make a second call:
   * a shop that got created but never got its plan is the exact state that made
   * billing inert in the first place. Reuses setTenantSubscription so the date
   * defaulting and the plan-limit check live in one place.
   */
  if (planId) {
    await service.setTenantSubscription(result.tenantId, { planId, expiresAt });
  }

  await writePlatformAudit(req, result.tenantId, 'platform.onboard', result.tenantId, {
    slug: { before: null, after: req.body.slug },
    planId: { before: null, after: planId ?? null },
  });
  res.status(201).json(result);
}

export async function configure(req: Request, res: Response): Promise<void> {
  const tenant = await service.configureTenant(req.params.id!, req.body);
  await writePlatformAudit(req, req.params.id!, 'platform.configure', req.params.id!, {
    fields: { before: null, after: Object.keys(req.body) },
  });
  res.json(tenant);
}

export async function setSubscription(req: Request, res: Response): Promise<void> {
  const tenant = await service.setTenantSubscription(req.params.id!, req.body);
  await writePlatformAudit(req, req.params.id!, 'platform.subscription', req.params.id!, {
    planId: { before: null, after: req.body.planId },
    expiresAt: { before: null, after: tenant.plan?.expiresAt ?? null },
  });
  res.json(tenant);
}

export async function suspend(req: Request, res: Response): Promise<void> {
  const tenant = await service.suspendTenant(req.params.id!);
  await writePlatformAudit(req, req.params.id!, 'platform.suspend', req.params.id!);
  res.json(tenant);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const tenant = await service.reactivateTenant(req.params.id!);
  await writePlatformAudit(req, req.params.id!, 'platform.reactivate', req.params.id!);
  res.json(tenant);
}

export async function resetOwnerAccess(req: Request, res: Response): Promise<void> {
  const result = await service.resetOwnerAccess(req.params.id!);
  await writePlatformAudit(req, req.params.id!, 'platform.resetOwnerAccess', req.params.id!);
  res.json(result);
}

export async function impersonate(req: Request, res: Response): Promise<void> {
  if (!req.ctx.userId) throw AppError.unauthenticated();
  const tenant = await service.getTenant(req.params.id!);
  const { User } = await import('../../models/User.js');
  const owner = await User.findOne({ tenantId: tenant._id, role: 'storeAdmin', permissions: 'owner' });
  if (!owner) throw AppError.notFound('Tenant owner account');
  const pair = await service.impersonate(req.params.id!, req.ctx.userId, String(owner._id));
  res.json(pair);
}

export async function listPlans(_req: Request, res: Response): Promise<void> {
  res.json(await service.listPlans());
}
export async function createPlan(req: Request, res: Response): Promise<void> {
  res.status(201).json(await service.createPlan(req.body));
}
export async function updatePlan(req: Request, res: Response): Promise<void> {
  res.json(await service.updatePlan(req.params.id!, req.body));
}
export async function deletePlan(req: Request, res: Response): Promise<void> {
  res.json(await service.deletePlan(req.params.id!));
}

export async function listInvoices(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.extend({ tenantId: z.string().optional(), status: z.string().optional() }).parse(
    req.query,
  );
  res.json(await service.listInvoices(q));
}
export async function issueInvoice(req: Request, res: Response): Promise<void> {
  const invoice = await service.issueInvoice(req.params.id!);
  await writePlatformAudit(req, String(invoice.tenantId), 'platform.invoice.issue', req.params.id!);
  res.json(invoice);
}
export async function markInvoicePaid(req: Request, res: Response): Promise<void> {
  const invoice = await service.markInvoicePaid(req.params.id!, req.body.paymentRef);
  await writePlatformAudit(req, String(invoice.tenantId), 'platform.invoice.markPaid', req.params.id!, {
    paymentRef: { before: null, after: req.body.paymentRef },
  });
  res.json(invoice);
}

export async function analytics(_req: Request, res: Response): Promise<void> {
  res.json(await service.platformAnalytics());
}

export async function auditLog(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.parse(req.query);
  res.json(await service.platformAuditLog(q));
}

export async function listUsers(_req: Request, res: Response): Promise<void> {
  res.json(await service.listPlatformUsers());
}
export async function createUser(req: Request, res: Response): Promise<void> {
  res.status(201).json(await service.createPlatformUser(req.body));
}
