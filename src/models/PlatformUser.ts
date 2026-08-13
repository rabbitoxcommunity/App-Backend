import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.2 platformUsers — NOT tenant-scoped. superAdmin only.

const platformUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true },
    role: { type: String, enum: ['superAdmin'], default: 'superAdmin' },
    active: { type: Boolean, default: true },
    mfaSecret: { type: String, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

toJSONPlugin(platformUserSchema);

export type PlatformUserDoc = InferSchemaType<typeof platformUserSchema>;
export const PlatformUser = model('PlatformUser', platformUserSchema);
