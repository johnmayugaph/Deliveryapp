import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CITY_ERROR_MESSAGES,
  CITY_LIMITS,
  CITY_STANDING_COPY,
  FEE_RULE_ERROR_MESSAGES,
  cityIdFor,
  cityStanding,
  readCityEntry,
  readFeeRule,
  type CityEntryInput,
  type CityFacts,
  type CityFieldError,
  type CityStanding,
  type FeeRuleFieldError,
  type FeeRuleInput,
} from '@/lib/admin/service-areas';

/**
 * Managing the serving area from the console.
 *
 * `City` and `DeliveryFeeRule` could only be written by `prisma/seed.ts`, so
 * operating in a sixth city meant editing a TypeScript file and redeploying.
 * The dangerous half of fixing that is not creating the city — it is that a
 * city with nothing pricing delivery to it appears in the customer's address
 * form and then fails at checkout, which is a failure the operator never sees.
 */

const CITY: CityEntryInput = {
  name: 'Arayat',
  province: 'Pampanga',
  region: 'Central Luzon',
  centroidLat: '15.1500',
  centroidLng: '120.7700',
};

const readCity = (over: Partial<CityEntryInput> = {}, taken: string[] = []) =>
  readCityEntry({ ...CITY, ...over }, taken);

const cityError = (
  over: Partial<CityEntryInput>,
  taken: string[] = [],
): CityFieldError | 'OK' => {
  const result = readCity(over, taken);
  return result.ok ? 'OK' : result.error;
};

// -----------------------------------------------------------------------------
// The identifier
// -----------------------------------------------------------------------------

describe('the identifier made from a city name', () => {
  it('is a readable slug, matching the seeded ids', () => {
    /**
     * `City.id` is a plain String @id and the seeded rows are `city_manila`,
     * `city_cebu`. Deliberate: the ids appear in NEXT_PUBLIC_DEFAULT_CITY_ID,
     * in Service.availableCityIds and in operators' notes, where a cuid is
     * unreadable.
     */
    expect(cityIdFor('Arayat')).toBe('city_arayat');
    expect(cityIdFor('Quezon City')).toBe('city_quezon_city');
    expect(cityIdFor('General Trias')).toBe('city_general_trias');
  });

  it('strips accents rather than dropping the letter', () => {
    // "Biñan" must not become "city_bian".
    expect(cityIdFor('Biñan')).toBe('city_binan');
    expect(cityIdFor('Dasmariñas')).toBe('city_dasmarinas');
  });

  it('collapses punctuation and trims the edges', () => {
    expect(cityIdFor('  Arayat, Pampanga  ')).toBe('city_arayat_pampanga');
    expect(cityIdFor("Lapu-Lapu")).toBe('city_lapu_lapu');
  });

  it('REFUSES a name with nothing usable in it', () => {
    // An id of `city_` would collide with the next such name, so this is a
    // refusal rather than a fallback.
    for (const junk of ['', '   ', '!!!', '---', '。']) {
      expect(cityIdFor(junk), junk).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// Adding a city
// -----------------------------------------------------------------------------

describe('adding a city', () => {
  it('accepts a complete one and derives the id', () => {
    const result = readCity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toEqual({
      id: 'city_arayat',
      name: 'Arayat',
      province: 'Pampanga',
      region: 'Central Luzon',
      centroidLat: 15.15,
      centroidLng: 120.77,
    });
  });

  it('collapses runs of whitespace in the names', () => {
    const result = readCity({ name: '  San   Fernando ', province: ' Pampanga ' });
    expect(result.ok && result.entry.name).toBe('San Fernando');
    expect(result.ok && result.entry.province).toBe('Pampanga');
    expect(result.ok && result.entry.id).toBe('city_san_fernando');
  });

  it('needs a name, a province and a region', () => {
    expect(cityError({ name: 'A' })).toBe('NAME_TOO_SHORT');
    expect(cityError({ name: 'x'.repeat(CITY_LIMITS.name.max + 1) })).toBe(
      'NAME_TOO_LONG',
    );
    expect(cityError({ province: '' })).toBe('PROVINCE_MISSING');
    expect(cityError({ region: ' ' })).toBe('REGION_MISSING');
  });

  it('refuses a name that already exists, by derived id', () => {
    /**
     * By ID rather than by name, which is the point: "arayat" and "Arayat"
     * and "  Arayat " are the same city, and a second row would split its
     * addresses and stores across two ids that nothing reconciles.
     */
    expect(cityError({}, ['city_arayat'])).toBe('ID_TAKEN');
    expect(cityError({ name: 'arayat' }, ['city_arayat'])).toBe('ID_TAKEN');
    expect(cityError({ name: '  ARAYAT  ' }, ['city_arayat'])).toBe('ID_TAKEN');
    // And a different city is fine alongside it.
    expect(cityError({ name: 'Mexico' }, ['city_arayat'])).toBe('OK');
  });

  it('refuses a name no identifier can be made from', () => {
    expect(cityError({ name: '!!!!' })).toBe('ID_UNUSABLE');
  });

  it('needs a map centre, inside the Philippines', () => {
    expect(cityError({ centroidLat: '', centroidLng: '' })).toBe('CENTRE_MISSING');
    expect(cityError({ centroidLat: 'north' })).toBe('CENTRE_MISSING');
    expect(cityError({ centroidLat: undefined })).toBe('CENTRE_MISSING');
    // Transposed, as on the address form: valid floats, wrong hemisphere.
    expect(cityError({ centroidLat: '120.77', centroidLng: '15.15' })).toBe(
      'CENTRE_OUTSIDE_PH',
    );
    expect(cityError({ centroidLat: '48.8566', centroidLng: '2.3522' })).toBe(
      'CENTRE_OUTSIDE_PH',
    );
  });

  it('has a sentence for every refusal', () => {
    for (const [error, message] of Object.entries(CITY_ERROR_MESSAGES)) {
      expect(message.length, error).toBeGreaterThan(10);
      expect(message.trim(), error).toBe(message);
    }
  });
});

// -----------------------------------------------------------------------------
// Delivery pricing
// -----------------------------------------------------------------------------

const RULE: FeeRuleInput = {
  baseFee: '39',
  perKilometre: '12',
  includedMeters: '2000',
  minimumFee: '39',
  serviceFee: '10',
  smallOrderThreshold: '150',
  smallOrderFee: '20',
};

const readRule = (over: Partial<FeeRuleInput> = {}) =>
  readFeeRule({ ...RULE, ...over });

const ruleError = (over: Partial<FeeRuleInput>): FeeRuleFieldError | 'OK' => {
  const result = readRule(over);
  return result.ok ? 'OK' : result.error;
};

describe('reading delivery pricing', () => {
  it('converts pesos to centavos, which is the whole job', () => {
    /**
     * The columns are centavos and the form is pesos. This conversion is the
     * most dangerous thing on the screen: a rule entered as centavos would
     * charge a hundredth of the intended fee and look plausible in the list.
     */
    const result = readRule();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseFeeCentavos).toBe(3900);
    expect(result.entry.perKilometreCentavos).toBe(1200);
    expect(result.entry.serviceFeeCentavos).toBe(1000);
    expect(result.entry.smallOrderThresholdCentavos).toBe(15000);
    expect(result.entry.smallOrderFeeCentavos).toBe(2000);
    expect(result.entry.includedMeters).toBe(2000);
  });

  it('handles centavos exactly, without binary floating point', () => {
    // 19.99 * 100 is 1998.9999999999998; centavosFromPesoInput goes via a
    // string of centavos for exactly this reason.
    expect(readRule({ baseFee: '19.99' }).ok && readRule({ baseFee: '19.99' }));
    const result = readRule({ baseFee: '19.99', perKilometre: '0.05' });
    expect(result.ok && result.entry.baseFeeCentavos).toBe(1999);
    expect(result.ok && result.entry.perKilometreCentavos).toBe(5);
  });

  it('accepts what an operator actually types', () => {
    for (const written of ['39', '39.00', '₱39', '1,039']) {
      expect(ruleError({ baseFee: written }), written).toBe('OK');
    }
  });

  it('refuses three decimal places rather than rounding', () => {
    // Silently charging ₱12.35 for a typed 12.345 is the surprise that ends
    // in a support thread.
    expect(ruleError({ baseFee: '12.345' })).toBe('BASE_FEE_INVALID');
    expect(ruleError({ perKilometre: 'twelve' })).toBe('PER_KM_INVALID');
  });

  it('needs a base fee and a per-kilometre rate — blank is not zero there', () => {
    expect(ruleError({ baseFee: '' })).toBe('BASE_FEE_INVALID');
    expect(ruleError({ baseFee: undefined })).toBe('BASE_FEE_INVALID');
    expect(ruleError({ perKilometre: '' })).toBe('PER_KM_INVALID');
  });

  it('treats a blank optional field as the feature being off', () => {
    const result = readRule({
      maximumFee: '',
      freeAboveSubtotal: '',
      smallOrderThreshold: '',
      smallOrderFee: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.maximumFeeCentavos).toBeNull();
    expect(result.entry.freeAboveSubtotalCentavos).toBeNull();
    expect(result.entry.smallOrderThresholdCentavos).toBeNull();
    // But a fee that defaults to zero is a number, not null: the column is
    // `Int @default(0)` and null would fail the write.
    expect(result.entry.smallOrderFeeCentavos).toBe(0);
    expect(result.entry.minimumFeeCentavos).toBe(3900);
  });

  it('REFUSES a maximum below the minimum', () => {
    /**
     * The one combination no arithmetic can satisfy. `quoteDelivery` clamps to
     * the minimum and then to the maximum, so this silently produces the
     * maximum — a fee below the floor somebody set on purpose.
     */
    expect(ruleError({ minimumFee: '39', maximumFee: '20' })).toBe(
      'MAXIMUM_BELOW_MINIMUM',
    );
    // Equal is fine: it pins the fee.
    expect(ruleError({ minimumFee: '39', maximumFee: '39' })).toBe('OK');
    expect(ruleError({ minimumFee: '39', maximumFee: '100' })).toBe('OK');
  });

  it('REFUSES a small-order fee with no threshold', () => {
    // A control that can never fire, while the operator believes small orders
    // are being charged.
    expect(ruleError({ smallOrderFee: '20', smallOrderThreshold: '' })).toBe(
      'SMALL_ORDER_FEE_WITHOUT_THRESHOLD',
    );
    // A threshold with no fee is harmless — nothing is charged.
    expect(ruleError({ smallOrderFee: '', smallOrderThreshold: '150' })).toBe('OK');
  });

  it('needs whole metres for the included distance', () => {
    expect(ruleError({ includedMeters: '2.5' })).toBe('INCLUDED_METRES_INVALID');
    expect(ruleError({ includedMeters: '-1' })).toBe('INCLUDED_METRES_INVALID');
    expect(ruleError({ includedMeters: 'two' })).toBe('INCLUDED_METRES_INVALID');
    expect(ruleError({ includedMeters: '' })).toBe('OK'); // blank means none
  });

  it('has a sentence for every refusal', () => {
    for (const [error, message] of Object.entries(FEE_RULE_ERROR_MESSAGES)) {
      expect(message.length, error).toBeGreaterThan(10);
      expect(message.trim(), error).toBe(message);
    }
  });
});

// -----------------------------------------------------------------------------
// Whether a city actually works
// -----------------------------------------------------------------------------

const facts = (over: Partial<CityFacts> = {}): CityFacts => ({
  isActive: true,
  launchedServiceKeys: ['FOOD'],
  pricedServiceKeys: ['FOOD'],
  ...over,
});

describe('what standing a city is in', () => {
  it('is ORDERABLE only when it is on, launched and priced', () => {
    expect(cityStanding(facts())).toBe('ORDERABLE');
  });

  it('reports being switched off before anything else', () => {
    // It makes every other question moot, so it is checked first.
    expect(cityStanding(facts({ isActive: false }))).toBe('SWITCHED_OFF');
    expect(
      cityStanding(facts({ isActive: false, launchedServiceKeys: [], pricedServiceKeys: [] })),
    ).toBe('SWITCHED_OFF');
  });

  it('separates "no service" from "not priced"', () => {
    /**
     * THE distinction this type exists for, because the two need opposite
     * words: no service is a city that politely says it is closed, and no
     * price is a city where checkout FAILS.
     */
    expect(
      cityStanding(facts({ launchedServiceKeys: [], pricedServiceKeys: [] })),
    ).toBe('NO_SERVICE_LAUNCHED');
    expect(cityStanding(facts({ pricedServiceKeys: [] }))).toBe('NO_FEE_RULE');
  });

  it('is orderable when ONE of several launched services is priced', () => {
    // A second unpriced vertical is a gap to report, not a reason to call the
    // city broken — food still works.
    expect(
      cityStanding(
        facts({ launchedServiceKeys: ['FOOD', 'MART'], pricedServiceKeys: ['FOOD'] }),
      ),
    ).toBe('ORDERABLE');
  });

  it('ignores a price for a service that is not launched here', () => {
    // A fallback rule for MART does not make a city orderable if MART is not
    // live in it.
    expect(
      cityStanding(
        facts({ launchedServiceKeys: ['FOOD'], pricedServiceKeys: ['MART'] }),
      ),
    ).toBe('NO_FEE_RULE');
  });

  it('gives every standing words, a tone and a fix', () => {
    const standings: CityStanding[] = [
      'ORDERABLE',
      'NO_SERVICE_LAUNCHED',
      'NO_FEE_RULE',
      'SWITCHED_OFF',
    ];
    for (const standing of standings) {
      const copy = CITY_STANDING_COPY[standing];
      expect(copy.label.length, standing).toBeGreaterThan(3);
      expect(copy.detail.length, standing).toBeGreaterThan(20);
    }
    // Only the one that breaks checkout is red.
    expect(CITY_STANDING_COPY.NO_FEE_RULE.tone).toBe('bad');
    expect(CITY_STANDING_COPY.ORDERABLE.tone).toBe('good');
  });
});

// -----------------------------------------------------------------------------
// The actions around them
// -----------------------------------------------------------------------------

describe('the actions', () => {
  const source = readFileSync('src/lib/actions/admin-actions.ts', 'utf8');
  const slice = (name: string) => {
    const start = source.indexOf(`export async function ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    const next = source.indexOf('\nexport async function ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it('each one writes an audit row with a reason', () => {
    // The rule for this file: everything in it moves money, roles or access.
    for (const name of ['createCityAction', 'updateCityAction', 'setDeliveryFeeRuleAction']) {
      const body = slice(name);
      expect(body, name).toMatch(/normaliseReason\(formData\.get\('reason'\)\)/);
      expect(body, name).toMatch(/recordAdminAction\(/);
      expect(body, name).toMatch(/requireAdmin\(\)/);
    }
  });

  it('a rename does NOT change the city id', () => {
    /**
     * `City.id` is referenced by Service.availableCityIds, by every Address
     * and Store row in it, and possibly by NEXT_PUBLIC_DEFAULT_CITY_ID.
     * `readCityEntry` derives an id from the new name and the update has to
     * throw it away — so the update block must set the label columns and not
     * `id`.
     */
    const body = slice('updateCityAction');
    const update = body.slice(body.indexOf('tx.city.update'));
    expect(update).toMatch(/name: read\.entry\.name/);
    expect(update).toMatch(/centroidLat: read\.entry\.centroidLat/);
    expect(update).not.toMatch(/id: read\.entry\.id/);
  });

  it('switching a city off does not touch its addresses, stores or orders', () => {
    // Cancelling somebody's dinner because an operator unticked a box would be
    // a much worse answer than a city that stops taking new orders.
    const body = slice('updateCityAction');
    expect(body).toMatch(/data: \{ isActive \}/);
    // Counted and reported, never written.
    expect(body).toMatch(/address\.count/);
    expect(body).toMatch(/store\.count/);
    expect(body).not.toMatch(/address\.updateMany|store\.updateMany|order\.updateMany/);
  });

  it('upserts the fee rule by hand, because the fallback key is nullable', () => {
    /**
     * The unique key is the composite [serviceType, cityId] and `cityId` is
     * nullable — Postgres treats NULLs as distinct in a unique index, so the
     * fallback row cannot be addressed by that key and `upsert` cannot find
     * it.
     */
    const body = slice('setDeliveryFeeRuleAction');
    expect(body).toMatch(/deliveryFeeRule\.findFirst/);
    expect(body).toMatch(/deliveryFeeRule\.update/);
    expect(body).toMatch(/deliveryFeeRule\.create/);
    expect(body).not.toMatch(/deliveryFeeRule\.upsert/);
  });

  it('reads an empty city as the fallback rule rather than as missing', () => {
    const body = slice('setDeliveryFeeRuleAction');
    expect(body).toMatch(/rawCityId === '' \? null : rawCityId/);
  });
});
