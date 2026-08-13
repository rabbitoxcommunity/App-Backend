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
  const popular = popularIds.length
    ? await Product.find({ tenantId, _id: { $in: popularIds }, status: 'published', archivedAt: null })
    : await Product.find({ tenantId, status: 'published', archivedAt: null }).sort({ popularity: -1 }).limit(10);

  return {
    banners,
    popular,
    trending: merch?.trendingSearches ?? [],
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
