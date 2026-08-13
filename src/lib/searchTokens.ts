/**
 * §20.1 SEARCH — a `searchTokens` array we control instead of a MongoDB
 * text index, because Arabic stemming is not part of Community's text
 * search feature set and a text index only applies one language per
 * document anyway. Tier-independent, works with a prefix regex anchored
 * at ^.
 */

const ARABIC_DIACRITICS = /[ً-ٰٟ]/g;

function normalizeArabic(input: string): string {
  return input
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function buildSearchTokens(fields: string[]): string[] {
  const tokens = new Set<string>();
  for (const field of fields) {
    if (!field) continue;
    for (const token of tokenize(normalizeArabic(field))) {
      tokens.add(token);
    }
  }
  return Array.from(tokens);
}
