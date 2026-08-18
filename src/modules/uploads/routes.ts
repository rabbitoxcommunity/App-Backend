import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { signUpload, type UploadPurpose } from '../../lib/s3.js';

export const uploadsRouter = Router();

const signSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  purpose: z.enum(['category-tile', 'product-image', 'banner', 'tenant-logo', 'delivery-proof']),
});

/**
 * §16 — the purpose whitelist is also an authorisation boundary, not just a
 * path-naming convention. A rider must be able to sign a `delivery-proof`
 * upload and nothing else; a store admin has no business minting one. So
 * the allowed role is looked up per purpose rather than gating the whole
 * route on a single role.
 *
 * `minGrade` mirrors requireRole's storeAdmin grade rank ('staff' <
 * 'manager' < 'owner'); it is meaningless for deliveryStaff.
 */
const PURPOSE_ACCESS: Record<
  z.infer<typeof signSchema>['purpose'],
  { role: 'storeAdmin' | 'deliveryStaff'; minGrade?: 'manager' }
> = {
  'category-tile': { role: 'storeAdmin', minGrade: 'manager' },
  'product-image': { role: 'storeAdmin', minGrade: 'manager' },
  banner: { role: 'storeAdmin', minGrade: 'manager' },
  'tenant-logo': { role: 'storeAdmin', minGrade: 'manager' },
  'delivery-proof': { role: 'deliveryStaff' },
};

const GRADE_RANK = { staff: 0, manager: 1, owner: 2 } as const;

function requirePurposeAccess(req: Request, _res: Response, next: NextFunction): void {
  const access = PURPOSE_ACCESS[req.body.purpose as keyof typeof PURPOSE_ACCESS];
  if (!access) return next(AppError.forbidden('Unknown upload purpose.'));

  if (req.ctx.role !== access.role) {
    return next(AppError.forbidden(`Signing a "${req.body.purpose}" upload requires the "${access.role}" role.`));
  }
  if (access.minGrade) {
    const have = req.ctx.grade ? GRADE_RANK[req.ctx.grade] : -1;
    if (have < GRADE_RANK[access.minGrade]) {
      return next(AppError.forbidden(`This route requires at least "${access.minGrade}" grade.`));
    }
  }
  if (!req.ctx.tenantId) return next(AppError.unauthenticated('Token is missing a tenant.'));
  next();
}

// §16 — bytes never pass through Express. Client PUTs directly to the
// returned `url`, then sends `fileUrl` on the create/update call.
//
// Mounted at BOTH /uploads and /admin/uploads (see routes/index.ts): the
// /admin prefix predates there being any non-admin uploader, and the Admin
// PWA already ships against it.
uploadsRouter.post(
  '/sign',
  requireAuth,
  validate({ body: signSchema }),
  requirePurposeAccess,
  asyncHandler(async (req, res) => {
    const result = await signUpload(
      String(req.ctx.tenantId),
      req.body.contentType,
      req.body.purpose as UploadPurpose,
    );
    res.json(result);
  }),
);
