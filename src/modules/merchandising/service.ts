import { Types } from 'mongoose';
import { Banner } from '../../models/Banner.js';
import { Merchandising } from '../../models/Merchandising.js';
import { Product } from '../../models/Product.js';
import { AppError } from '../../lib/errors.js';

export async function getHome(tenantId: Types.ObjectId) {
  const now = new Date();
  const [banners, merch] = await Promise.all([
    Banner.find({
      tenantId,
      active: true,
      $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
      $and: [{ $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
    }).sort({ sortOrder: 1 }),
    Merchandising.findOne({ tenantId }),
  ]);

  const popularIds = merch?.popularProductIds ?? [];

  let popular;
  if (popularIds.length) {
    // Re-ordered in the id sequence the owner curated. `$in` returns documents
    // in Mongo's natural order, so the app's rail came out in a different order
    // from the one shown in the CMS — reversed, in testing.
    const found = await Product.find({
      tenantId,
      _id: { $in: popularIds },
      status: 'published',
      archivedAt: null,
    });
    const byId = new Map(found.map((p) => [String(p._id), p]));
    // Unpublished or deleted ids are skipped rather than left as holes.
    popular = popularIds.map((id) => byId.get(String(id))).filter((p) => p != null);
  } else {
    popular = await Product.find({ tenantId, status: 'published', archivedAt: null })
      .sort({ popularity: -1 })
      .limit(10);
  }

  return {
    banners,
    popular,
    trending: merch?.trendingSearches ?? [],
  };
}

/**
 * ADMIN GAP FILL — only a PUT existed, so the CMS had no way to read the
 * current curation back and therefore no way to build an editor for it.
 *
 * Returns the products hydrated and IN `popularProductIds` ORDER, because that
 * order is what `getHome` serves to the app — a `$in` query returns whatever
 * order Mongo likes, which would make the editor show a different sequence from
 * the storefront.
 */
export async function getMerchandising(tenantId: Types.ObjectId) {
  const merch = await Merchandising.findOne({ tenantId });
  const ids = merch?.popularProductIds ?? [];

  const products = ids.length
    ? await Product.find({ tenantId, _id: { $in: ids }, archivedAt: null })
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return {
    // Ids whose product was deleted are dropped rather than returned as holes.
    popular: ids.map((id) => byId.get(String(id))).filter((p) => p != null),
    popularProductIds: ids.map(String),
    trendingSearches: merch?.trendingSearches ?? [],
    categoryOrder: merch?.categoryOrder ?? [],
  };
}

export async function updateMerchandising(
  tenantId: Types.ObjectId,
  input: { popularProductIds?: string[]; trendingSearches?: Array<{ en: string; ar: string }>; categoryOrder?: string[] },
) {
  const merch = await Merchandising.findOneAndUpdate(
    { tenantId },
    { $set: input },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return merch;
}

export async function listBanners(tenantId: Types.ObjectId) {
  return Banner.find({ tenantId }).sort({ sortOrder: 1 });
}

export async function createBanner(input: {
  imageUrl: string;
  linkType?: 'category' | 'product' | 'none';
  linkId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  sortOrder?: number;
  active?: boolean;
}) {
  return Banner.create(input);
}

export async function updateBanner(id: string, input: Partial<Parameters<typeof createBanner>[0]>) {
  const banner = await Banner.findByIdAndUpdate(id, input, { new: true });
  if (!banner) throw AppError.notFound('Banner');
  return banner;
}

export async function deleteBanner(id: string) {
  const banner = await Banner.findByIdAndUpdate(id, { active: false }, { new: true });
  if (!banner) throw AppError.notFound('Banner');
  return banner;
}
