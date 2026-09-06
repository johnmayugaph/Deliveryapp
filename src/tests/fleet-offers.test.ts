import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DispatchOfferStatus, OrderActor, OrderStatus, ServiceKey } from '@prisma/client';
import {
  acceptanceRateForRanking,
  CLOSED_OFFER_STATUSES,
  computeAcceptanceRate,
  DEFAULT_ACCEPTANCE_RATE,
  isOfferLive,
  offerSecondsRemaining,
  OFFER_FANOUT,
  OFFER_TTL_SECONDS,
  partnerEarningsCentavos,
  REFANOUT_AFTER_SECONDS,
} from '@/lib/fleet/offer-policy';
import { ACTIVE_JOB_STATUSES } from '@/lib/fleet/partner';
import { isActorPermitted, allowedTransitions } from '@/lib/orders/state-machine';
import { ORDER_LIFECYCLES } from '@/lib/orders/transitions';

const NOW = new Date('2026-09-06T12:00:00.000Z');

describe('acceptance rate', () => {
  it('is null for a partner who has answered nothing', () => {
    // A brand-new partner is not a 0% partner, and dispatch ranking treats the
    // two very differently.
    expect(
      computeAcceptanceRate({ accepted: 0, declined: 0, expired: 0, superseded: 0 }),
    ).toBeNull();
  });

  it('gives a new partner the benefit of the doubt for ranking', () => {
    expect(
      acceptanceRateForRanking({ accepted: 0, declined: 0, expired: 0, superseded: 0 }),
    ).toBe(DEFAULT_ACCEPTANCE_RATE);
    expect(DEFAULT_ACCEPTANCE_RATE).toBe(1);
  });

  it('counts accepted over everything decided', () => {
    expect(
      computeAcceptanceRate({ accepted: 3, declined: 1, expired: 0, superseded: 0 }),
    ).toBeCloseTo(0.75);
  });

  it('counts an expired offer against the partner — ignoring your phone is a choice', () => {
    expect(
      computeAcceptanceRate({ accepted: 1, declined: 0, expired: 1, superseded: 0 }),
    ).toBe(0.5);
  });

  it('EXCLUDES superseded offers entirely', () => {
    // Being beaten to a job by a closer partner is not a decision the partner
    // made; counting it would punish people for working in a busy area.
    const withoutRaces = computeAcceptanceRate({
      accepted: 2, declined: 0, expired: 0, superseded: 0,
    });
    const withManyRaces = computeAcceptanceRate({
      accepted: 2, declined: 0, expired: 0, superseded: 50,
    });
    expect(withManyRaces).toBe(withoutRaces);
    expect(withManyRaces).toBe(1);
  });

  it('does not divide by zero when only superseded offers exist', () => {
    expect(
      computeAcceptanceRate({ accepted: 0, declined: 0, expired: 0, superseded: 9 }),
    ).toBeNull();
  });

  it('reaches zero for a partner who answers nothing', () => {
    expect(
      computeAcceptanceRate({ accepted: 0, declined: 2, expired: 3, superseded: 0 }),
    ).toBe(0);
  });
});

describe('offer windows', () => {
  const live = { status: DispatchOfferStatus.PENDING, expiresAt: new Date(NOW.getTime() + 30_000) };

  it('is live while pending and unexpired', () => {
    expect(isOfferLive(live, NOW)).toBe(true);
  });

  it('is dead once expired', () => {
    expect(isOfferLive({ ...live, expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });

  it('is dead once answered, whatever the clock says', () => {
    for (const status of CLOSED_OFFER_STATUSES) {
      expect(isOfferLive({ ...live, status }, NOW)).toBe(false);
    }
  });

  it('counts down to zero and never below', () => {
    expect(offerSecondsRemaining({ expiresAt: new Date(NOW.getTime() + 30_000) }, NOW)).toBe(30);
    expect(offerSecondsRemaining({ expiresAt: new Date(NOW.getTime() - 60_000) }, NOW)).toBe(0);
  });

  it('re-fans out only after less than the offer window', () => {
    // Otherwise a batch would be replaced before anyone had a fair chance to
    // answer it.
    expect(REFANOUT_AFTER_SECONDS).toBeLessThan(OFFER_TTL_SECONDS);
  });

  it('offers to several partners at once, not one at a time', () => {
    // A sequential cascade with a 60-second window means a customer can wait
    // five minutes while five partners ignore their phone.
    expect(OFFER_FANOUT).toBeGreaterThan(1);
  });
});

describe('what a partner earns', () => {
  it('is the delivery fee plus the whole tip', () => {
    expect(partnerEarningsCentavos({ deliveryFeeCentavos: 4_900, tipCentavos: 2_000 })).toBe(6_900);
  });

  it('pays the full fee even when a subscription waived it for the customer', () => {
    // The waiver is our marketing cost, not a pay cut for the person doing the
    // ride — which works because the order keeps the fee at full value and
    // records the waiver as a discount.
    const order = { deliveryFeeCentavos: 4_900, tipCentavos: 0 };
    expect(partnerEarningsCentavos(order)).toBe(4_900);
  });

  it('pays nothing extra for a large order', () => {
    // Earnings are distance-and-tip based; a bigger basket is not more work.
    expect(partnerEarningsCentavos({ deliveryFeeCentavos: 3_900, tipCentavos: 0 })).toBe(3_900);
  });
});

describe('active job statuses', () => {
  it('covers every post-assignment state a partner can be in', () => {
    for (const key of Object.values(ServiceKey)) {
      const lifecycle = ORDER_LIFECYCLES[key];
      const reachable = new Set(Object.values(lifecycle.transitions).flat());
      for (const status of reachable) {
        // Two things are not "holding the job". Cancelling: support and the
        // partner can end an order from many places. And ACCEPTING — the
        // transition into RIDER_ASSIGNED is how a job starts, not proof of one.
        // What marks an active job is a partner advancing an order they hold.
        const partnerAdvances = allowedTransitions(key, status)
          .filter(
            (to) =>
              !to.startsWith('CANCELLED') &&
              to !== OrderStatus.FAILED_DELIVERY &&
              to !== OrderStatus.RIDER_ASSIGNED,
          )
          .some((to) => isActorPermitted(key, to, OrderActor.FLEET_PARTNER));

        if (partnerAdvances) {
          expect(
            ACTIVE_JOB_STATUSES.includes(status),
            `${key}: ${status} lets a partner advance the order but is not an active-job status`,
          ).toBe(true);
        }
      }
    }
  });

  it('excludes terminal statuses', () => {
    for (const key of Object.values(ServiceKey)) {
      for (const status of ORDER_LIFECYCLES[key].terminalStatuses) {
        expect(ACTIVE_JOB_STATUSES).not.toContain(status);
      }
    }
  });

  it('excludes the pre-assignment states', () => {
    for (const status of [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      OrderStatus.PREPARING,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    ]) {
      expect(ACTIVE_JOB_STATUSES).not.toContain(status);
    }
  });
});

describe('partner transitions come from the map', () => {
  it('lets a partner accept an offer in every vertical that dispatches', () => {
    for (const key of Object.values(ServiceKey)) {
      const reachable = new Set(Object.values(ORDER_LIFECYCLES[key].transitions).flat());
      if (!reachable.has(OrderStatus.RIDER_ASSIGNED)) continue;
      expect(isActorPermitted(key, OrderStatus.RIDER_ASSIGNED, OrderActor.FLEET_PARTNER)).toBe(true);
    }
  });

  it('gives a RIDE its own steps, not a food-shaped chain', () => {
    expect(
      allowedTransitions(ServiceKey.RIDE, OrderStatus.RIDER_AT_PICKUP),
    ).toContain(OrderStatus.PASSENGER_ONBOARD);
    expect(
      allowedTransitions(ServiceKey.RIDE, OrderStatus.ARRIVED_AT_DROPOFF),
    ).toContain(OrderStatus.DROPPED_OFF);
    // A ride is never "delivered".
    expect(
      allowedTransitions(ServiceKey.RIDE, OrderStatus.ARRIVED_AT_DROPOFF),
    ).not.toContain(OrderStatus.DELIVERED);
  });

  it('lets a partner hand an assigned order back to dispatch', () => {
    // abandonJobAction relies on this being legal, so the food on the counter
    // can still be collected by somebody else.
    expect(
      allowedTransitions(ServiceKey.FOOD, OrderStatus.RIDER_ASSIGNED),
    ).toContain(OrderStatus.AWAITING_RIDER_ASSIGNMENT);
  });

  it('does not let a partner cancel once they are carrying the goods without it being theirs', () => {
    const inTransit = allowedTransitions(ServiceKey.FOOD, OrderStatus.IN_TRANSIT);
    expect(inTransit).toContain(OrderStatus.CANCELLED_BY_RIDER);
    // But the customer can no longer pull it out from under them.
    expect(inTransit).not.toContain(OrderStatus.CANCELLED_BY_CUSTOMER);
  });
});

describe('a rider cannot cancel an order that has no rider', () => {
  it('offers no rider cancellation before dispatch could begin', () => {
    // The map should not assert something untrue: an order still waiting on
    // payment or on the merchant has nobody assigned to give up on it.
    for (const key of Object.values(ServiceKey)) {
      for (const status of [
        OrderStatus.DRAFT,
        OrderStatus.PENDING_PAYMENT,
        OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      ]) {
        expect(
          allowedTransitions(key, status),
          `${key}: ${status} offers CANCELLED_BY_RIDER`,
        ).not.toContain(OrderStatus.CANCELLED_BY_RIDER);
      }
    }
  });

  it('does offer it once a partner may be assigned', () => {
    // Dispatch runs alongside the kitchen, so a partner can be on the job while
    // food is still cooking.
    for (const status of [
      OrderStatus.MERCHANT_ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      OrderStatus.RIDER_ASSIGNED,
    ]) {
      expect(allowedTransitions(ServiceKey.FOOD, status)).toContain(
        OrderStatus.CANCELLED_BY_RIDER,
      );
    }
  });

  it('still lets the customer cancel before dispatch', () => {
    for (const status of [OrderStatus.DRAFT, OrderStatus.PENDING_MERCHANT_ACCEPTANCE]) {
      expect(allowedTransitions(ServiceKey.FOOD, status)).toContain(
        OrderStatus.CANCELLED_BY_CUSTOMER,
      );
    }
  });
});

/**
 * `FleetPartner.acceptanceRate` is a ranking input with a benefit-of-the-doubt
 * default of 1, so it always holds a number — including for a partner who has
 * never been offered anything. Showing that number to the partner reads as a
 * measurement, which is how the offers board came to display "94%" beside an
 * empty history. Both partner-facing screens must compute the figure from the
 * offer records instead, where "no history" is expressible.
 */
describe('the partner-facing acceptance rate', () => {
  const SCREENS = ['app/fleet/page.tsx', 'app/fleet/profile/page.tsx'];

  for (const screen of SCREENS) {
    it(`${screen} computes it from the offer records`, () => {
      const source = readFileSync(path.resolve(__dirname, '..', screen), 'utf8');
      expect(source).toContain('computeAcceptanceRate');
      expect(source).not.toMatch(/earnings\.acceptanceRate/);
    });
  }

  it('has no second source of truth to read from', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', 'lib/fleet/partner.ts'),
      'utf8',
    );
    // The ranking column may be read for ranking; it must not be re-exported
    // as part of the earnings a screen renders.
    expect(source).not.toMatch(/acceptanceRate: (number|partner\.acceptanceRate)/);
  });
});
