import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as service from './service.js';
import * as creditController from '../credit/controller.js';
import { writeAudit } from '../../lib/audit.js';

export const adminCustomersRouter = Router();

adminCustomersRouter.use(requireRole('storeAdmin', 'manager'));

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().optional(),
});

adminCustomersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listCustomers(req.ctx.tenantId!, listQuery.parse(req.query)));
  }),
);

adminCustomersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.getCustomer(req.ctx.tenantId!, req.params.id!));
  }),
);

adminCustomersRouter.patch(
  '/:id/credit',
  validate({ body: creditController.approveCreditSchema }),
  asyncHandler(creditController.approve),
);

adminCustomersRouter.patch(
  '/:id/block',
  validate({ body: z.object({ blocked: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const customer = await service.blockCustomer(req.ctx.tenantId!, req.params.id!, req.body.blocked);
    await writeAudit(req, req.body.blocked ? 'customer.block' : 'customer.unblock', 'users', req.params.id!);
    res.json(customer);
  }),
);
