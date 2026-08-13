import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import * as service from './service.js';

export const contentRouter = Router();

contentRouter.get(
  '/legal/:type',
  validate({ params: z.object({ type: z.enum(['terms', 'privacy', 'about']) }) }),
  asyncHandler(async (req, res) => {
    if (!req.ctx.tenantId) throw AppError.unauthenticated();
    res.json(await service.getLegalPage(req.ctx.tenantId, req.params.type!));
  }),
);

contentRouter.get(
  '/strings/:lang',
  validate({ params: z.object({ lang: z.enum(['en', 'ar']) }) }),
  asyncHandler(async (req, res) => {
    if (!req.ctx.tenantId) throw AppError.unauthenticated();
    res.json(await service.getStrings(req.ctx.tenantId, req.params.lang as 'en' | 'ar'));
  }),
);
