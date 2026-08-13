import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.17 paymentMethods. `kind` is a CLOSED enum — the CMS may enable,
// disable, reorder and re-word rows, but may never create a new kind. See
// disagreement §c.6 in the design doc: a dynamic kind would let an admin
// enable a tender neither the app nor the server can actually handle.

const paymentMethodSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    kind: { type: String, enum: ['card', 'credit', 'cash'], required: true },
    title: { type: LocalizedSchema, required: true },
    subtitle: { type: LocalizedSchema, default: null },
    requiresCreditApproval: { type: Boolean, default: false },
    availableFor: { type: [String], enum: ['delivery', 'curbside'], default: ['delivery', 'curbside'] },
    enabled: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

paymentMethodSchema.index({ tenantId: 1, kind: 1 }, { unique: true });

paymentMethodSchema.plugin(tenantScopePlugin);
toJSONPlugin(paymentMethodSchema);

export type PaymentMethodDoc = InferSchemaType<typeof paymentMethodSchema>;
export const PaymentMethod = model('PaymentMethod', paymentMethodSchema);
