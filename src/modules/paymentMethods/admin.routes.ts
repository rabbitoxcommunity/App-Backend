import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { writeAudit } from '../../lib/audit.js';
import { PaymentMethod } from '../../models/PaymentMethod.js';
import { AppError } from '../../lib/errors.js';

/**
 * ADMIN GAP FILL — the Settings screen shows enable/disable state for card,
 * credit and cash, but nothing exposed it for editing. `kind` stays a
 * CLOSED enum (§4.17 rule) — this only ever enables/disables/reorders/
 * re-words the three rows the tenant is seeded with, never creates a new one.
 */
export const adminPaymentMethodsRouter = Router();

adminPaymentMethodsRouter.get(
  '/',
  requireRole('storeAdmin', 'staff'),
  asyncHandler(async (req, res) => {
    const methods = await PaymentMethod.find({ tenantId: req.ctx.tenantId }).sort({ sortOrder: 1 });
    res.json(methods);
  }),
);

const updateSchema = z.object({
  title: z.object({ en: z.string(), ar: z.string() }).optional(),
  subtitle: z.object({ en: z.string(), ar: z.string() }).nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
  availableFor: z.array(z.enum(['delivery', 'curbside'])).optional(),
});

adminPaymentMethodsRouter.patch(
  '/:id',
  requireRole('storeAdmin', 'manager'),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const method = await PaymentMethod.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.ctx.tenantId },
      req.body,
      { new: true },
    );
    if (!method) throw AppError.notFound('Payment method');
    await writeAudit(req, 'paymentMethod.update', 'paymentMethods', req.params.id!, {
      fields: { before: null, after: Object.keys(req.body) },
    });
    res.json(method);
  }),
);
