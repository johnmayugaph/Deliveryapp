import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filtersToQuery,
  parseFilters,
  type ServicePageFilters,
} from '@/lib/services/service-page-data';
import { promoOfferLabel } from '@/lib/promo/policy';

describe('parseFilters', () => {
  it('reads every chip out of a query string', () => {
    expect(
      parseFilters({ sort: 'rating', open: '1', fast: '1', deals: '1', category: 'Ulam' }),
    ).toEqual({
      sort: 'rating',
      openNow: true,
      fast: true,
      deals: true,
      category: 'Ulam',
    });
  });

  it('falls back to the defaults on an empty URL', () => {
    expect(parseFilters({})).toEqual(DEFAULT_FILTERS);
  });

  /*
   * The reason this is not a formality: these values come off a link somebody
   * may have bookmarked before a chip existed, or edited by hand. A throw here
   * is a 500 on a stale bookmark.
   */
  it('ignores a sort it does not recognise rather than throwing', () => {
    expect(parseFilters({ sort: 'cheapest' }).sort).toBe('recommended');
    expect(parseFilters({ sort: '' }).sort).toBe('recommended');
  });

  it('treats any value other than 1 as the chip being off', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(parseFilters({ open: value }).openNow, `open=${value}`).toBe(false);
      expect(parseFilters({ fast: value }).fast, `fast=${value}`).toBe(false);
      expect(parseFilters({ deals: value }).deals, `deals=${value}`).toBe(false);
    }
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parseFilters({ sort: ['fastest', 'rating'] }).sort).toBe('fastest');
    expect(parseFilters({ category: ['Ulam', 'Drinks'] }).category).toBe('Ulam');
  });

  it('treats a blank or whitespace category as no category', () => {
    expect(parseFilters({ category: '' }).category).toBeNull();
    expect(parseFilters({ category: '   ' }).category).toBeNull();
  });
});

describe('filtersToQuery', () => {
  it('writes nothing for the default filters, so the clean URL stays clean', () => {
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe('');
  });

  it('omits the default sort but keeps the others', () => {
    expect(filtersToQuery({ ...DEFAULT_FILTERS, sort: 'rating' })).toBe('?sort=rating');
    expect(filtersToQuery({ ...DEFAULT_FILTERS, sort: 'recommended' })).toBe('');
  });

  it('escapes a category with a space in it', () => {
    expect(filtersToQuery({ ...DEFAULT_FILTERS, category: 'Rice meals' })).toBe(
      '?category=Rice+meals',
    );
  });

  /*
   * The round trip is the property that matters: every chip builds its link
   * with `filtersToQuery` and the next request reads it with `parseFilters`,
   * so a disagreement between them is a chip that does not stay pressed.
   */
  it('round-trips every combination back to itself', () => {
    const sorts = ['recommended', 'rating', 'fastest'] as const;
    const categories = [null, 'Ulam', 'Rice meals', 'Sides & drinks'];
    for (const sort of sorts) {
      for (const openNow of [false, true]) {
        for (const fast of [false, true]) {
          for (const deals of [false, true]) {
            for (const category of categories) {
              const filters: ServicePageFilters = { sort, openNow, fast, deals, category };
              const query = filtersToQuery(filters);
              const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
              expect(parseFilters(params), query === '' ? '(no query)' : query).toEqual(
                filters,
              );
            }
          }
        }
      }
    }
  });
});

describe('promoOfferLabel', () => {
  it('writes a whole percentage without a trailing zero', () => {
    expect(
      promoOfferLabel({ kind: 'PERCENTAGE', percentBasisPoints: 1_000, amountCentavos: null }),
    ).toBe('10% off');
  });

  it('keeps one decimal on a percentage that has one', () => {
    expect(
      promoOfferLabel({ kind: 'PERCENTAGE', percentBasisPoints: 1_250, amountCentavos: null }),
    ).toBe('12.5% off');
  });

  it('writes a fixed amount as money', () => {
    expect(
      promoOfferLabel({ kind: 'FIXED_AMOUNT', percentBasisPoints: null, amountCentavos: 5_000 }),
    ).toBe('₱50.00 off');
  });

  it('names free delivery rather than pricing it', () => {
    expect(
      promoOfferLabel({ kind: 'FREE_DELIVERY', percentBasisPoints: null, amountCentavos: null }),
    ).toBe('Free delivery');
  });

  /*
   * A malformed row should still render a chip. These columns are nullable
   * because each kind uses a different one, so a PERCENTAGE with no percentage
   * is a bad row rather than an impossible one — and a blank chip on a shop
   * list is harder to notice than a visibly wrong one.
   */
  it('renders a zero rather than blank when the figure is missing', () => {
    expect(
      promoOfferLabel({ kind: 'PERCENTAGE', percentBasisPoints: null, amountCentavos: null }),
    ).toBe('0% off');
    expect(
      promoOfferLabel({ kind: 'FIXED_AMOUNT', percentBasisPoints: null, amountCentavos: null }),
    ).toBe('₱0.00 off');
  });
});
