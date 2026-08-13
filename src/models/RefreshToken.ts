import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.11 refreshTokens — §5.5 rotation with reuse detection.
// NOTE: superAdmin refresh tokens also live here with tenantId=null; the
// tenantScope plugin only fires when context has a role other than
// superAdmin, so superAdmin token rows are written via skipTenantScope
// through a small internal helper in modules/auth/service.ts.

const refreshTokenSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: Schema.Types.ObjectId, required: true, index: true },
    replacedBy: { type: Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

toJSONPlugin(refreshTokenSchema);
// Deliberately NOT using tenantScopePlugin — superAdmin rows have no tenant,
// and auth must be able to look up a refresh token before a tenant context
// exists at all. Every query in the auth service filters by tenantId itself
// where relevant.

export type RefreshTokenDoc = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
