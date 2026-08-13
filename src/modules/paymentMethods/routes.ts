import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { PaymentMethod } from '../../models/PaymentMethod.js';

/**
 * §10 CHECKOUT group — the customer app needs to know which of the three
 * fixed kinds (§4.17) this tenant has enabled and worded, instead of
 * hardcoding the row list. Only enabled rows go out; `enabled`/`sortOrder`
 * stay admin-only concerns.
 */
export const paymentMethodsRouter = Router();

paymentMethodsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.ctx.tenantId) throw AppError.unauthenticated();
    const methods = await PaymentMethod.find({ tenantId: req.ctx.tenantId, enabled: true }).sort({
      sortOrder: 1,
    });
    res.json(methods);
  }),
);
