import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { NotifyRequest } from '../../models/NotifyRequest.js';
import { Product } from '../../models/Product.js';
import { AppError } from '../../lib/errors.js';

export const notificationsRouter = Router();

const notifyRequestSchema = z.object({ variantId: z.string().min(1) });

// §10 CATALOG group — POST /notify-requests, back-in-stock (CMS-SCOPE module 12).
notificationsRouter.post(
  '/notify-requests',
  requireRole('customer'),
  validate({ body: notifyRequestSchema }),
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({ 'variants._id': req.body.variantId });
    if (!product) throw AppError.notFound('Variant');

    await NotifyRequest.findOneAndUpdate(
      { tenantId: req.ctx.tenantId, customerId: req.ctx.userId, variantId: req.body.variantId },
      { tenantId: req.ctx.tenantId, customerId: req.ctx.userId, variantId: req.body.variantId, productId: product._id },
      { upsert: true, setDefaultsOnInsert: true },
    );
    res.status(201).json({ ok: true });
  }),
);
