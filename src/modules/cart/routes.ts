import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit, byUser } from '../../middleware/rateLimit.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const cartRouter = Router();

// §22 — 60 per minute per customer.
cartRouter.post(
  '/price',
  requireRole('customer'),
  rateLimit({ windowSeconds: 60, max: 60, keyFn: byUser }),
  validate({ body: controller.cartPriceSchema }),
  asyncHandler(controller.priceCart),
);
