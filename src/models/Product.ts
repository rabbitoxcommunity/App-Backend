import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.8 products — the largest collection, and the one blocking every browse
// screen (CMS-SCOPE module 01).

const AxisOptionSchema = new Schema(
  { slug: { type: String, required: true }, name: { type: LocalizedSchema, required: true } },
  { timestamps: false },
);

const AxisSchema = new Schema(
  {
    slug: { type: String, required: true },
    name: { type: LocalizedSchema, required: true },
    options: { type: [AxisOptionSchema], default: [] },
  },
  { timestamps: false },
);

const VariantSchema = new Schema(
  {
    // axis _id -> option _id. Map<String, ObjectId> per §4.8.
    optionIds: { type: Map, of: Schema.Types.ObjectId, default: () => new Map() },
    // ADMIN GAP FILL — a free-text fallback for variants added by hand in the
    // CMS without a formal axis (e.g. "250ml", "Sugarfree"). When present and
    // optionIds is empty, this is what the order line snapshots as the label.
    label: { type: LocalizedSchema, default: null },
    price: { type: Number, required: true, min: 0 }, // fils
    compareAtPrice: { type: Number, default: null },
    barcode: { type: String, default: null },
    stock: { type: String, enum: ['available', 'low', 'out'], default: 'available' },
    lowStockCount: { type: Number, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

toJSONPlugin(AxisSchema);
toJSONPlugin(VariantSchema);

const productSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    subcategoryId: { type: Schema.Types.ObjectId, default: null },
    name: { type: LocalizedSchema, required: true },
    subtitle: { type: LocalizedSchema, default: () => ({ en: '', ar: '' }) },
    description: { type: LocalizedSchema, default: null },
    shelf: { type: LocalizedSchema, default: null },
    imageUrl: { type: String, default: null },
    icon: { type: String, required: true },
    axes: { type: [AxisSchema], default: [] },
    variants: { type: [VariantSchema], default: [] },
    defaultVariantId: { type: Schema.Types.ObjectId, default: null },
    popularity: { type: Number, default: 0, index: true },
    searchTokens: { type: [String], default: [], index: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    importBatchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

productSchema.index({ tenantId: 1, categoryId: 1, status: 1, archivedAt: 1 });
productSchema.index({ tenantId: 1, popularity: -1 });
productSchema.index({ tenantId: 1, createdAt: -1 });
productSchema.index({ tenantId: 1, 'variants.barcode': 1 }, { unique: true, sparse: true });
productSchema.index({ tenantId: 1, 'variants._id': 1 });

productSchema.plugin(tenantScopePlugin);
toJSONPlugin(productSchema);

export type ProductDoc = HydratedDocument<InferSchemaType<typeof productSchema>>;
export const Product = model('Product', productSchema);
