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
