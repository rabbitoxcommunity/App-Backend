import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.10 otpChallenges — TTL index gives automatic cleanup.

const otpChallengeSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    phone: { type: String, required: true, index: true },
    codeHash: { type: String, required: true, select: false },
    channel: { type: String, enum: ['sms', 'whatsapp'], required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

otpChallengeSchema.plugin(tenantScopePlugin);
toJSONPlugin(otpChallengeSchema);

export type OtpChallengeDoc = InferSchemaType<typeof otpChallengeSchema>;
export const OtpChallenge = model('OtpChallenge', otpChallengeSchema);
