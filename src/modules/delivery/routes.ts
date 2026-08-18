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
// Open pool — any rider on the tenant may take any unclaimed delivery order.
deliveryRouter.post('/orders/:id/claim', asyncHandler(controller.claim));
// POST and PATCH both accepted on the status route, and the confirm route
// answers to both `/confirm` and `/confirm-delivery`. The delivery PWA's
// spec names the pair `PATCH .../status` and `POST .../confirm-delivery`;
// the shorter forms are what shipped first. Same handlers either way.
deliveryRouter.route('/orders/:id/status').post(
  validate({ body: controller.statusSchema }),
  asyncHandler(controller.updateStatus),
).patch(
  validate({ body: controller.statusSchema }),
  asyncHandler(controller.updateStatus),
);

for (const path of ['/orders/:id/confirm', '/orders/:id/confirm-delivery']) {
  deliveryRouter.post(
    path,
    idempotent('delivery.confirm'),
    validate({ body: controller.confirmSchema }),
    asyncHandler(controller.confirm),
  );
}
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
