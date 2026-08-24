import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const platformRouter = Router();

platformRouter.use(requireRole('superAdmin'));

platformRouter.get('/tenants', asyncHandler(controller.listTenants));
platformRouter.post('/tenants', validate({ body: controller.onboardSchema }), asyncHandler(controller.onboard));
platformRouter.get('/tenants/:id', asyncHandler(controller.getTenant));
platformRouter.patch('/tenants/:id', asyncHandler(controller.configure));
platformRouter.patch(
  '/tenants/:id/subscription',
  validate({ body: controller.subscriptionSchema }),
  asyncHandler(controller.setSubscription),
);
platformRouter.post('/tenants/:id/suspend', asyncHandler(controller.suspend));
platformRouter.post('/tenants/:id/reactivate', asyncHandler(controller.reactivate));
platformRouter.post('/tenants/:id/reset-owner-access', asyncHandler(controller.resetOwnerAccess));
platformRouter.post('/tenants/:id/impersonate', asyncHandler(controller.impersonate));

platformRouter.get('/plans', asyncHandler(controller.listPlans));
platformRouter.post('/plans', validate({ body: controller.planSchema }), asyncHandler(controller.createPlan));
platformRouter.patch('/plans/:id', validate({ body: controller.planBaseSchema.partial() }), asyncHandler(controller.updatePlan));
platformRouter.delete('/plans/:id', asyncHandler(controller.deletePlan));

platformRouter.get('/invoices', asyncHandler(controller.listInvoices));
platformRouter.post('/invoices/:id/issue', asyncHandler(controller.issueInvoice));
platformRouter.post(
  '/invoices/:id/mark-paid',
  validate({ body: z.object({ paymentRef: z.string().min(1) }) }),
  asyncHandler(controller.markInvoicePaid),
);

platformRouter.get('/analytics', asyncHandler(controller.analytics));
platformRouter.get('/audit', asyncHandler(controller.auditLog));

platformRouter.get('/users', asyncHandler(controller.listUsers));
platformRouter.post('/users', validate({ body: controller.platformUserSchema }), asyncHandler(controller.createUser));
