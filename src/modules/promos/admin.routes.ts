import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const adminPromosRouter = Router();

adminPromosRouter.use(requireRole('storeAdmin', 'manager'));

adminPromosRouter.get('/', asyncHandler(controller.list));
adminPromosRouter.post('/', validate({ body: controller.promoBodySchema }), asyncHandler(controller.create));
adminPromosRouter.patch(
  '/:id',
  validate({ body: controller.promoBodySchema.partial() }),
  asyncHandler(controller.update),
);
adminPromosRouter.delete('/:id', asyncHandler(controller.remove));
