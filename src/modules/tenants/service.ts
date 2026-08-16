import mongoose, { Types } from 'mongoose';
import argon2 from 'argon2';
import { Tenant } from '../../models/Tenant.js';
import { AppError } from '../../lib/errors.js';
import { User } from '../../models/User.js';
import { PaymentMethod } from '../../models/PaymentMethod.js';
import { Merchandising } from '../../models/Merchandising.js';
import { env } from '../../config/env.js';
import type { Localized } from '../../lib/localized.js';
import { runWithContext } from '../../context/requestContext.js';

export type OnboardTenantInput = {
  slug: string;
  name: Localized;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string; // E.164
  ownerPassword: string;
  storeName: Localized;
};

const TRIAL_DAYS = 14;

/**
 * §19.1 TENANT ONBOARDING — creates the tenant, its owner storeAdmin user,
 * a default paymentMethods set and a default merchandising document, in ONE
 * transaction. A half-created tenant is unusable and nobody notices until
 * the owner tries to log in.
 */
export async function onboardTenant(input: OnboardTenantInput) {
  const session = await mongoose.startSession();
  try {
    let result!: { tenantId: string; ownerId: string };

    await session.withTransaction(async () => {
      const [tenant] = await Tenant.create(
        [
          {
            slug: input.slug,
            name: input.name,
            status: 'trial',
            contact: { ownerName: input.ownerName, email: input.ownerEmail, phone: input.ownerPhone },
            store: { name: input.storeName },
            plan: { trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000) },
          },
        ],
        { session },
      );
      if (!tenant) throw new Error('Tenant.create returned no document.');

      const passwordHash = await argon2.hash(input.ownerPassword, {
        memoryCost: env.ARGON2_MEMORY_KB,
        timeCost: env.ARGON2_TIME_COST,
      });

      // User/PaymentMethod/Merchandising creation runs inside the tenant
      // scope plugin, which needs AsyncLocalStorage context — provide one
      // scoped to the tenant we just created, for the rest of this callback.
      await runWithContext(
        {
          tenantId: tenant._id,
          userId: null,
          role: 'superAdmin',
          grade: null,
          requestId: 'onboarding',
          impersonatedBy: null,
        },
        async () => {
          const [owner] = await User.create(
            [
              {
                tenantId: tenant._id,
                role: 'storeAdmin',
                permissions: 'owner',
                name: input.ownerName,
                phone: input.ownerPhone,
                email: input.ownerEmail,
                passwordHash,
              },
            ],
            { session },
          );
          if (!owner) throw new Error('User.create returned no document.');

          await PaymentMethod.create(
            [
              {
                tenantId: tenant._id,
                kind: 'cash',
                title: { en: 'Cash on delivery', ar: 'الدفع عند الاستلام' },
                availableFor: ['delivery'],
                enabled: true,
                sortOrder: 3,
              },
              {
                tenantId: tenant._id,
                kind: 'card',
                title: { en: 'Card', ar: 'بطاقة' },
                availableFor: ['delivery', 'curbside'],
                enabled: true,
                sortOrder: 1,
              },
              {
                tenantId: tenant._id,
                kind: 'credit',
                title: { en: 'Pay Later (Credit)', ar: 'الدفع لاحقًا (ائتمان)' },
                requiresCreditApproval: true,
                availableFor: ['delivery', 'curbside'],
                enabled: true,
                sortOrder: 2,
              },
            ],
            { session, ordered: true },
          );

          await Merchandising.create(
            [{ tenantId: tenant._id, popularProductIds: [], trendingSearches: [], categoryOrder: [] }],
            { session },
          );

          result = { tenantId: String(tenant._id), ownerId: String(owner._id) };
        },
      );
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export async function getConfig(tenantId: Types.ObjectId) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant');
  return tenant;
}

export type ConfigUpdateInput = Partial<{
  name: Localized;
  branding: { logoUrl?: string | null; primaryHex?: string; appIconUrl?: string | null };
  locale: { defaultLanguage?: 'en' | 'ar'; timezone?: string };
  store: Record<string, unknown>;
  settings: Record<string, unknown>;
}>;

/** §10 PUT /admin/config — owner only. */
export async function updateConfig(tenantId: Types.ObjectId, input: ConfigUpdateInput) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant');

  if (input.name) tenant.name = input.name as never;
  if (input.branding) Object.assign(tenant.branding!, input.branding);
  if (input.locale) Object.assign(tenant.locale!, input.locale);
  if (input.store) Object.assign(tenant.store!, input.store);
  if (input.settings) Object.assign(tenant.settings!, input.settings);

  await tenant.save();
  return tenant;
}
