import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';
import { z } from 'zod';

export const adminCatalogRouter = Router();

// §5.2 permission matrix — catalogue writes need manager; stock toggle and
// barcode lookup are staff-level (QuickStock is used on the shop floor).

adminCatalogRouter.post(
  '/categories',
  requireRole('storeAdmin', 'manager'),
  validate({ body: controller.categoryBodySchema }),
  asyncHandler(controller.createCategory),
);
adminCatalogRouter.patch(
  '/categories/:id',
  requireRole('storeAdmin', 'manager'),
  validate({ body: controller.categoryBodySchema.partial() }),
  asyncHandler(controller.updateCategory),
);
adminCatalogRouter.delete(
  '/categories/:id',
  requireRole('storeAdmin', 'manager'),
  asyncHandler(controller.archiveCategory),
);

adminCatalogRouter.post(
  '/products',
  requireRole('storeAdmin', 'manager'),
  validate({ body: controller.productBodySchema }),
  asyncHandler(controller.createProduct),
);
adminCatalogRouter.patch(
  '/products/:id',
  requireRole('storeAdmin', 'manager'),
  validate({ body: controller.productBodySchema.partial() }),
  asyncHandler(controller.updateProduct),
);
adminCatalogRouter.delete(
  '/products/:id',
  requireRole('storeAdmin', 'manager'),
  asyncHandler(controller.archiveProduct),
);
adminCatalogRouter.get(
  '/products/needs-fixing',
  requireRole('storeAdmin', 'manager'),
  asyncHandler(controller.needsFixing),
);

adminCatalogRouter.patch(
  '/variants/:id/stock',
  requireRole('storeAdmin', 'staff'),
  validate({ body: controller.stockUpdateSchema }),
  asyncHandler(controller.updateVariantStock),
);
adminCatalogRouter.get(
  '/variants/by-barcode/:code',
  requireRole('storeAdmin', 'staff'),
  validate({ params: z.object({ code: z.string().min(1) }) }),
  asyncHandler(controller.findByBarcode),
);
