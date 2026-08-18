import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.12 orders — §9 owns the two status chains.

export const ORDER_STATUSES = [
  'placed',
  'packed',
  'out_for_delivery',
  'delivered',
  'ready_for_pickup',
  'customer_arrived',
  'handed_over',
  'cancelled',
] as const;

const OrderEventSchema = new Schema(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    at: { type: Date, default: () => new Date() },
    note: { type: LocalizedSchema, default: null },
    byUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const OrderLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true }, // fils, captured at purchase
    lineTotal: { type: Number, required: true },
    name: { type: LocalizedSchema, required: true },
    variantLabel: { type: LocalizedSchema, required: true },
    icon: { type: String, required: true },
    // Snapshotted alongside name/price so an order stays renderable after the
    // product is edited or deleted. Null on orders placed before this field
    // existed — clients fall back to the live catalogue, then to `icon`.
    imageUrl: { type: String, default: null },
    fulfilledQty: { type: Number, default: null }, // §9.6, defaults to quantity until packed
    substitutedFor: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

toJSONPlugin(OrderLineSchema);

const orderSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    reference: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fulfillment: { type: String, enum: ['delivery', 'curbside'], required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'placed', index: true },
    placedAt: { type: Date, default: () => new Date(), index: true },
    events: { type: [OrderEventSchema], default: [] },
    lines: { type: [OrderLineSchema], required: true },
    subtotal: { type: Number, required: true },
    deliveryFee: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentKind: { type: String, enum: ['card', 'credit', 'cash'], required: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'collected', 'settled', 'refunded'],
      default: 'pending',
    },
    confirmationCode: { type: String, required: true },
    promoCode: { type: String, default: null },
    addressSnapshot: {
      label: LocalizedSchema,
      lines: LocalizedSchema,
      phone: String,
      geo: { lat: Number, lng: Number },
    },
    rider: {
      userId: { type: Schema.Types.ObjectId, default: null },
      name: { type: LocalizedSchema, default: null },
      phone: { type: String, default: null },
      etaMinutes: { type: Number, default: null },
    },
    assignment: {
      assignedAt: { type: Date, default: null },
      acceptedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      lastOfferedTo: { type: [Schema.Types.ObjectId], default: [] },
      needsManualAssignment: { type: Boolean, default: false },
    },
    estimatedAt: { type: Date, default: null },
    car: {
      plate: String,
      colour: LocalizedSchema,
      colourHex: String,
      bodyType: { type: String, enum: ['sedan', 'suv', 'pickup', 'coupe'] },
    },
    bay: { type: Number, default: null },
    arrival: { type: String, enum: ['on_way', 'near', null], default: null },
    proof: {
      code: { type: Boolean, default: false },
      photoUrl: { type: String, default: null },
      geo: { lat: Number, lng: Number },
      amountCollected: { type: Number, default: null },
    },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, default: null },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true },
);

orderSchema.index({ tenantId: 1, customerId: 1, placedAt: -1 });
orderSchema.index({ tenantId: 1, status: 1, placedAt: -1 });
orderSchema.index({ tenantId: 1, fulfillment: 1, status: 1 });
orderSchema.index({ tenantId: 1, 'rider.userId': 1, status: 1 });
orderSchema.index({ tenantId: 1, reference: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

orderSchema.plugin(tenantScopePlugin);
toJSONPlugin(orderSchema);

export type OrderDoc = HydratedDocument<InferSchemaType<typeof orderSchema>>;
export const Order = model('Order', orderSchema);
