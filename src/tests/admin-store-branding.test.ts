import { describe, expect, it } from 'vitest';
import {
  filterConsoleStores,
  ImageUrlNotUnderstoodError,
  ImageUrlTooLongError,
  MAX_IMAGE_URL_LENGTH,
  parseImageUrl,
  type ConsoleStoreRow,
} from '@/lib/admin/stores';

describe('the image address a shop may be given', () => {
  it('is nothing when the box is empty — which is how an image is removed', () => {
    expect(parseImageUrl('')).toBeNull();
    expect(parseImageUrl('   ')).toBeNull();
  });

  it('takes an https link, trimmed', () => {
    expect(parseImageUrl('  https://cdn.example.com/logo.png  ')).toBe(
      'https://cdn.example.com/logo.png',
    );
  });

  it('takes a pasted data image, because the seed writes one', () => {
    const value = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    expect(parseImageUrl(value)).toBe(value);
  });

  /*
   * The one that earns its keep. A browser on an HTTPS page blocks a mixed
   * `http:` image with no message anywhere — the shop's logo simply does not
   * appear, and nobody in the office ever sees the customer's screen.
   */
  it('refuses plain http, which would silently fail to load for customers', () => {
    expect(() => parseImageUrl('http://cdn.example.com/logo.png')).toThrow(
      ImageUrlNotUnderstoodError,
    );
  });

  /*
   * The case the browser found. An upload writes `/store-images/<id>` into
   * the very column this form shows; refusing it meant that once a shop had
   * an uploaded logo, the address form could not be used AT ALL — opening it
   * to change the banner failed on the logo box, with a message about
   * https:// next to a path this application had put there itself.
   */
  it('takes the path an upload writes, which this form displays', () => {
    expect(parseImageUrl('/store-images/cmtx1ox2v000t7defg6r8kpsa')).toBe(
      '/store-images/cmtx1ox2v000t7defg6r8kpsa',
    );
  });

  it('takes only that exact shape, not any path starting with it', () => {
    for (const value of [
      '/store-images/',
      '/store-images/../../etc/passwd',
      '/store-images/a/b',
      '/store-imagesx/abc',
      '/menu-images/abc',
    ]) {
      expect(() => parseImageUrl(value), value).toThrow(ImageUrlNotUnderstoodError);
    }
  });

  it('refuses anything that is not a link at all', () => {
    for (const value of ['logo.png', 'cdn.example.com/logo.png', 'not a url']) {
      expect(() => parseImageUrl(value), value).toThrow(ImageUrlNotUnderstoodError);
    }
  });

  it('refuses other schemes rather than storing them', () => {
    for (const value of ['ftp://example.com/a.png', 'file:///etc/passwd', 'javascript:void(0)']) {
      expect(() => parseImageUrl(value), value).toThrow(ImageUrlNotUnderstoodError);
    }
  });

  it('refuses a data URL long enough to turn a row into a file store', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_URL_LENGTH)}`;
    expect(() => parseImageUrl(huge)).toThrow(ImageUrlTooLongError);
  });
});

function row(overrides: Partial<ConsoleStoreRow> = {}): ConsoleStoreRow {
  return {
    id: 'store_1',
    name: 'Aling Nena Carinderia',
    slug: 'aling-nena',
    cityId: 'city_pampanga',
    cityName: 'Pampanga',
    isVisible: true,
    isOpen: true,
    serviceKeys: [],
    menuItems: 4,
    members: 1,
    owners: 1,
    pendingInvites: 0,
    readyForCustomers: true,
    logoUrl: null,
    coverUrl: null,
    addressLine: '12 Rehearsal St',
    contactPhone: '+639171234567',
    owner: { name: 'Nena', phone: '+639170000001' },
    orders: 12,
    ...overrides,
  };
}

describe('narrowing the console store list', () => {
  const rows = [
    row(),
    row({ id: 'store_2', name: 'Bulalo Republic', slug: 'bulalo', isOpen: false }),
    row({ id: 'store_3', name: 'Crispy Pares', slug: 'pares', isVisible: false }),
    row({ id: 'store_4', name: 'Dolor Bakeshop', slug: 'dolor', cityId: 'city_manila' }),
  ];

  it('returns everything when nothing is set', () => {
    expect(filterConsoleStores(rows, {})).toHaveLength(4);
  });

  it('narrows by whether the shop is taking orders', () => {
    expect(filterConsoleStores(rows, { status: 'open' }).map((r) => r.id)).toEqual([
      'store_1',
      'store_3',
      'store_4',
    ]);
    expect(filterConsoleStores(rows, { status: 'closed' }).map((r) => r.id)).toEqual([
      'store_2',
    ]);
  });

  it('narrows by whether customers can find it', () => {
    expect(filterConsoleStores(rows, { visibility: 'hidden' }).map((r) => r.id)).toEqual([
      'store_3',
    ]);
  });

  /*
   * This one was a no-op branch when first written — it read the row's city
   * NAME and compared it to the id the select submits, so choosing a city
   * changed nothing and the list looked like it had ignored the click.
   */
  it('narrows by the city id the select actually submits', () => {
    expect(filterConsoleStores(rows, { cityId: 'city_manila' }).map((r) => r.id)).toEqual([
      'store_4',
    ]);
    expect(filterConsoleStores(rows, { cityId: 'city_pampanga' })).toHaveLength(3);
  });

  it('searches the shop, its slug, its address and its owner', () => {
    expect(filterConsoleStores(rows, { search: 'bulalo' }).map((r) => r.id)).toEqual([
      'store_2',
    ]);
    expect(filterConsoleStores(rows, { search: 'nena' })).toHaveLength(4); // owner on every fixture
    expect(filterConsoleStores(rows, { search: 'Rehearsal St' })).toHaveLength(4);
    expect(filterConsoleStores(rows, { search: 'DOLOR' }).map((r) => r.id)).toEqual([
      'store_4',
    ]);
  });

  it('combines filters rather than picking one', () => {
    const found = filterConsoleStores(rows, {
      status: 'open',
      cityId: 'city_pampanga',
      search: 'pares',
    });
    expect(found.map((r) => r.id)).toEqual(['store_3']);
  });

  it('ignores a value it does not recognise instead of matching nothing', () => {
    // These arrive from a query string somebody may have edited; an empty
    // table is a worse answer to a stale link than an unfiltered one.
    expect(filterConsoleStores(rows, { status: 'banana' })).toHaveLength(4);
    expect(filterConsoleStores(rows, { visibility: '' })).toHaveLength(4);
  });
});
