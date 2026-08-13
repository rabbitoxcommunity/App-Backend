import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.19 merchandising — single document per tenant.

const merchandisingSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
    popularProductIds: { type: [Schema.Types.ObjectId], default: [] },
    trendingSearches: { type: [LocalizedSchema], default: [] },
    categoryOrder: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);

merchandisingSchema.plugin(tenantScopePlugin);
toJSONPlugin(merchandisingSchema);

export type MerchandisingDoc = InferSchemaType<typeof merchandisingSchema>;
export const Merchandising = model('Merchandising', merchandisingSchema);
