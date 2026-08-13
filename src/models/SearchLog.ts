import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.23 searchLogs — zero-result queries are the cheapest catalogue-gap
// signal available (§20.1).

const searchLogSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    query: { type: String, required: true },
    resultCount: { type: Number, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

searchLogSchema.index({ tenantId: 1, resultCount: 1, at: -1 });

searchLogSchema.plugin(tenantScopePlugin);
toJSONPlugin(searchLogSchema);

export type SearchLogDoc = InferSchemaType<typeof searchLogSchema>;
export const SearchLog = model('SearchLog', searchLogSchema);
