/**
 * §7 MONEY — every amount is an integer count of fils. 1 AED = 100 fils.
 * The API never sends or accepts a float for money. The app divides by 100
 * at the formatting boundary only (utils/format.ts).
 */

export function toFils(aed: number): number {
  return Math.round(aed * 100);
}

export function fromFils(fils: number): number {
  return fils / 100;
}

export function isValidFils(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function sumFils(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
