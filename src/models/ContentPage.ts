import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.20 contentPages — terms/privacy are placeholder sentences today.

const contentPageSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    type: { type: String, enum: ['terms', 'privacy', 'about'], required: true },
    body: { type: LocalizedSchema, required: true }, // markdown
    version: { type: Number, default: 1 },
    publishedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

contentPageSchema.index({ tenantId: 1, type: 1 }, { unique: true });

contentPageSchema.plugin(tenantScopePlugin);
toJSONPlugin(contentPageSchema);

export type ContentPageDoc = InferSchemaType<typeof contentPageSchema>;
export const ContentPage = model('ContentPage', contentPageSchema);
