import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as service from './service.js';

export const adminCurbsideRouter = Router();

adminCurbsideRouter.use(requireRole('storeAdmin', 'staff'));

adminCurbsideRouter.get(
  '/queue',
  asyncHandler(async (req, res) => {
    res.json(await service.arrivalQueue(req.ctx.tenantId!));
  }),
);

adminCurbsideRouter.patch(
  '/orders/:id/bay',
  validate({ body: z.object({ bay: z.number().int().min(0) }) }),
  asyncHandler(async (req, res) => {
    res.json(await service.assignBay(req.ctx.tenantId!, req.params.id!, req.body.bay));
  }),
);
