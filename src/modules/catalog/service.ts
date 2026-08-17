import mongoose, { Types, type FilterQuery } from 'mongoose';
import { Category } from '../../models/Category.js';
import { Product } from '../../models/Product.js';
import { NotifyRequest } from '../../models/NotifyRequest.js';
import { PromoCode } from '../../models/PromoCode.js';
import { SearchLog } from '../../models/SearchLog.js';
import { buildSearchTokens } from '../../lib/searchTokens.js';
import { isValidIcon } from '../../lib/iconCatalog.js';
import { isCompleteLocalized, type Localized } from '../../lib/localized.js';
import { AppError } from '../../lib/errors.js';
import { assertProductLimit } from '../../lib/planLimits.js';
import { requireTenantId } from '../../context/requestContext.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { realtime } from '../../realtime/io.js';

// ------------------------------------------------------------------ public

export async function listCategories() {
  return Category.find({ status: 'published', visible: true, archivedAt: null }).sort({ sortOrder: 1 });
}

export async function getCategoryProducts(
  idOrSlug: string,
  opts: { page: number; limit: number; sort?: string },
) {
  const category = await Category.findOne(
    Types.ObjectId.isValid(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug },
  );
  if (!category) throw AppError.notFound('Category');

  const filter: FilterQuery<typeof Product> = {
    categoryId: category._id,
    status: 'published',
    archivedAt: null,
  };
  return { category, ...(await paginateProducts(filter, opts)) };
}

async function paginateProducts(
  filter: FilterQuery<typeof Product>,
  opts: { page: number; limit: number; sort?: string; minPrice?: number; maxPrice?: number },
) {
  const sortMap: Record<string, Record<string, 1 | -1>> = {
    popularity: { popularity: -1 },
    newest: { createdAt: -1 },
    priceAsc: { 'variants.0.price': 1 },
    priceDesc: { 'variants.0.price': -1 },
  };
  const sort = sortMap[opts.sort ?? 'popularity'] ?? sortMap.popularity;

  if (opts.minPrice != null || opts.maxPrice != null) {
    filter['variants.price'] = {
      ...(opts.minPrice != null ? { $gte: opts.minPrice } : {}),
      ...(opts.maxPrice != null ? { $lte: opts.maxPrice } : {}),
    };
  }

  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(opts.limit),
    Product.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

export async function listProducts(opts: {
  page: number;
  limit: number;
  category?: string;
  sub?: string;
  sort?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
}) {
  const filter: FilterQuery<typeof Product> = { status: 'published', archivedAt: null };
  // Matches products with AT LEAST ONE sellable variant, mirroring the app's
  // productStock()/isPurchasable() rule. A plain { $ne: 'out' } would instead
  // demand that NO variant is out, hiding partially-out products.
  if (opts.inStock) filter['variants.stock'] = { $in: ['available', 'low'] };
  if (opts.category) {
    filter.categoryId = Types.ObjectId.isValid(opts.category) ? opts.category : undefined;
    if (!filter.categoryId) {
      const cat = await Category.findOne({ slug: opts.category });
      filter.categoryId = cat?._id ?? new Types.ObjectId(); // no match -> empty result
    }
  }
  if (opts.sub && Types.ObjectId.isValid(opts.sub)) filter.subcategoryId = opts.sub;
  return paginateProducts(filter, opts);
}

export async function getProduct(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Product');
  const product = await Product.findOne({ _id: id, status: 'published', archivedAt: null });
  if (!product) throw AppError.notFound('Product');
  return product;
}

/** §20.1 — every query, including zero-result ones, writes a searchLog. */
export async function search(q: string, customerId: string | null, opts: { page: number; limit: number }) {
  const tokens = buildSearchTokens([q]);
  const filter: FilterQuery<typeof Product> = {
    status: 'published',
    archivedAt: null,
    searchTokens: { $in: tokens.map((t) => new RegExp(`^${escapeRegex(t)}`)) },
  };

  const result = await paginateProducts(filter, opts);

  await SearchLog.create({
    query: q,
    resultCount: result.total,
    customerId: customerId ? new Types.ObjectId(customerId) : null,
  });

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------- admin

export type ProductInput = {
  categoryId?: string | null;
  subcategoryId?: string | null;
  name: Localized;
  subtitle?: Localized;
  description?: Localized | null;
  shelf?: Localized | null;
  imageUrl?: string | null;
  icon: string;
  axes?: Array<{ slug: string; name: Localized; options: Array<{ slug: string; name: Localized }> }>;
  variants: Array<{
    optionIds?: Record<string, string>;
    label?: Localized | null; // manual variant label when no formal axis applies
    price: number;
    compareAtPrice?: number | null;
    barcode?: string | null;
    stock?: 'available' | 'low' | 'out';
    lowStockCount?: number | null;
  }>;
  status?: 'draft' | 'published';
};

/**
 * ADMIN GAP FILL — the CMS product list needs to see drafts, archived and
 * out-of-stock items too (not just what the customer app shows), search by
 * name/barcode, and filter by status/category. Public listProducts()
 * deliberately excludes all of that.
 */
export async function adminListProducts(opts: {
  page: number;
  limit: number;
  q?: string;
  category?: string;
  status?: 'draft' | 'published';
  stock?: 'available' | 'low' | 'out';
  includeArchived?: boolean;
}) {
  const filter: FilterQuery<typeof Product> = {};
  if (!opts.includeArchived) filter.archivedAt = null;
  if (opts.status) filter.status = opts.status;
  if (opts.category) {
    filter.categoryId = opts.category === 'none' ? null : opts.category;
  }
  // Stock lives per variant, so this matches a product with AT LEAST ONE variant
  // in that state — "out of stock" surfaces partially-out products too, which is
  // what someone restocking wants to see.
  if (opts.stock) filter['variants.stock'] = opts.stock;
  if (opts.q) {
    const tokens = buildSearchTokens([opts.q]);
    filter.$or = [
      { searchTokens: { $in: tokens.map((t) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) } },
      { 'variants.barcode': opts.q },
    ];
  }

  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(opts.limit),
    Product.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

/**
 * ADMIN GAP FILL — admin category management needs drafts and hidden rows too.
 *
 * Returns `productCount` per row from ONE aggregation. The Categories screen
 * used to derive it by firing `/admin/products?category=<id>&limit=1` once per
 * category — 89 HTTP round trips to render a single page, growing with the
 * catalogue.
 */
export async function adminListCategories(opts: { page: number; limit: number; q?: string }) {
  const filter: FilterQuery<typeof Category> = { archivedAt: null };
  if (opts.q?.trim()) {
    const rx = new RegExp(escapeRegex(opts.q.trim()), 'i');
    filter.$or = [{ 'name.en': rx }, { 'name.ar': rx }, { slug: rx }];
  }

  const skip = (opts.page - 1) * opts.limit;
  // _id breaks ties: sortOrder is not unique (imported rows can share one), and
  // an unstable sort would let a row jump pages between requests.
  const [items, total] = await Promise.all([
    Category.find(filter).sort({ sortOrder: 1, _id: 1 }).skip(skip).limit(opts.limit),
    Category.countDocuments(filter),
  ]);

  const counts = await Product.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { categoryId: { $in: items.map((c) => c._id) }, archivedAt: null } },
    { $group: { _id: '$categoryId', n: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));

  /**
   * `position` is each row's rank in the FULL ordering, resolved here rather
   * than inferred client-side from the row index. The index is only the
   * position when the list is unfiltered and on page 1 — under a search it
   * reported every match as position 1.
   *
   * Computed as a rank instead of `sortOrder + 1` because sortOrder is not
   * dependably contiguous: deletes leave gaps and a category created without
   * an explicit sortOrder defaults to 0.
   */
  const ordered = await Category.find({ archivedAt: null })
    .select('_id')
    .sort({ sortOrder: 1, _id: 1 })
    .lean();
  const rankById = new Map(ordered.map((c, i) => [String(c._id), i + 1]));

  return {
    items: items.map((c) => ({
      ...c.toJSON(),
      productCount: countBy.get(String(c._id)) ?? 0,
      position: rankById.get(String(c._id)) ?? null,
    })),
    page: opts.page,
    limit: opts.limit,
    total,
    // Unfiltered count — the valid range for a position. `total` shrinks to the
    // match count under a search and must never be used to bound a move.
    overallTotal: ordered.length,
  };
}

/** ADMIN GAP FILL — the edit form needs one category regardless of status/visibility. */
export async function adminGetCategory(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Category');
  const category = await Category.findOne({ _id: id, archivedAt: null });
  if (!category) throw AppError.notFound('Category');
  return category;
}

/**
 * Move a category to an explicit 1-based position and renumber the rest.
 *
 * Reordering has to be a server operation rather than the client PATCHing
 * sortOrder values: positions are only meaningful relative to every other
 * category, and the list is paginated, so the client never holds the full
 * ordering to compute them from.
 */
export async function setCategoryPosition(id: string, position: number) {
  const all = await Category.find({ archivedAt: null }).sort({ sortOrder: 1, _id: 1 });
  const from = all.findIndex((c) => String(c._id) === id);
  if (from === -1) throw AppError.notFound('Category');

  const to = Math.min(Math.max(position, 1), all.length) - 1;
  const [moved] = all.splice(from, 1);
  all.splice(to, 0, moved!);

  // bulkWrite is NOT one of tenantScopePlugin's hooked operations, so it is
  // not auto-scoped — safe only because every _id here came out of the scoped
  // find above. Do not widen this to a filter-based update.
  const ops = all
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c.sortOrder !== i)
    .map(({ c, i }) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { sortOrder: i } } } }));
  if (ops.length > 0) await Category.bulkWrite(ops);

  realtime.categoryChanged(String(requireTenantId()), moved!);
  return { id, position: to + 1, renumbered: ops.length };
}

/** ADMIN GAP FILL — the edit form needs a single product regardless of status (public getProduct only returns published). */
export async function adminGetProduct(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Product');
  const product = await Product.findOne({ _id: id, archivedAt: null });
  if (!product) throw AppError.notFound('Product');
  return product;
}

function assertPublishReady(input: { name: Localized; status?: string }): void {
  if (input.status === 'published' && !isCompleteLocalized(input.name)) {
    throw AppError.validationFailed({
      name: 'Both en and ar are required to publish (§4 Localized rule).',
    });
  }
}

export async function createProduct(input: ProductInput) {
  if (!isValidIcon(input.icon)) {
    throw AppError.validationFailed({ icon: `"${input.icon}" is not in the icon catalog.` });
  }
  assertPublishReady(input);
  await assertProductLimit(requireTenantId());

  const product = new Product({
    ...input,
    searchTokens: buildSearchTokens([
      input.name.en,
      input.name.ar,
      input.subtitle?.en ?? '',
      input.subtitle?.ar ?? '',
      ...input.variants.map((v) => v.barcode ?? '').filter(Boolean),
    ]),
  });
  if (!product.defaultVariantId && product.variants[0]) {
    product.defaultVariantId = product.variants[0]._id;
  }
  await product.save();
  realtime.productChanged(String(requireTenantId()), product);
  return product;
}

export async function updateProduct(id: string, input: Partial<ProductInput>) {
  const product = await Product.findById(id);
  if (!product) throw AppError.notFound('Product');

  if (input.icon && !isValidIcon(input.icon)) {
    throw AppError.validationFailed({ icon: `"${input.icon}" is not in the icon catalog.` });
  }
  assertPublishReady({ name: input.name ?? product.name, status: input.status ?? product.status });

  Object.assign(product, input);
  product.searchTokens = buildSearchTokens([
    product.name.en,
    product.name.ar,
    product.subtitle?.en ?? '',
    product.subtitle?.ar ?? '',
    ...product.variants.map((v) => v.barcode ?? '').filter(Boolean),
  ]);
  await product.save();
  realtime.productChanged(String(requireTenantId()), product);
  return product;
}

/**
 * HARD delete. Safe for order history because order lines snapshot `name`,
 * `unitPrice`, `variantLabel` and `icon` at purchase time (§Order.lines) —
 * they never read the product back, so past orders still render in full.
 *
 * Cleans up the one collection that would otherwise be left pointing at a
 * row that no longer exists: back-in-stock requests. Those carry a unique
 * index on (tenantId, customerId, variantId), so leaving them behind would
 * also block a future request if the id were ever reused.
 *
 * Deliberately NOT cleaned: dailyRollups keeps `topProducts[].productId` for
 * historical analytics, which must stay accurate for periods when the product
 * did exist.
 */
export async function deleteProduct(id: string) {
  const product = await Product.findById(id);
  if (!product) throw AppError.notFound('Product');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await NotifyRequest.deleteMany({ productId: product._id }, { session });
      await Product.deleteOne({ _id: product._id }, { session });
    });
  } finally {
    await session.endSession();
  }

  realtime.productChanged(String(requireTenantId()), product);
  return product;
}

/** §10 — the QuickStock toggle. Not transactional: single field, no quantity (D8). */
export async function updateVariantStock(
  variantId: string,
  stock: 'available' | 'low' | 'out',
  lowStockCount?: number | null,
) {
  const product = await Product.findOne({ 'variants._id': variantId });
  if (!product) throw AppError.notFound('Variant');

  const variant = product.variants.id(variantId);
  if (!variant) throw AppError.notFound('Variant');

  const wasOut = variant.stock === 'out';
  variant.stock = stock;
  variant.lowStockCount = lowStockCount ?? null;
  await product.save();

  if (wasOut && stock !== 'out') {
    domainEvents.emit('stock.backInStock', {
      tenantId: String(requireTenantId()),
      variantId,
      productName: product.name.en,
    });
  }

  realtime.stockChanged(String(requireTenantId()), {
    productId: String(product._id),
    variantId,
    stock: variant.stock,
    lowStockCount: variant.lowStockCount,
  });

  return { product, variant };
}

export async function findByBarcode(barcode: string) {
  const product = await Product.findOne({ 'variants.barcode': barcode });
  if (!product) throw AppError.notFound('Product with that barcode');
  const variant = product.variants.find((v) => v.barcode === barcode);
  return { product, variant };
}

/** §17 — products that import couldn't confidently place. */
export async function needsFixing(opts: { page: number; limit: number }) {
  const filter: FilterQuery<typeof Product> = {
    archivedAt: null,
    $or: [{ categoryId: null }, { status: 'draft' }, { 'name.ar': '' }],
  };
  const skip = (opts.page - 1) * opts.limit;
  const [items, total] = await Promise.all([
    Product.find(filter).skip(skip).limit(opts.limit),
    Product.countDocuments(filter),
  ]);
  return { items, page: opts.page, limit: opts.limit, total };
}

// --------------------------------------------------------------- categories

export type CategoryInput = {
  slug: string;
  name: Localized;
  imageUrl?: string | null;
  icon: string;
  sortOrder?: number;
  visible?: boolean;
  subcategories?: Array<{ slug: string; name: Localized; sortOrder?: number }>;
  status?: 'draft' | 'published';
};

export async function createCategory(input: CategoryInput) {
  if (!isValidIcon(input.icon)) {
    throw AppError.validationFailed({ icon: `"${input.icon}" is not in the icon catalog.` });
  }
  assertPublishReady(input);
  // Without this the schema default (0) applies, so every new category lands at
  // position 1 and ties with whatever is already there. New ones belong last.
  const sortOrder =
    input.sortOrder ??
    ((await Category.findOne({ archivedAt: null }).sort({ sortOrder: -1 }).select('sortOrder'))
      ?.sortOrder ?? -1) + 1;
  const category = await Category.create({ ...input, sortOrder });
  realtime.categoryChanged(String(requireTenantId()), category);
  return category;
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const category = await Category.findById(id);
  if (!category) throw AppError.notFound('Category');
  if (input.icon && !isValidIcon(input.icon)) {
    throw AppError.validationFailed({ icon: `"${input.icon}" is not in the icon catalog.` });
  }
  assertPublishReady({ name: input.name ?? category.name, status: input.status ?? category.status });
  Object.assign(category, input);
  await category.save();
  realtime.categoryChanged(String(requireTenantId()), category);
  return category;
}

/**
 * HARD delete, still refusing while products point at it (§4.7/§21) — that
 * guard matters more now, not less: with a soft delete a stray reference
 * merely pointed at a hidden row, whereas here it would dangle entirely.
 *
 * `categoryIds` on promo codes IS repaired, because a promo scoped to a
 * deleted category would otherwise silently stop matching anything with no
 * indication why.
 */
export async function deleteCategory(id: string) {
  // Existence first: checking the guard first reported "N products still
  // reference this" for a category that simply didn't exist, which is a
  // confusing thing to tell someone.
  const category = await Category.findById(id);
  if (!category) throw AppError.notFound('Category');

  // Counts archived products too: an archived product still carries this
  // categoryId, so deleting out from under it would dangle that reference.
  const productCount = await Product.countDocuments({ categoryId: id });
  if (productCount > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${productCount} product(s) still reference this category (§4.7/§21 integrity rule).`,
      { productCount },
    );
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await PromoCode.updateMany(
        { categoryIds: category._id },
        { $pull: { categoryIds: category._id } },
        { session },
      );
      await Category.deleteOne({ _id: category._id }, { session });
    });
  } finally {
    await session.endSession();
  }

  realtime.categoryChanged(String(requireTenantId()), category);
  return category;
}
