import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.16 promoRedemptions — the unique index makes double redemption
// impossible rather than merely unlikely.

const promoRedemptionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    promoId: { type: Schema.Types.ObjectId, ref: 'PromoCode', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

promoRedemptionSchema.index({ tenantId: 1, promoId: 1, orderId: 1 }, { unique: true });
promoRedemptionSchema.index({ tenantId: 1, promoId: 1, customerId: 1 });

promoRedemptionSchema.plugin(tenantScopePlugin);
toJSONPlugin(promoRedemptionSchema);

export type PromoRedemptionDoc = InferSchemaType<typeof promoRedemptionSchema>;
export const PromoRedemption = model('PromoRedemption', promoRedemptionSchema);
