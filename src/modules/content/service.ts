import { Types } from 'mongoose';
import { ContentPage } from '../../models/ContentPage.js';
import { TranslationString } from '../../models/TranslationString.js';
import { AppError } from '../../lib/errors.js';
import { isCompleteLocalized } from '../../lib/localized.js';

export async function getLegalPage(tenantId: Types.ObjectId, type: string) {
  const page = await ContentPage.findOne({ tenantId, type });
  if (!page) throw AppError.notFound('Page');
  return page;
}

export async function getStrings(tenantId: Types.ObjectId, lang: 'en' | 'ar') {
  const strings = await TranslationString.find({ tenantId });
  const grouped: Record<string, Record<string, string>> = {};
  for (const s of strings) {
    grouped[s.namespace] ??= {};
    grouped[s.namespace]![s.key] = s.value[lang] || s.value.en;
  }
  return grouped;
}

export async function upsertContent(tenantId: Types.ObjectId, type: string, body: { en: string; ar: string }) {
  return ContentPage.findOneAndUpdate(
    { tenantId, type },
    { body, $inc: { version: 1 }, publishedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function upsertString(
  tenantId: Types.ObjectId,
  namespace: string,
  key: string,
  value: { en: string; ar: string },
) {
  return TranslationString.findOneAndUpdate(
    { tenantId, namespace, key },
    { value },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/** §17/§20.2 — translation coverage report: rows where value.ar is empty. */
export async function coverageReport(tenantId: Types.ObjectId) {
  const all = await TranslationString.find({ tenantId });
  const missing = all.filter((s) => !isCompleteLocalized(s.value));
  return {
    total: all.length,
    missingCount: missing.length,
    missing: missing.map((s) => ({ namespace: s.namespace, key: s.key })),
  };
}
