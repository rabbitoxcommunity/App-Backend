import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.14 creditEntries — APPEND-ONLY. D7: balance = SUM of `amount` across
// all entries. A mistake is corrected with a compensating entry, never an
// edit or delete.

const creditEntrySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'CreditAccount', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['charge', 'payment'], required: true },
    title: { type: LocalizedSchema, required: true },
    subtitle: { type: LocalizedSchema, default: () => ({ en: '', ar: '' }) },
    amount: { type: Number, required: true }, // fils, positive charge, negative payment
    balanceAfter: { type: Number, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    recordedBy: { type: Schema.Types.ObjectId, default: null },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

creditEntrySchema.index({ tenantId: 1, accountId: 1, at: -1 });

creditEntrySchema.plugin(tenantScopePlugin);
toJSONPlugin(creditEntrySchema);

export type CreditEntryDoc = InferSchemaType<typeof creditEntrySchema>;
export const CreditEntry = model('CreditEntry', creditEntrySchema);
