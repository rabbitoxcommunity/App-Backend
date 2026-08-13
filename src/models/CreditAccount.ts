import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.13 creditAccounts. RULE: `balance` is never written directly by a
// route — only recomputed inside the transaction that appends a
// creditEntry (§13.2).

const creditAccountSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    limit: { type: Number, required: true }, // fils
    balance: { type: Number, default: 0 }, // fils, owed by the customer
    dueDate: { type: Date, required: true },
    approvedBy: { type: Schema.Types.ObjectId, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

creditAccountSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });

creditAccountSchema.plugin(tenantScopePlugin);
toJSONPlugin(creditAccountSchema);

export type CreditAccountDoc = HydratedDocument<InferSchemaType<typeof creditAccountSchema>>;
export const CreditAccount = model('CreditAccount', creditAccountSchema);
