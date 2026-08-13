import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as service from './service.js';

export const adminAnalyticsRouter = Router();

const rangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

adminAnalyticsRouter.get(
  '/today',
  requireRole('storeAdmin', 'staff'),
  asyncHandler(async (req, res) => res.json(await service.today(req.ctx.tenantId!))),
);

adminAnalyticsRouter.get(
  '/summary',
  requireRole('storeAdmin', 'manager'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    res.json(await service.summary(req.ctx.tenantId!, from, to));
  }),
);

adminAnalyticsRouter.get(
  '/products',
  requireRole('storeAdmin', 'manager'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    res.json(await service.topProducts(req.ctx.tenantId!, from, to));
  }),
);

adminAnalyticsRouter.get(
  '/categories',
  requireRole('storeAdmin', 'manager'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    res.json(await service.categoryPerformance(req.ctx.tenantId!, from, to));
  }),
);

adminAnalyticsRouter.get(
  '/customers',
  requireRole('storeAdmin', 'manager'),
  asyncHandler(async (req, res) => res.json(await service.rfmCustomers(req.ctx.tenantId!))),
);

adminAnalyticsRouter.get(
  '/search-gaps',
  requireRole('storeAdmin', 'manager'),
  asyncHandler(async (req, res) => {
    const q = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(20) }).parse(
      req.query,
    );
    res.json(await service.searchGaps(req.ctx.tenantId!, q));
  }),
);
