import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate as validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const promoPublicRouter = Router();

promoPublicRouter.post(
  '/promo/validate',
  requireRole('customer'),
  validateBody({ body: controller.validateSchema }),
  asyncHandler(controller.validate),
);
