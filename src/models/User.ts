import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.6 users — one collection for every human inside a tenant (customer,
// deliveryStaff, storeAdmin). Role decides which optional block applies.
// DEPARTURE: v1 had separate customers/riders/adminUsers collections;
// merged because the four roles overlap heavily and a delivery staff member
// is a person who logs in, same as an admin.

const PushTokenSchema = new Schema(
  {
    token: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], required: true },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    role: {
      type: String,
      enum: ['storeAdmin', 'deliveryStaff', 'customer'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'blocked', 'offShift'],
      default: 'active',
    },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true }, // E.164, see lib/phone.ts
    email: { type: String, default: null },
    passwordHash: { type: String, default: null, select: false },
    language: { type: String, enum: ['en', 'ar'], default: 'en' },
    pushTokens: { type: [PushTokenSchema], default: [] },

    // customer only
    creditApproved: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },

    // deliveryStaff only
    vehicle: {
      type: { type: String, enum: ['bike', 'van', 'car'] },
      plate: String,
    },
    availability: {
      type: String,
      enum: ['available', 'on_delivery', 'off_shift'],
      default: 'off_shift',
    },
    activeOrderIds: { type: [Schema.Types.ObjectId], default: [] },
    stats: {
      completedToday: { type: Number, default: 0 },
      avgMinutes: { type: Number, default: 25 },
    },

    // storeAdmin only
    permissions: { type: String, enum: ['owner', 'manager', 'staff'], default: null },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
// `sparse: true` alone is NOT enough here: a sparse index only excludes
// documents where the field is entirely absent, not documents where it is
// explicitly `null` — and `email` above defaults to `null` for every
// customer that doesn't have one. Without the partial filter, the first
// customer with no email claims the `{tenantId, email: null}` slot and every
// customer after them fails OTP sign-up with a duplicate-key error.
userSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index({ tenantId: 1, role: 1, status: 1 });
userSchema.index({ tenantId: 1, role: 1, availability: 1 });

userSchema.plugin(tenantScopePlugin);
toJSONPlugin(userSchema);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
