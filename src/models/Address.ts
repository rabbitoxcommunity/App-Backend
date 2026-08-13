import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.9 addresses. RULE: exactly one primary per customer, enforced in a
// transaction (§13.1) — see modules/addresses/service.ts.

const addressSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: LocalizedSchema, required: true },
    lines: { type: LocalizedSchema, required: true },
    phone: { type: String, default: null },
    geo: { lat: Number, lng: Number },
    isPrimary: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

addressSchema.index({ tenantId: 1, customerId: 1, archivedAt: 1 });

addressSchema.plugin(tenantScopePlugin);
toJSONPlugin(addressSchema);

export type AddressDoc = HydratedDocument<InferSchemaType<typeof addressSchema>>;
export const Address = model('Address', addressSchema);
