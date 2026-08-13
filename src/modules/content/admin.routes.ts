import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as service from './service.js';

export const adminContentRouter = Router();

adminContentRouter.use(requireRole('storeAdmin', 'owner'));

const localizedSchema = z.object({ en: z.string(), ar: z.string() });

adminContentRouter.put(
  '/content/:type',
  validate({ params: z.object({ type: z.enum(['terms', 'privacy', 'about']) }), body: z.object({ body: localizedSchema }) }),
  asyncHandler(async (req, res) => {
    res.json(await service.upsertContent(req.ctx.tenantId!, req.params.type!, req.body.body));
  }),
);

adminContentRouter.put(
  '/strings/:namespace/:key',
  validate({ body: z.object({ value: localizedSchema }) }),
  asyncHandler(async (req, res) => {
    res.json(
      await service.upsertString(req.ctx.tenantId!, req.params.namespace!, req.params.key!, req.body.value),
    );
  }),
);

adminContentRouter.get(
  '/strings/coverage',
  asyncHandler(async (req, res) => {
    res.json(await service.coverageReport(req.ctx.tenantId!));
  }),
);
