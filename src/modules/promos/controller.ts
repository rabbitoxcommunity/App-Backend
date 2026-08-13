import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { evaluatePromo } from '../cart/service.js';
import { AppError } from '../../lib/errors.js';

export const validateSchema = z.object({
  code: z.string().min(1),
  subtotal: z.number().int().min(0),
});

export const promoBodySchema = z.object({
  code: z.string().min(1),
  discountType: z.enum(['percent', 'fixed']),
  value: z.number().min(0),
  minSubtotal: z.number().int().nullable().optional(),
  categoryIds: z.array(z.string()).nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  maxRedemptions: z.number().int().nullable().optional(),
  perCustomerCap: z.number().int().nullable().optional(),
  active: z.boolean().optional(),
});

export async function validate(req: Request, res: Response): Promise<void> {
  if (!req.ctx.tenantId) throw AppError.unauthenticated();
  const result = await evaluatePromo(
    req.ctx.tenantId,
    req.body.code,
    req.ctx.userId ? String(req.ctx.userId) : null,
    req.body.subtotal,
    [],
  );
  res.json(result);
}

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await service.listPromos(req.ctx.tenantId!));
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await service.createPromo(req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await service.updatePromo(req.params.id!, req.body));
}

export async function remove(req: Request, res: Response): Promise<void> {
  res.json(await service.deletePromo(req.params.id!));
}
