import { Schema, model, type InferSchemaType } from 'mongoose';
import { LocalizedSchema } from '../lib/localized.js';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.21 translationStrings — 25 namespaces exist in the app today.

const translationStringSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    namespace: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: LocalizedSchema, required: true },
  },
  { timestamps: true },
);

translationStringSchema.index({ tenantId: 1, namespace: 1, key: 1 }, { unique: true });

translationStringSchema.plugin(tenantScopePlugin);
toJSONPlugin(translationStringSchema);

export type TranslationStringDoc = InferSchemaType<typeof translationStringSchema>;
export const TranslationString = model('TranslationString', translationStringSchema);
