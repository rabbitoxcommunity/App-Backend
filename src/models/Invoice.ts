import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.4 invoices — NOT tenant-scoped (super admin reads across tenants), but
// every row still carries tenantId to filter by.

const invoiceLineSchema = new Schema(
  { description: String, quantity: Number, unitPrice: Number, amount: Number },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    number: { type: String, required: true, unique: true }, // "INV-2026-0043"
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    lines: { type: [invoiceLineSchema], default: [] },
    subtotal: { type: Number, required: true }, // fils
    vatRate: { type: Number, default: 5 }, // UAE VAT
    vatAmount: { type: Number, required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'issued', 'paid', 'overdue', 'void'], default: 'draft' },
    issuedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    paymentRef: { type: String, default: null }, // manual reference in v1 (D14)
  },
  { timestamps: true },
);

invoiceSchema.index({ tenantId: 1, status: 1 });

toJSONPlugin(invoiceSchema);
// Deliberately NOT tenant-scoped by the plugin — superAdmin reads across
// tenants (GET /platform/invoices); tenant-facing reads always filter
// explicitly by tenantId in the service layer.

export type InvoiceDoc = InferSchemaType<typeof invoiceSchema>;
export const Invoice = model('Invoice', invoiceSchema);
