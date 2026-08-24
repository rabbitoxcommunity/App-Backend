import { Router } from 'express';
import { Tenant } from '../../models/Tenant.js';
import { Product } from '../../models/Product.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { assertTenantLive } from '../../lib/tenantAccess.js';

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
    assertTenantLive(tenant);

    /**
     * Real price span of what this shop sells, so the app's filter slider spans
     * the catalogue instead of a constant copied from a design mock. The old
     * hardcoded AED 50 ceiling made every product above it unreachable.
     * In fils, like every other price on the wire.
     */
    const [range] = await Product.aggregate<{ min: number; max: number }>([
      { $match: { status: 'published', archivedAt: null } },
      { $unwind: '$variants' },
      { $group: { _id: null, min: { $min: '$variants.price' }, max: { $max: '$variants.price' } } },
    ]);

    res.json({
      name: tenant.name,
      branding: tenant.branding,
      locale: tenant.locale,
      store: tenant.store,
      settings: tenant.settings,
      priceRange: { min: range?.min ?? 0, max: range?.max ?? 0 },
    });
  }),
);
