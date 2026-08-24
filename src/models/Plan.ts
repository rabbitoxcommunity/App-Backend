import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.3 plans — NOT tenant-scoped. Created early (pulled forward from Phase 7)
// because tenants.plan.planId references it from Phase 0.

const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // "starter", "growth"...
    name: { type: LocalizedSchema, required: true },
    /**
     * Which term this plan is sold on. Annual is the commercial model going
     * forward (e.g. AED 2500/year); `monthly` is kept so existing monthly plans
     * keep working rather than silently changing price.
     */
    billingPeriod: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    priceMonthly: { type: Number, required: true }, // fils
    /** fils, charged once per year. Required in practice when billingPeriod is 'yearly'. */
    priceYearly: { type: Number, default: 0 },
    limits: {
      products: { type: Number, default: 500 },
      /**
       * Only meaningful for monthly plans. Annual plans are sold as unlimited —
       * the invoice carries a single subscription line and no overage, so there
       * is nothing for this to be compared against.
       */
      ordersPerMonth: { type: Number, default: 2000 },
      staffSeats: { type: Number, default: 5 },
    },
    features: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

toJSONPlugin(planSchema);

export type PlanDoc = InferSchemaType<typeof planSchema>;
export const Plan = model('Plan', planSchema);
