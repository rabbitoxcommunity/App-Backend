import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { signUpload } from '../../lib/s3.js';
import * as controller from './controller.js';

export const importRouter = Router();

importRouter.use(requireRole('storeAdmin', 'manager'));

const signImportSchema = z.object({
  contentType: z.enum([
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
});

importRouter.post(
  '/sign',
  validate({ body: signImportSchema }),
  asyncHandler(async (req, res) => {
    const result = await signUpload(String(req.ctx.tenantId), req.body.contentType, 'import');
    res.json(result);
  }),
);

importRouter.post('/upload', validate({ body: controller.registerBatchSchema }), asyncHandler(controller.uploadBatch));
importRouter.get('/:id', asyncHandler(controller.getBatch));
importRouter.post('/:id/mapping', validate({ body: controller.mappingSchema }), asyncHandler(controller.saveMapping));
importRouter.post('/:id/validate', asyncHandler(controller.validate));
importRouter.post('/:id/commit', asyncHandler(controller.commit));
