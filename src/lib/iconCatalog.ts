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
