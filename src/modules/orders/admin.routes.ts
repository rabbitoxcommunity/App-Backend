import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { z } from 'zod';
import * as controller from './controller.js';

export const adminOrdersRouter = Router();

adminOrdersRouter.get('/', requireRole('storeAdmin', 'staff'), asyncHandler(controller.adminList));
adminOrdersRouter.get('/:id', requireRole('storeAdmin', 'staff'), asyncHandler(controller.adminGet));
adminOrdersRouter.patch(
  '/:id/status',
  requireRole('storeAdmin', 'staff'),
  validate({ body: controller.statusUpdateSchema }),
  asyncHandler(controller.adminUpdateStatus),
);
adminOrdersRouter.patch(
  '/:id/lines',
  requireRole('storeAdmin', 'staff'),
  validate({ body: controller.linesUpdateSchema }),
  asyncHandler(controller.adminUpdateLines),
);
adminOrdersRouter.post(
  '/:id/verify-code',
  requireRole('storeAdmin', 'staff'),
  validate({ body: controller.verifyCodeSchema }),
  asyncHandler(controller.adminVerifyCode),
);
adminOrdersRouter.post(
  '/:id/rider',
  requireRole('storeAdmin', 'staff'),
  validate({ body: controller.assignRiderSchema }),
  asyncHandler(controller.adminAssignRider),
);
adminOrdersRouter.post(
  '/:id/cancel',
  requireRole('storeAdmin', 'manager'),
  validate({ body: controller.cancelSchema }),
  asyncHandler(controller.adminCancel),
);
adminOrdersRouter.post(
  '/:id/refund',
  requireRole('storeAdmin', 'owner'),
  validate({ body: z.object({ reason: z.string().optional() }) }),
  asyncHandler(controller.adminRefund),
);
