import { prisma } from '@/lib/prisma';

/**
 * Which features exist in full and are doing nothing, because the rows they
 * read have never been created.
 *
 * A deployment rehearsal is what produced this file. Three separate things
 * were sitting at zero on a database provisioned exactly as the documentation
 * said, and every one of them fails the same way: quietly, with the feature
 * present in the code, tested, and inert.
 *
 * The point is NOT that the zeros are wrong. Launching with no surge is a
 * reasonable choice, and so is launching with no points programme. The point
 * is that today there is nowhere an operator can look and see which choices
 * they have made by accident.
 *
 * Deliberately not part of `/api/health`: that route is public and says
 * nothing but whether this instance can serve.
 */

export type MissingOperatingData =
  | 'NO_CITY'
  | 'NO_ACTIVE_SERVICE'
  | 'NO_DELIVERY_FEE_RULE'
  | 'NO_LOYALTY_PROGRAMME'
  | 'NO_LOYALTY_TIER'
  | 'NO_SURGE_BAND';

/**
 * How this one is fixed.
 *
 * Two shapes, because two of these have no screen. `City` and
 * `DeliveryFeeRule` rows are created by `prisma/seed.ts` and by nothing else
 * — no console page, no script — so pointing an operator at a page that
 * cannot create one would be worse than saying so.
 */
export type OperatingDataFix =
  | { kind: 'screen'; href: string }
  | { kind: 'command'; command: string; note: string };

export interface OperatingDataGap {
  what: MissingOperatingData;
  /** What is switched off, in the words of somebody it happens to. */
  consequence: string;
  fix: OperatingDataFix;
}

/**
 * Ordered worst-first: the first three stop the app doing its job at all, the
 * last three switch a feature off.
 */
const SEED_ONLY: OperatingDataFix = {
  kind: 'command',
  command: 'npm run db:setup && npm run db:purge-demo -- --confirm',
  note:
    'These rows come from the seed and from nowhere else — there is no screen ' +
    'that creates one. The purge afterwards removes the demo accounts and ' +
    'shops and keeps exactly this operating data.',
};

const GAP: Readonly<Record<MissingOperatingData, Omit<OperatingDataGap, 'what'>>> = {
  NO_CITY: {
    consequence:
      'There are no cities. Nobody can set an address and no shop can be ' +
      'created, so no order can be placed at all.',
    fix: SEED_ONLY,
  },
  NO_ACTIVE_SERVICE: {
    consequence:
      'No service is active. Every customer sees "No service is available in ' +
      'your area yet" and there is nothing they can do — the home page ' +
      'answers 200 and looks deliberate.',
    fix: { kind: 'screen', href: '/admin/services' },
  },
  NO_DELIVERY_FEE_RULE: {
    consequence:
      'There are no delivery fee rules, so no distance can be priced and ' +
      'checkout cannot quote a fee.',
    fix: SEED_ONLY,
  },
  NO_LOYALTY_PROGRAMME: {
    consequence:
      'No points programme exists, so no customer earns points — which means ' +
      'no tiers, and no tier benefits, however many are configured.',
    fix: { kind: 'screen', href: '/admin/loyalty' },
  },
  NO_LOYALTY_TIER: {
    consequence:
      'The points programme has no tiers, so points accumulate and confer ' +
      'nothing. Nobody is ever Suki or Tapat.',
    fix: { kind: 'screen', href: '/admin/loyalty' },
  },
  NO_SURGE_BAND: {
    consequence:
      'There are no surge bands, so busy periods are never priced and riders ' +
      'never earn a multiplier. Fine as a launch choice, worth knowing if it ' +
      'was not one.',
    fix: { kind: 'screen', href: '/admin/surge' },
  },
};

export async function operatingDataGaps(): Promise<OperatingDataGap[]> {
  const [cities, activeServices, feeRules, programmes, tiers, surgeBands] =
    await Promise.all([
      prisma.city.count(),
      prisma.service.count({ where: { isActive: true } }),
      prisma.deliveryFeeRule.count(),
      prisma.loyaltyProgramme.count(),
      prisma.loyaltyTier.count(),
      prisma.surgeBand.count(),
    ]);

  const missing: MissingOperatingData[] = [];
  if (cities === 0) missing.push('NO_CITY');
  if (activeServices === 0) missing.push('NO_ACTIVE_SERVICE');
  if (feeRules === 0) missing.push('NO_DELIVERY_FEE_RULE');
  if (programmes === 0) missing.push('NO_LOYALTY_PROGRAMME');
  // Only worth saying when there IS a programme: with no programme at all the
  // line above already covers it, and two rows about the same absence read
  // like two problems.
  else if (tiers === 0) missing.push('NO_LOYALTY_TIER');
  if (surgeBands === 0) missing.push('NO_SURGE_BAND');

  return missing.map((what) => ({ what, ...GAP[what] }));
}
