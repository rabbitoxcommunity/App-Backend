import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.15 promoCodes.

const promoCodeSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    discountType: { type: String, enum: ['percent', 'fixed'], required: true },
    value: { type: Number, required: true }, // percent points, or fils
    minSubtotal: { type: Number, default: null }, // fils
    categoryIds: { type: [Schema.Types.ObjectId], default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    maxRedemptions: { type: Number, default: null },
    perCustomerCap: { type: Number, default: null },
    redemptions: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

promoCodeSchema.index({ tenantId: 1, code: 1 }, { unique: true });

promoCodeSchema.plugin(tenantScopePlugin);
toJSONPlugin(promoCodeSchema);

export type PromoCodeDoc = HydratedDocument<InferSchemaType<typeof promoCodeSchema>>;
export const PromoCode = model('PromoCode', promoCodeSchema);
