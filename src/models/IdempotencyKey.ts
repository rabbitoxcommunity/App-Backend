import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

/**
 * §13.7 IDEMPOTENCY, generalised. The design doc anchors order idempotency
 * to `orders.idempotencyKey` (kept — see models/Order.ts) but also requires
 * it on POST /admin/credit/:id/payment and POST /delivery/orders/:id/confirm,
 * neither of which has a natural single document to hang a key off. One
 * small tenant-scoped collection covers all three call sites identically.
 */

const idempotencyKeySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    route: { type: String, required: true },
    key: { type: String, required: true },
    status: { type: Number, required: true },
    body: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

idempotencyKeySchema.index({ tenantId: 1, route: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // 24h TTL per §13.7

idempotencyKeySchema.plugin(tenantScopePlugin);
toJSONPlugin(idempotencyKeySchema);

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencyKeySchema>;
export const IdempotencyKey = model('IdempotencyKey', idempotencyKeySchema);
