import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { writeAudit } from '../../lib/audit.js';

const localizedSchema = z.object({ en: z.string(), ar: z.string() });

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const listProductsQuery = paginationQuery.extend({
  category: z.string().optional(),
  sub: z.string().optional(),
  sort: z.enum(['popularity', 'newest', 'priceAsc', 'priceDesc']).optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
});

export const searchQuery = paginationQuery.extend({ q: z.string().min(1) });

export const adminListCategoriesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Default is deliberately high, unlike products. Three screens (Products,
  // AddProduct, AddCategory) call this to fill a category dropdown and need
  // every row, not the first page — a low default would silently truncate
  // them. Only the Categories list screen paginates, and it sends an explicit
  // limit.
  limit: z.coerce.number().int().min(1).max(500).default(500),
  q: z.string().optional(),
});

export const categoryPositionSchema = z.object({
  position: z.coerce.number().int().min(1),
});

export const adminListProductsQuery = paginationQuery.extend({
  q: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  stock: z.enum(['available', 'low', 'out']).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

export const productBodySchema = z.object({
  categoryId: z.string().nullable().optional(),
  subcategoryId: z.string().nullable().optional(),
  name: localizedSchema,
  subtitle: localizedSchema.optional(),
  description: localizedSchema.nullable().optional(),
  shelf: localizedSchema.nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  icon: z.string(),
  axes: z
    .array(
      z.object({
        slug: z.string(),
        name: localizedSchema,
        options: z.array(z.object({ slug: z.string(), name: localizedSchema })),
      }),
    )
    .optional(),
  variants: z.array(
    z.object({
      optionIds: z.record(z.string()).optional(),
      label: localizedSchema.nullable().optional(),
      price: z.number().int().min(0),
      compareAtPrice: z.number().int().nullable().optional(),
      barcode: z.string().nullable().optional(),
      stock: z.enum(['available', 'low', 'out']).optional(),
      lowStockCount: z.number().nullable().optional(),
    }),
  ),
  status: z.enum(['draft', 'published']).optional(),
});

export const categoryBodySchema = z.object({
  slug: z.string().min(1),
  name: localizedSchema,
  imageUrl: z.string().nullable().optional(),
  icon: z.string(),
  sortOrder: z.number().optional(),
  visible: z.boolean().optional(),
  subcategories: z
    .array(z.object({ slug: z.string(), name: localizedSchema, sortOrder: z.number().optional() }))
    .optional(),
  status: z.enum(['draft', 'published']).optional(),
});

export const stockUpdateSchema = z.object({
  stock: z.enum(['available', 'low', 'out']),
  lowStockCount: z.number().int().min(0).nullable().optional(),
});

// -------------------------------------------------------------------- public

export async function listCategories(_req: Request, res: Response): Promise<void> {
  res.json(await service.listCategories());
}

export async function getCategoryProducts(req: Request, res: Response): Promise<void> {
  const q = listProductsQuery.parse(req.query);
  res.json(await service.getCategoryProducts(req.params.idOrSlug!, q));
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  res.json(await service.listProducts(listProductsQuery.parse(req.query)));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  res.json(await service.getProduct(req.params.id!));
}

export async function search(req: Request, res: Response): Promise<void> {
  const { q, ...pagination } = searchQuery.parse(req.query);
  res.json(await service.search(q, req.ctx.userId ? String(req.ctx.userId) : null, pagination));
}

export async function adminListProducts(req: Request, res: Response): Promise<void> {
  res.json(await service.adminListProducts(adminListProductsQuery.parse(req.query)));
}

export async function adminListCategories(req: Request, res: Response): Promise<void> {
  res.json(await service.adminListCategories(adminListCategoriesQuery.parse(req.query)));
}

export async function adminGetCategory(req: Request, res: Response): Promise<void> {
  res.json(await service.adminGetCategory(req.params.id!));
}

export async function setCategoryPosition(req: Request, res: Response): Promise<void> {
  const result = await service.setCategoryPosition(req.params.id!, req.body.position);
  await writeAudit(req, 'category.reorder', 'categories', req.params.id!, {
    position: { before: null, after: result.position },
  });
  res.json(result);
}

export async function adminGetProduct(req: Request, res: Response): Promise<void> {
  res.json(await service.adminGetProduct(req.params.id!));
}

// --------------------------------------------------------------------- admin

export async function createProduct(req: Request, res: Response): Promise<void> {
  const product = await service.createProduct(req.body);
  await writeAudit(req, 'product.create', 'products', String(product._id), {
    name: { before: null, after: product.name },
  });
  res.status(201).json(product);
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const product = await service.updateProduct(req.params.id!, req.body);
  await writeAudit(req, 'product.update', 'products', String(product._id), {
    fields: { before: null, after: Object.keys(req.body) },
  });
  res.json(product);
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const product = await service.deleteProduct(req.params.id!);
  await writeAudit(req, 'product.delete', 'products', String(product._id));
  res.json(product);
}

export async function updateVariantStock(req: Request, res: Response): Promise<void> {
  const { product, variant } = await service.updateVariantStock(
    req.params.id!,
    req.body.stock,
    req.body.lowStockCount,
  );
  await writeAudit(req, 'variant.stock', 'products', String(product._id), {
    stock: { before: null, after: req.body.stock },
  });
  res.json(variant);
}

export async function findByBarcode(req: Request, res: Response): Promise<void> {
  res.json(await service.findByBarcode(req.params.code!));
}

export async function needsFixing(req: Request, res: Response): Promise<void> {
  res.json(await service.needsFixing(paginationQuery.parse(req.query)));
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const category = await service.createCategory(req.body);
  await writeAudit(req, 'category.create', 'categories', String(category._id));
  res.status(201).json(category);
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const category = await service.updateCategory(req.params.id!, req.body);
  await writeAudit(req, 'category.update', 'categories', String(category._id), {
    fields: { before: null, after: Object.keys(req.body) },
  });
  res.json(category);
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const category = await service.deleteCategory(req.params.id!);
  await writeAudit(req, 'category.delete', 'categories', String(category._id));
  res.json(category);
}
