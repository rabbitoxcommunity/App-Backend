import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { rateLimit, byUser } from '../../middleware/rateLimit.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const ordersRouter = Router();

ordersRouter.use(requireRole('customer'));

// §22 — 10 per minute per customer.
ordersRouter.post(
  '/',
  rateLimit({ windowSeconds: 60, max: 10, keyFn: byUser }),
  idempotent('orders.place'),
  validate({ body: controller.placeOrderSchema }),
  asyncHandler(controller.place),
);
ordersRouter.get('/', asyncHandler(controller.list));
ordersRouter.get('/:id', asyncHandler(controller.get));
ordersRouter.get('/:id/receipt', asyncHandler(controller.receipt));
ordersRouter.post('/:id/arrived', asyncHandler(controller.arrived));
ordersRouter.patch(
  '/:id/arrival',
  validate({ body: controller.arrivalSchema }),
  asyncHandler(controller.updateArrival),
);
ordersRouter.post('/:id/cancel', validate({ body: controller.cancelSchema }), asyncHandler(controller.cancel));
