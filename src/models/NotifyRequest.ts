import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.23 notifyRequests — back-in-stock, from the app's inert "Notify me" button.

const notifyRequestSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notifyRequestSchema.index({ tenantId: 1, variantId: 1, notifiedAt: 1 });
notifyRequestSchema.index({ tenantId: 1, customerId: 1, variantId: 1 }, { unique: true });

notifyRequestSchema.plugin(tenantScopePlugin);
toJSONPlugin(notifyRequestSchema);

export type NotifyRequestDoc = InferSchemaType<typeof notifyRequestSchema>;
export const NotifyRequest = model('NotifyRequest', notifyRequestSchema);
