import { describe, expect, it } from 'vitest';
import {
  ComparePriceNotHigherError,
  parseComparePrice,
  PriceNotUnderstoodError,
  PriceOutOfRangeError,
} from '@/lib/merchant/menu-policy';
import { centavosFromPesoInput } from '@/lib/money';
import { savingCentavos } from '@/lib/stores/store-page-data';

describe('the "was" price a shop types', () => {
  it('is nothing when the box is left empty', () => {
    // Blank is the normal case — most dishes are not on sale — which is why
    // this cannot share `parsePrice`, where blank is a mistake.
    expect(parseComparePrice('', 10_000, centavosFromPesoInput)).toBeNull();
    expect(parseComparePrice('   ', 10_000, centavosFromPesoInput)).toBeNull();
  });

  it('reads a peso figure into centavos', () => {
    expect(parseComparePrice('150', 10_000, centavosFromPesoInput)).toBe(15_000);
    expect(parseComparePrice('150.50', 10_000, centavosFromPesoInput)).toBe(15_050);
  });

  /*
   * The rule the whole feature rests on. A "was" price at or below what is
   * being charged puts a struck-through number on the storefront that says the
   * shop put its prices UP, in a section headed "Today's offer".
   */
  it('refuses a was-price that is not above the real price', () => {
    expect(() => parseComparePrice('100', 10_000, centavosFromPesoInput)).toThrow(
      ComparePriceNotHigherError,
    );
    expect(() => parseComparePrice('99', 10_000, centavosFromPesoInput)).toThrow(
      ComparePriceNotHigherError,
    );
    // One centavo above is a silly sale but an honest one, and refusing it
    // would mean this function deciding what counts as a real discount.
    expect(parseComparePrice('100.01', 10_000, centavosFromPesoInput)).toBe(10_001);
  });

  it('applies the same bounds and the same refusals as a real price', () => {
    expect(() => parseComparePrice('abc', 10_000, centavosFromPesoInput)).toThrow(
      PriceNotUnderstoodError,
    );
    expect(() => parseComparePrice('50000', 10_000, centavosFromPesoInput)).toThrow(
      PriceOutOfRangeError,
    );
  });

  it('says something a shop owner can act on', () => {
    try {
      parseComparePrice('90', 10_000, centavosFromPesoInput);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ComparePriceNotHigherError);
      // Not "invalid input": the message has to say which way round they go.
      expect((error as Error).message).toMatch(/higher than what you are charging/);
    }
  });
});

describe('what a sale saves', () => {
  it('is the difference when there is one', () => {
    expect(savingCentavos({ priceCentavos: 14_400, compareAtPriceCentavos: 16_900 })).toBe(
      2_500,
    );
  });

  it('is nothing when the dish is not on sale', () => {
    expect(savingCentavos({ priceCentavos: 14_400, compareAtPriceCentavos: null })).toBeNull();
  });

  /*
   * The database CHECK makes these unreachable through the app. They are
   * answered anyway because the alternative is a storefront rendering "Save
   * ₱0.00" beside a struck-through price identical to the real one, which is
   * the kind of thing a bad import writes and nobody notices for a week.
   */
  it('is nothing when the row is wrong rather than showing a zero saving', () => {
    expect(savingCentavos({ priceCentavos: 14_400, compareAtPriceCentavos: 14_400 })).toBeNull();
    expect(savingCentavos({ priceCentavos: 14_400, compareAtPriceCentavos: 10_000 })).toBeNull();
  });
});
