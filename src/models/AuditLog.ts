import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.24 auditLog — written on EVERY /admin, /delivery and /platform
// mutation, as a changed-fields diff, not a full snapshot (products with
// embedded variants are large).

const auditLogSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true }, // e.g. "product.update", "order.status"
    // Named collectionName, not collection — `collection` shadows Mongoose's
    // own reserved Document property and triggers a real (if non-fatal)
    // schema warning.
    collectionName: { type: String, required: true },
    documentId: { type: Schema.Types.ObjectId, default: null },
    changes: { type: Schema.Types.Mixed, default: {} }, // { field: { before, after } }
    ip: { type: String, default: '' },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

auditLogSchema.index({ tenantId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, collectionName: 1, documentId: 1, at: -1 });

auditLogSchema.plugin(tenantScopePlugin);
toJSONPlugin(auditLogSchema);

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model('AuditLog', auditLogSchema);
