import { Types, type FilterQuery } from 'mongoose';
import { Category } from '../../models/Category.js';
import { Product } from '../../models/Product.js';
import { SearchLog } from '../../models/SearchLog.js';
import { buildSearchTokens } from '../../lib/searchTokens.js';
import { isValidIcon } from '../../lib/iconCatalog.js';
import { isCompleteLocalized, type Localized } from '../../lib/localized.js';
import { AppError } from '../../lib/errors.js';
import { assertProductLimit } from '../../lib/planLimits.js';
import { requireTenantId } from '../../context/requestContext.js';
import { domainEvents } from '../../lib/domainEvents.js';

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
}) {
  const filter: FilterQuery<typeof Product> = { status: 'published', archivedAt: null };
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
    price: number;
    compareAtPrice?: number | null;
    barcode?: string | null;
    stock?: 'available' | 'low' | 'out';
    lowStockCount?: number | null;
  }>;
  status?: 'draft' | 'published';
};

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
  return product;
}

export async function archiveProduct(id: string) {
  const product = await Product.findByIdAndUpdate(id, { archivedAt: new Date() }, { new: true });
  if (!product) throw AppError.notFound('Product');
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
  return Category.create(input);
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
  return category;
}

export async function archiveCategory(id: string) {
  const productCount = await Product.countDocuments({ categoryId: id, archivedAt: null });
  if (productCount > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${productCount} product(s) still reference this category (§4.7/§21 integrity rule).`,
      { productCount },
    );
  }
  const category = await Category.findByIdAndUpdate(id, { archivedAt: new Date() }, { new: true });
  if (!category) throw AppError.notFound('Category');
  return category;
}
