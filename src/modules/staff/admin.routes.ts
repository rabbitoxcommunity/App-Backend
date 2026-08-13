import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { writeAudit } from '../../lib/audit.js';
import * as service from './service.js';

export const adminStaffRouter = Router();

const vehicleSchema = z.object({ type: z.enum(['bike', 'van', 'car']), plate: z.string().min(1) });

const createSchema = z.object({
  role: z.enum(['storeAdmin', 'deliveryStaff']),
  name: z.string().min(1),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  password: z.string().min(8),
  permissions: z.enum(['owner', 'manager', 'staff']).optional(),
  vehicle: vehicleSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(6).optional(),
  email: z.string().email().nullable().optional(),
  permissions: z.enum(['owner', 'manager', 'staff']).optional(),
  vehicle: vehicleSchema.optional(),
  status: z.enum(['active', 'blocked', 'offShift']).optional(),
});

// §5.2 — viewing staff is staff-level; creating/editing accounts is owner-only
// (adding a manager or another owner is a trust decision, not routine ops).
adminStaffRouter.get(
  '/',
  requireRole('storeAdmin', 'staff'),
  asyncHandler(async (req, res) => {
    const role = req.query.role as 'storeAdmin' | 'deliveryStaff' | undefined;
    res.json(await service.listStaff(req.ctx.tenantId!, { role }));
  }),
);

adminStaffRouter.get(
  '/:id',
  requireRole('storeAdmin', 'staff'),
  asyncHandler(async (req, res) => {
    res.json(await service.getStaffMember(req.ctx.tenantId!, req.params.id!));
  }),
);

adminStaffRouter.post(
  '/',
  requireRole('storeAdmin', 'owner'),
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const member = await service.createStaff(req.ctx.tenantId!, req.body);
    await writeAudit(req, 'staff.create', 'users', String(member._id), {
      role: { before: null, after: member.role },
    });
    res.status(201).json(member);
  }),
);

adminStaffRouter.patch(
  '/:id',
  requireRole('storeAdmin', 'owner'),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const member = await service.updateStaff(req.ctx.tenantId!, req.params.id!, req.body);
    await writeAudit(req, 'staff.update', 'users', req.params.id!, {
      fields: { before: null, after: Object.keys(req.body) },
    });
    res.json(member);
  }),
);

adminStaffRouter.post(
  '/:id/reset-password',
  requireRole('storeAdmin', 'owner'),
  validate({ body: z.object({ password: z.string().min(8) }) }),
  asyncHandler(async (req, res) => {
    await service.resetStaffPassword(req.ctx.tenantId!, req.params.id!, req.body.password);
    await writeAudit(req, 'staff.resetPassword', 'users', req.params.id!);
    res.status(204).send();
  }),
);

adminStaffRouter.delete(
  '/:id',
  requireRole('storeAdmin', 'owner'),
  asyncHandler(async (req, res) => {
    const member = await service.deactivateStaff(req.ctx.tenantId!, req.params.id!);
    await writeAudit(req, 'staff.deactivate', 'users', req.params.id!);
    res.json(member);
  }),
);
