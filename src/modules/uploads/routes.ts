import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { signUpload } from '../../lib/s3.js';

export const uploadsRouter = Router();

const signSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  purpose: z.enum(['category-tile', 'product-image', 'banner', 'tenant-logo']),
});

// §16 — bytes never pass through Express. Client PUTs directly to the
// returned `url`, then sends `fileUrl` on the create/update call.
uploadsRouter.post(
  '/sign',
  requireRole('storeAdmin', 'manager'),
  validate({ body: signSchema }),
  asyncHandler(async (req, res) => {
    const result = await signUpload(String(req.ctx.tenantId), req.body.contentType, req.body.purpose);
    res.json(result);
  }),
);
