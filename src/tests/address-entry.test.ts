import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ERROR_MESSAGES,
  ADDRESS_LIMITS,
  readAddressEntry,
  shouldBeDefault,
  type AddressEntryInput,
  type AddressFieldError,
} from '@/lib/addresses/entry';

/**
 * Saving a delivery address.
 *
 * This module exists because of a gap rather than a defect: `/checkout`
 * refused an order with no address and linked to `/addresses` saying "Add an
 * address", and that page offered no way to add one. The seed writes addresses
 * for the demo accounts, so nothing was visibly wrong until the demo data was
 * purged — which is the first thing a real deployment does.
 */

const CITIES = [
  { id: 'city_manila', province: 'Metro Manila' },
  { id: 'city_makati', province: 'Metro Manila' },
];

/** Manila City Hall, near enough. */
const GOOD: AddressEntryInput = {
  label: 'Home',
  line1: '24 Kalayaan Ave',
  cityId: 'city_manila',
  latitude: '14.6042',
  longitude: '120.9822',
};

const read = (over: Partial<AddressEntryInput> = {}) =>
  readAddressEntry({ ...GOOD, ...over }, CITIES);

const errorOf = (over: Partial<AddressEntryInput>): AddressFieldError | 'OK' => {
  const result = read(over);
  return result.ok ? 'OK' : result.error;
};

describe('a complete address', () => {
  it('is accepted, with the province taken from the city', () => {
    const result = read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.province).toBe('Metro Manila');
    expect(result.entry.cityId).toBe('city_manila');
    expect(result.entry.latitude).toBeCloseTo(14.6042, 4);
  });

  it('never asks for the province, so the two cannot disagree', () => {
    // Asserted against the input type rather than the behaviour: a `province`
    // field appearing on the form is the regression this guards.
    const source = readFileSync('src/lib/addresses/entry.ts', 'utf8');
    const start = source.indexOf('export interface AddressEntryInput');
    // The interface body only — the next declaration's doc comment legitimately
    // mentions the province, and a slice that swallowed it would fail forever.
    const inputBlock = source.slice(start, source.indexOf('\n}', start));
    expect(inputBlock).toMatch(/isPickupCapable/); // the slice is the right one
    expect(inputBlock).not.toMatch(/province/);
  });

  it('trims, and turns a blank optional field into null rather than ""', () => {
    /**
     * `null` and `undefined` are not interchangeable here: in a Prisma `data`
     * block `undefined` means "do not change this column". An empty string
     * would also be wrong — a landmark of "" renders as an empty line on the
     * rider's screen.
     */
    const result = read({
      label: '  Home  ',
      line2: '   ',
      barangay: '',
      landmark: '   ',
      deliveryNotes: '',
      contactName: '  ',
      contactPhone: '   ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.label).toBe('Home');
    for (const value of [
      result.entry.line2,
      result.entry.barangay,
      result.entry.landmark,
      result.entry.deliveryNotes,
      result.entry.contactName,
      result.entry.contactPhone,
    ]) {
      expect(value).toBeNull();
    }
  });

  it('normalises the contact number to E.164', () => {
    for (const written of ['09171234567', '0917 123 4567', '+639171234567']) {
      const result = read({ contactPhone: written });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.contactPhone).toBe('+639171234567');
    }
  });

  it('treats the pickup flag as opt-in', () => {
    const off = read();
    const on = read({ isPickupCapable: true });
    expect(off.ok && off.entry.isPickupCapable).toBe(false);
    expect(on.ok && on.entry.isPickupCapable).toBe(true);
  });
});

describe('what is refused', () => {
  it('needs a name, a street and a city', () => {
    expect(errorOf({ label: '' })).toBe('LABEL_MISSING');
    expect(errorOf({ label: '   ' })).toBe('LABEL_MISSING');
    expect(errorOf({ label: 'x'.repeat(ADDRESS_LIMITS.label.max + 1) })).toBe(
      'LABEL_TOO_LONG',
    );
    expect(errorOf({ line1: 'no' })).toBe('LINE1_TOO_SHORT');
    expect(errorOf({ line1: 'x'.repeat(ADDRESS_LIMITS.line1.max + 1) })).toBe(
      'LINE1_TOO_LONG',
    );
  });

  it('refuses a city this deployment does not have', () => {
    /**
     * `City` rows are seed-only, so an id that is not on the list is a typo or
     * somebody probing a hand-edited form. Either way the answer is the same.
     */
    expect(errorOf({ cityId: 'city_cebu' })).toBe('CITY_UNKNOWN');
    expect(errorOf({ cityId: '' })).toBe('CITY_UNKNOWN');
    expect(errorOf({ cityId: undefined })).toBe('CITY_UNKNOWN');
  });

  it('refuses a missing or unreadable pin', () => {
    expect(errorOf({ latitude: '', longitude: '' })).toBe('COORDINATES_MISSING');
    expect(errorOf({ latitude: undefined })).toBe('COORDINATES_MISSING');
    expect(errorOf({ latitude: 'north' })).toBe('COORDINATES_MISSING');
    expect(errorOf({ latitude: 'NaN' })).toBe('COORDINATES_MISSING');
  });

  it('refuses a pin outside the Philippines — including a TRANSPOSED pair', () => {
    /**
     * The check that earns its keep. Swapping the two numbers produces two
     * perfectly valid floats and a point in the sea off Somalia, where the
     * distance-based delivery fee is enormous rather than obviously wrong. It
     * does not fail; it charges the wrong money.
     */
    expect(errorOf({ latitude: '120.9822', longitude: '14.6042' })).toBe(
      'COORDINATES_OUTSIDE_PH',
    );
    expect(errorOf({ latitude: '48.8566', longitude: '2.3522' })).toBe(
      'COORDINATES_OUTSIDE_PH',
    );
    expect(errorOf({ latitude: '0', longitude: '0' })).toBe('COORDINATES_OUTSIDE_PH');
  });

  it('refuses a contact number that is not a Philippine mobile', () => {
    expect(errorOf({ contactPhone: '12345' })).toBe('CONTACT_PHONE_INVALID');
    expect(errorOf({ contactPhone: '+15551234567' })).toBe('CONTACT_PHONE_INVALID');
    expect(errorOf({ contactPhone: '028123456' })).toBe('CONTACT_PHONE_INVALID');
  });

  it('refuses an over-long optional field', () => {
    expect(errorOf({ landmark: 'x'.repeat(ADDRESS_LIMITS.landmark.max + 1) })).toBe(
      'TOO_LONG',
    );
    expect(
      errorOf({ deliveryNotes: 'x'.repeat(ADDRESS_LIMITS.deliveryNotes.max + 1) }),
    ).toBe('TOO_LONG');
    // And the limit itself is allowed, so the boundary is not off by one.
    expect(errorOf({ landmark: 'x'.repeat(ADDRESS_LIMITS.landmark.max) })).toBe('OK');
  });

  it('has a sentence for every refusal, and none of them is empty', () => {
    // A refusal with no words is the failure mode this table prevents.
    for (const [error, message] of Object.entries(ADDRESS_ERROR_MESSAGES)) {
      expect(message.length, error).toBeGreaterThan(10);
      expect(message.trim(), error).toBe(message);
    }
  });
});

describe('which address is the default', () => {
  it('makes the first one the default whatever was asked', () => {
    // /checkout pre-selects the default, so a book where nothing is default
    // makes the first order one extra decision for no reason.
    expect(shouldBeDefault({ existingCount: 0, asked: false })).toBe(true);
    expect(shouldBeDefault({ existingCount: 0, asked: true })).toBe(true);
  });

  it('afterwards, only when asked', () => {
    expect(shouldBeDefault({ existingCount: 1, asked: false })).toBe(false);
    expect(shouldBeDefault({ existingCount: 3, asked: true })).toBe(true);
  });
});

describe('the action around it', () => {
  const action = readFileSync('src/lib/actions/address-actions.ts', 'utf8');

  it('reads only ACTIVE cities, so the book cannot hold an undeliverable one', () => {
    expect(action).toMatch(/isActive: true/);
  });

  it('clears the previous default in the SAME transaction as the write', () => {
    /**
     * Two defaults would make the checkout pre-selection depend on row order —
     * a bug that only appears for the customer who has three addresses.
     */
    const tx = action.slice(action.indexOf('prisma.$transaction'));
    expect(tx).toMatch(/isDefault: true/);
    expect(tx).toMatch(/address\.create/);
    expect(tx.indexOf('isDefault: true')).toBeLessThan(tx.indexOf('address.create'));
  });

  it('goes through requireScreen rather than reading the session itself', () => {
    // A bare getCurrentUser() on a private screen is how all six of the
    // session-gone defects were written.
    expect(action).toMatch(/requireScreen\('addresses'\)/);
    expect(action).not.toMatch(/getCurrentUser/);
  });
});
