import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.1 tenants — NOT tenant-scoped (it IS the tenant).

const OpeningHourSchema = new Schema(
  {
    day: { type: Number, min: 0, max: 6, required: true }, // 0 = Sunday
    opens: { type: String, required: true }, // "09:00"
    closes: { type: String, required: true },
    closed: { type: Boolean, default: false },
  },
  { _id: false },
);

const CarColourSchema = new Schema(
  {
    hex: { type: String, required: true },
    name: { type: LocalizedSchema, required: true },
  },
  { _id: false },
);

const tenantSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: LocalizedSchema, required: true },
    status: {
      type: String,
      enum: ['trial', 'active', 'suspended', 'cancelled'],
      default: 'trial',
      index: true,
    },
    branding: {
      logoUrl: { type: String, default: null },
      primaryHex: { type: String, default: '#2E7A12' },
      appIconUrl: { type: String, default: null },
    },
    contact: {
      ownerName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
    },
    locale: {
      defaultLanguage: { type: String, enum: ['en', 'ar'], default: 'en' },
      timezone: { type: String, default: 'Asia/Dubai' },
    },
    store: {
      name: { type: LocalizedSchema, required: true },
      details: { type: LocalizedSchema, default: () => ({ en: '', ar: '' }) },
      address: { type: LocalizedSchema, default: () => ({ en: '', ar: '' }) },
      phone: { type: String, default: '' },
      geo: { lat: Number, lng: Number },
      bays: { type: Number, default: 0 },
      baysFree: { type: Number, default: 0 },
    },
    settings: {
      currency: { type: String, default: 'AED' },
      deliveryFee: { type: Number, default: 500 }, // fils
      deliveryEtaMinutes: { type: Number, default: 30 },
      minOrder: { type: Number, default: null },
      curbsideEnabled: { type: Boolean, default: true },
      creditEnabled: { type: Boolean, default: true },
      cashEnabled: { type: Boolean, default: true },
      defaultCreditLimit: { type: Number, default: 100000 }, // fils
      orderRefPrefix: { type: String, default: 'FC' }, // see lib/reference.ts
      carColours: { type: [CarColourSchema], default: [] },
      carBodyTypes: {
        type: [String],
        default: ['sedan', 'suv', 'pickup', 'coupe'],
      },
      openingHours: { type: [OpeningHourSchema], default: [] },
      holidays: { type: [{ date: String, note: LocalizedSchema }], default: [] },
    },
    gateway: {
      provider: { type: String, enum: ['telr', 'paytabs', null], default: null },
      credentialsEnc: { type: String, default: null, select: false },
    },
    plan: {
      planId: { type: Schema.Types.ObjectId, ref: 'Plan', default: null },
      startedAt: { type: Date, default: () => new Date() },
      trialEndsAt: { type: Date, default: null },
      billingAnchorDay: { type: Number, default: () => new Date().getDate() }, // §25.5
      seats: { type: Number, default: 3 },
    },
    suspendedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

toJSONPlugin(tenantSchema);

export type TenantDoc = InferSchemaType<typeof tenantSchema>;
export const Tenant = model('Tenant', tenantSchema);
