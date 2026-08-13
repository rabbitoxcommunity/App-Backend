import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const adminCreditRouter = Router();

adminCreditRouter.use(requireRole('storeAdmin', 'manager'));

adminCreditRouter.get('/', asyncHandler(controller.exposure));
adminCreditRouter.get('/:customerId/entries', asyncHandler(controller.adminEntries));
adminCreditRouter.post(
  '/:customerId/payment',
  idempotent('credit.payment'),
  validate({ body: controller.paymentSchema }),
  asyncHandler(controller.recordPayment),
);
