import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import * as service from './service.js';

export const merchandisingPublicRouter = Router();

merchandisingPublicRouter.get(
  '/home',
  asyncHandler(async (req, res) => {
    if (!req.ctx.tenantId) throw AppError.unauthenticated();
    res.json(await service.getHome(req.ctx.tenantId));
  }),
);
