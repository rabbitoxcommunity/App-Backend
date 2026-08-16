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
});

export const planSchema = z.object({
  code: z.string().min(1),
  name: localizedSchema,
  priceMonthly: z.number().int().min(0),
  limits: z.object({ products: z.number().optional(), ordersPerMonth: z.number().optional(), staffSeats: z.number().optional() }).optional(),
  features: z.array(z.string()).optional(),
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
  const result = await service.onboard(req.body);
  await writePlatformAudit(req, result.tenantId, 'platform.onboard', result.tenantId, {
    slug: { before: null, after: req.body.slug },
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
