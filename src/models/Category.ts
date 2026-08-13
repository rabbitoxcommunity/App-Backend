import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.7 categories.

const SubcategorySchema = new Schema(
  {
    slug: { type: String, required: true },
    name: { type: LocalizedSchema, required: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: false },
);

toJSONPlugin(SubcategorySchema);

const categorySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    name: { type: LocalizedSchema, required: true },
    imageUrl: { type: String, default: null },
    icon: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    visible: { type: Boolean, default: true },
    subcategories: { type: [SubcategorySchema], default: [] },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

categorySchema.index({ tenantId: 1, slug: 1 }, { unique: true });
categorySchema.index({ tenantId: 1, status: 1, visible: 1, archivedAt: 1 });

categorySchema.plugin(tenantScopePlugin);
toJSONPlugin(categorySchema);

export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = model('Category', categorySchema);
