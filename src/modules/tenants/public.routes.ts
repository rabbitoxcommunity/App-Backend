import { Router } from 'express';
import { Tenant } from '../../models/Tenant.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';

export const tenantPublicRouter = Router();

/**
 * §10 — GET /config, public. Every module needs a trustworthy place to read
 * fees, flags and branding from; this is why Phase 1 ships it even though
 * it is logically part of the tenant/platform module.
 */
tenantPublicRouter.get(
  '/config',
  asyncHandler(async (req, res) => {
    if (!req.ctx.tenantId) {
      throw new AppError('TENANT_MISMATCH', 'X-Tenant-Id header is required.');
    }
    const tenant = await Tenant.findById(req.ctx.tenantId);
    if (!tenant) throw AppError.notFound('Tenant');
    if (tenant.status === 'suspended') {
      throw new AppError('TENANT_SUSPENDED', 'This store is currently suspended.');
    }

    res.json({
      name: tenant.name,
      branding: tenant.branding,
      locale: tenant.locale,
      store: tenant.store,
      settings: tenant.settings,
    });
  }),
);
