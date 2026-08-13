import { Schema } from 'mongoose';

export type Localized = { en: string; ar: string };

/**
 * §4 SHARED SUBDOCUMENT — Localized. `required` is enforced at the
 * application layer (draft vs published, see isPublishedLocalized below),
 * not at the Mongoose schema layer, because drafts are allowed a partial ar.
 */
export const LocalizedSchema = new Schema<Localized>(
  {
    en: { type: String, default: '', trim: true },
    ar: { type: String, default: '', trim: true },
  },
  { _id: false },
);

export const OptionalLocalizedSchema = LocalizedSchema;

/** §4 RULE — both languages required once a document is published. */
export function isCompleteLocalized(value: Partial<Localized> | null | undefined): boolean {
  return Boolean(value && value.en && value.en.trim() && value.ar && value.ar.trim());
}

export function pickLanguage(value: Localized, lang: 'en' | 'ar'): string {
  return value[lang] || value.en || value.ar || '';
}
