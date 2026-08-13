import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.18 banners — replaces the picsum.photos placeholders shipping today.

const bannerSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    imageUrl: { type: String, required: true },
    linkType: { type: String, enum: ['category', 'product', 'none'], default: 'none' },
    linkId: { type: Schema.Types.ObjectId, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

bannerSchema.index({ tenantId: 1, active: 1, sortOrder: 1 });

bannerSchema.plugin(tenantScopePlugin);
toJSONPlugin(bannerSchema);

export type BannerDoc = HydratedDocument<InferSchemaType<typeof bannerSchema>>;
export const Banner = model('Banner', bannerSchema);
