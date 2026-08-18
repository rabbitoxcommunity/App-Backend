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
    // fils. NULL MEANS UNLIMITED — a customer the shop trusts without a
    // ceiling. Every read of this field has to treat null as "no cap"
    // rather than as zero, which would be the exact opposite.
    limit: { type: Number, default: null },
    balance: { type: Number, default: 0 }, // fils, owed by the customer
    /**
     * False once a store admin withdraws credit from this customer. The
     * ACCOUNT AND ITS LEDGER SURVIVE — a revoked customer usually still owes
     * money, and deleting the record would erase the debt along with the
     * privilege. Charges are refused while inactive; payments are not, so an
     * outstanding balance can still be settled.
     */
    active: { type: Boolean, default: true },
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
