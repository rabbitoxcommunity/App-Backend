import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.25 dailyRollups / §18 ANALYTICS. Precomputed, not live aggregation —
// historical queries read this; "today" is the only live aggregation.

const dailyRollupSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD in tenant timezone
    orders: {
      count: { type: Number, default: 0 },
      byStatus: { type: Schema.Types.Mixed, default: {} },
      byFulfillment: { type: Schema.Types.Mixed, default: {} },
    },
    revenue: {
      gross: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      deliveryFees: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
    },
    topProducts: {
      type: [{ productId: Schema.Types.ObjectId, units: Number, revenue: Number }],
      default: [],
    },
    topCategories: {
      type: [{ categoryId: Schema.Types.ObjectId, revenue: Number, share: Number }],
      default: [],
    },
    newCustomers: { type: Number, default: 0 },
    creditExposure: { type: Number, default: 0 },
  },
  { timestamps: true },
);

dailyRollupSchema.index({ tenantId: 1, date: -1 }, { unique: true });

dailyRollupSchema.plugin(tenantScopePlugin);
toJSONPlugin(dailyRollupSchema);

export type DailyRollupDoc = InferSchemaType<typeof dailyRollupSchema>;
export const DailyRollup = model('DailyRollup', dailyRollupSchema);
