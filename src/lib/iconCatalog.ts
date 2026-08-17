import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * §6 THE ICON ENUM. Generated verbatim from the app's GLYPHS map in
 * src/components/Icon.tsx (73 names, verified 13 Aug 2026). Keep this file
 * and the app in sync by regenerating from the app source, never by hand.
 */
export const ICON_NAMES: readonly string[] = JSON.parse(
  readFileSync(path.join(__dirname, '../shared/icon-catalog.json'), 'utf-8'),
);

const ICON_SET = new Set(ICON_NAMES);

export function isValidIcon(name: string): boolean {
  return ICON_SET.has(name);
}

/**
 * Best-effort tile icon for a category name that arrived from a spreadsheet
 * (§17 import auto-creates categories, and `icon` is required). Deliberately
 * conservative — the owner retitles and re-icons in Admin; this only has to
 * avoid being obviously wrong.
 *
 * Order matters: the first match wins, so narrower rules come first. Word
 * boundaries are not optional here — an unanchored /cola/ matches
 * "choCOLAtes" and files chocolate under beverages.
 */
const ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(chocolate|chocolates|candy|jelly|biscuit|chips|crisps|snack|nuts?|dates)\b/i, 'cat-snacks'],
  [/\b(milk|dairy|cheese|yog(h)?urt|cream|ice cream)\b/i, 'cat-dairy'],
  [/\b(bakery|bread|cake|pastry)\b/i, 'cat-bakery'],
  [/\b(fruit|fruits|vegetable|vegetables|produce)\b/i, 'cat-fruits'],
  [/\b(meat|chicken|beef|mutton|fish|seafood)\b/i, 'cat-meat'],
  [/\b(baby|babies|pampers|diaper|wipes)\b/i, 'cat-baby'],
  [/\b(water|juice|drink|drinks|cola|pepsi|tea|coffee|beverage)\b/i, 'cat-beverages'],
  [/\b(mobile|mobiles|electronic|electronics|battery|speaker|headphone|charger|clock|light)\b/i, 'bolt'],
  [/\b(toy|toys|game|games|playing cards)\b/i, 'favorite'],
  [/\b(food|rice|noodle|noodles|oil|spice|spices|grocery|groceries)\b/i, 'basket'],
];

export function guessCategoryIcon(name: string): string {
  return ICON_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? 'cat-household';
}
