import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const addressesRouter = Router();

addressesRouter.use(requireRole('customer'));

addressesRouter.get('/', asyncHandler(controller.list));
addressesRouter.post('/', validate({ body: controller.addressBodySchema }), asyncHandler(controller.create));
addressesRouter.patch(
  '/:id',
  validate({ body: controller.addressBodySchema.partial() }),
  asyncHandler(controller.update),
);
addressesRouter.delete('/:id', asyncHandler(controller.remove));
