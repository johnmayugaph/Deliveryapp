/**
 * Money is centavos, always. An integer number of centavos never rounds
 * surprisingly, and PHP has no sub-centavo denomination to represent.
 */

export const CURRENCY = 'PHP' as const;

const PESO_FORMATTER = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
});

export function formatCentavos(centavos: number): string {
  return PESO_FORMATTER.format(centavos / 100);
}

/** Whole pesos, for tile subtitles and fee summaries where centavos are noise. */
export function formatCentavosCompact(centavos: number): string {
  if (centavos % 100 === 0) {
    return `₱${(centavos / 100).toLocaleString('en-PH')}`;
  }
  return formatCentavos(centavos);
}

export function pesos(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Applies a basis-point rate and rounds half-up to the nearest centavo.
 * 1250 bp == 12.5%. Basis points rather than whole percent so a 7.5% campaign
 * does not need a migration.
 */
export function applyBasisPoints(centavos: number, basisPoints: number): number {
  return Math.round((centavos * basisPoints) / 10_000);
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of centavos, got ${value}`);
  }
}

/**
 * Reads a price a person typed into centavos, or null if it is not one.
 *
 * Accepts what a phone keyboard and a shop owner actually produce: `120`,
 * `120.5`, `₱120.00`, `1,250` — and refuses anything else rather than
 * guessing. More than two decimal places is a refusal, not a rounding: a
 * merchant who typed `12.345` should be told, because silently charging
 * ₱12.35 for it is the kind of surprise that ends in a support thread.
 */
export function centavosFromPesoInput(input: string): number | null {
  const cleaned = input.trim().replace(/^₱\s*/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  // Via a string of centavos rather than `Number(cleaned) * 100`, because
  // 19.99 * 100 is 1998.9999999999998 in binary floating point.
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
