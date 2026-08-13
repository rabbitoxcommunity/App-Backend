import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const deliveryRouter = Router();

deliveryRouter.use(requireRole('deliveryStaff'));

deliveryRouter.get('/orders', asyncHandler(controller.myOrders));
deliveryRouter.post('/orders/:id/accept', asyncHandler(controller.accept));
deliveryRouter.post(
  '/orders/:id/status',
  validate({ body: controller.statusSchema }),
  asyncHandler(controller.updateStatus),
);
deliveryRouter.post(
  '/orders/:id/confirm',
  idempotent('delivery.confirm'),
  validate({ body: controller.confirmSchema }),
  asyncHandler(controller.confirm),
);
deliveryRouter.post(
  '/uploads/sign-proof',
  validate({ body: z.object({ contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']) }) }),
  asyncHandler(controller.signProofUpload),
);
deliveryRouter.patch(
  '/me/availability',
  validate({ body: controller.availabilitySchema }),
  asyncHandler(controller.setAvailability),
);
deliveryRouter.get('/me/summary', asyncHandler(controller.summary));
