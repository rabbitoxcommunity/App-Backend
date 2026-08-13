import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScope.js';
import { toJSONPlugin } from '../plugins/toJSON.js';

// §4.22 importBatches / §17 Excel import.

const importErrorSchema = new Schema(
  { row: Number, column: String, code: String, message: String },
  { _id: false },
);

const importBatchSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    fileUrl: { type: String, required: true },
    originalName: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: () => new Date() },
    status: {
      type: String,
      enum: ['uploaded', 'mapping', 'validating', 'ready', 'importing', 'done', 'failed'],
      default: 'uploaded',
    },
    columnMap: { type: Schema.Types.Mixed, default: {} },
    headers: { type: [String], default: [] },
    previewRows: { type: [Schema.Types.Mixed], default: [] },
    stats: {
      rows: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errored: { type: Number, default: 0 },
    },
    // Named rowErrors, not errors — `errors` shadows Mongoose's own reserved
    // Document property and triggers a real (if non-fatal) schema warning.
    rowErrors: { type: [importErrorSchema], default: [] },
  },
  { timestamps: true },
);

importBatchSchema.plugin(tenantScopePlugin);
toJSONPlugin(importBatchSchema);

export type ImportBatchDoc = HydratedDocument<InferSchemaType<typeof importBatchSchema>>;
export const ImportBatch = model('ImportBatch', importBatchSchema);
