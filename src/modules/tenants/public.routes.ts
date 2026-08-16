import { Router } from 'express';
import { Tenant } from '../../models/Tenant.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { assertTenantLive, isTrialExpired } from '../../lib/tenantAccess.js';

export const tenantPublicRouter = Router();

/**
 * GET /tenants, public — no auth, no X-Tenant-Id required. Backs the
 * customer app's shop picker (the app has no build-time tenant anymore; the
 * customer picks a live shop here first). Field list is a deliberate
 * whitelist, not `Tenant.find()` + default toJSON — `contact.{email,phone}`
 * and `gateway.credentialsEnc` must never reach an unauthenticated response.
 */
tenantPublicRouter.get(
  '/tenants',
  asyncHandler(async (_req, res) => {
    const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } })
      .select('slug name branding.logoUrl branding.primaryHex store.name store.address store.geo status plan.trialEndsAt')
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({
      items: tenants
        .filter((t) => !isTrialExpired(t))
        .map((t) => ({
          id: String(t._id),
          slug: t.slug,
          name: t.name,
          logoUrl: t.branding?.logoUrl ?? null,
          primaryHex: t.branding?.primaryHex ?? '#2E7A12',
          storeName: t.store?.name ?? t.name,
          address: t.store?.address ?? null,
          geo: t.store?.geo?.lat != null && t.store?.geo?.lng != null ? { lat: t.store.geo.lat, lng: t.store.geo.lng } : null,
        })),
    });
  }),
);

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

    res.json({
      name: tenant.name,
      branding: tenant.branding,
      locale: tenant.locale,
      store: tenant.store,
      settings: tenant.settings,
    });
  }),
);
