import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as service from './service.js';

export const adminMerchandisingRouter = Router();

adminMerchandisingRouter.use(requireRole('storeAdmin', 'manager'));

const merchandisingSchema = z.object({
  popularProductIds: z.array(z.string()).optional(),
  trendingSearches: z.array(z.object({ en: z.string(), ar: z.string() })).optional(),
  categoryOrder: z.array(z.string()).optional(),
});

adminMerchandisingRouter.put(
  '/merchandising',
  validate({ body: merchandisingSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateMerchandising(req.ctx.tenantId!, req.body));
  }),
);

const bannerSchema = z.object({
  imageUrl: z.string().min(1),
  linkType: z.enum(['category', 'product', 'none']).optional(),
  linkId: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  active: z.boolean().optional(),
});

adminMerchandisingRouter.get(
  '/banners',
  asyncHandler(async (req, res) => res.json(await service.listBanners(req.ctx.tenantId!))),
);
adminMerchandisingRouter.post(
  '/banners',
  validate({ body: bannerSchema }),
  asyncHandler(async (req, res) => res.status(201).json(await service.createBanner(req.body))),
);
adminMerchandisingRouter.patch(
  '/banners/:id',
  validate({ body: bannerSchema.partial() }),
  asyncHandler(async (req, res) => res.json(await service.updateBanner(req.params.id!, req.body))),
);
adminMerchandisingRouter.delete(
  '/banners/:id',
  asyncHandler(async (req, res) => res.json(await service.deleteBanner(req.params.id!))),
);
