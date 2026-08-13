import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.3 plans — NOT tenant-scoped. Created early (pulled forward from Phase 7)
// because tenants.plan.planId references it from Phase 0.

const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // "starter", "growth"...
    name: { type: LocalizedSchema, required: true },
    priceMonthly: { type: Number, required: true }, // fils
    limits: {
      products: { type: Number, default: 500 },
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
