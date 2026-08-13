import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { AppError } from '../../lib/errors.js';

export const cartPriceSchema = z.object({
  lines: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1) })),
  promoCode: z.string().optional(),
  fulfillment: z.enum(['delivery', 'curbside']),
  addressId: z.string().optional(),
});

export async function priceCart(req: Request, res: Response): Promise<void> {
  if (!req.ctx.tenantId) throw AppError.unauthenticated();
  const result = await service.priceBasket(
    req.ctx.tenantId,
    req.ctx.userId ? String(req.ctx.userId) : null,
    req.body,
  );
  res.json(result);
}
