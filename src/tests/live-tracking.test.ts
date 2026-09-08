import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrderStatus, type ServiceKey } from '@prisma/client';
import {
  POSITION_FRESH_MS,
  SHARE_FLUSH_MS,
  SHARE_INTERVAL_MS,
  SHARE_MIN_METRES,
  TRACKABLE_STATUSES,
  TRACKING_POLL_MS,
  describeDistance,
  describeFix,
  isTrackableStatus,
  metresToDropoff,
  positionIsFresh,
  readCoordinate,
  shouldShareFix,
} from '@/lib/orders/tracking';
import { ACTIVE_JOB_STATUSES } from '@/lib/fleet/job-policy';
import { isTerminal } from '@/lib/orders/state-machine';
import { ORDER_LIFECYCLES } from '@/lib/orders/transitions';

/**
 * Live tracking.
 *
 * Three rules decide whether this is honest or merely impressive, and most of
 * what follows is about them: a pin appears only while somebody is carrying
 * the order, only when the fix is recent, and only for the customer whose
 * order it is.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

describe('when a pin is shown at all', () => {
  it('tracks exactly the statuses where somebody is carrying it', () => {
    // The same list the rider's own screen uses to decide what their current
    // job is, rather than a second one that could drift from it.
    expect(TRACKABLE_STATUSES).toBe(ACTIVE_JOB_STATUSES);
  });

  it('shows nothing before a rider is assigned', () => {
    for (const status of [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      OrderStatus.PREPARING,
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    ]) {
      expect(isTrackableStatus(status), status).toBe(false);
    }
  });

  it('shows nothing once an order is finished, in any vertical', () => {
    // Where a rider went after dropping the food off is nobody's business,
    // and this is the check that says so for every lifecycle rather than for
    // the food one somebody was looking at.
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      for (const status of lifecycle.terminalStatuses) {
        expect(isTrackableStatus(status), `${key}/${status}`).toBe(false);
        expect(isTerminal(key as ServiceKey, status)).toBe(true);
      }
    }
  });

  it('does track the states where a rider is on the move', () => {
    for (const status of [
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.PICKED_UP,
      OrderStatus.IN_TRANSIT,
      OrderStatus.ARRIVED_AT_DROPOFF,
    ]) {
      expect(isTrackableStatus(status), status).toBe(true);
    }
  });
});

describe('the pure modules stay usable from the browser', () => {
  it('lets a client component read the tracking rules', () => {
    // The fourth time this codebase has met this trap, and the first time it
    // took a page down: `tracking.ts` is imported by the customer's map, so a
    // path from it to `next/headers` is a 500 on the tracking screen. It got
    // there through `fleet/partner.ts`, which reaches for the session — hence
    // `fleet/job-policy.ts`.
    // `pricing/benefits.ts` joined the list when the checkout screen started
    // importing `describeWithheld` from it to explain a benefit that did not
    // apply. It is arithmetic and must stay that way: a path from it to the
    // Prisma client or the session would be a 500 on the checkout screen,
    // which is the fifth time this codebase has met this trap.
    // `merchant/roles.ts` joined it when the back-office tab bar started
    // hiding tabs a member's role cannot open. The ladder used to live in
    // `merchant/access.ts`, which reaches Prisma AND the session — importing
    // that from a `'use client'` component would be the sixth time.
    for (const file of [
      'src/lib/orders/tracking.ts',
      'src/lib/fleet/job-policy.ts',
      'src/lib/pricing/benefits.ts',
      'src/lib/merchant/roles.ts',
      'src/lib/merchant/tier-view.ts',
    ]) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/next\/headers/);
      expect(code, file).not.toMatch(/from '@\/lib\/prisma'/);
      expect(code, file).not.toMatch(/@\/lib\/auth\/session/);
      expect(code, file).not.toMatch(/@\/lib\/fleet\/partner/);
    }
  });

  it('keeps the list in one place', () => {
    // Re-exported from where it used to live, so nothing that already
    // imported it had to change.
    expect(source('src/lib/fleet/partner.ts')).toMatch(/export \{ ACTIVE_JOB_STATUSES \}/);
    expect(source('src/lib/merchant/access.ts')).toMatch(/export \{ roleSatisfies \}/);
  });
});

describe('freshness, which is the difference between useful and misleading', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

  it('accepts a recent fix', () => {
    expect(positionIsFresh(secondsAgo(5), now)).toBe(true);
    expect(positionIsFresh(secondsAgo(60), now)).toBe(true);
  });

  it('refuses one that has gone quiet', () => {
    // A pin from eleven minutes ago is a confident wrong answer: the customer
    // stands at the gate watching a stationary motorcycle that is three
    // barangays away.
    expect(positionIsFresh(secondsAgo(91), now)).toBe(false);
    expect(positionIsFresh(secondsAgo(600), now)).toBe(false);
  });

  it('survives a phone whose clock is ahead', () => {
    // A fix "from the future" is a clock disagreement, not freshness — and it
    // is not the customer's problem.
    expect(positionIsFresh(new Date(now.getTime() + 30_000), now)).toBe(true);
  });

  it('leaves room for an ordinary gap', () => {
    // Several sharing intervals, so a tunnel or a dropped packet does not
    // blank the map.
    expect(POSITION_FRESH_MS).toBeGreaterThan(SHARE_INTERVAL_MS * 4);
  });

  it('says how old the fix is in words', () => {
    expect(describeFix(secondsAgo(3), now)).toBe('just now');
    expect(describeFix(secondsAgo(40), now)).toBe('40s ago');
    expect(describeFix(secondsAgo(130), now)).toBe('2 min ago');
  });
});

describe('what the rider’s phone sends, and how often', () => {
  const base = { latitude: 14.6, longitude: 121.0, at: 1_000_000 };

  it('always sends the first fix', () => {
    expect(shouldShareFix(null, base, base.at)).toBe(true);
  });

  it('stays quiet at a red light', () => {
    // Same place, plenty of time: nothing to say.
    const later = { ...base, at: base.at + SHARE_INTERVAL_MS * 3 };
    expect(shouldShareFix(base, later, later.at)).toBe(false);
  });

  it('stays quiet on a highway between intervals', () => {
    // Moved far, but too soon: forty writes a minute is a battery and a
    // database cost with no benefit.
    const soon = { latitude: 14.61, longitude: 121.01, at: base.at + 2_000 };
    expect(shouldShareFix(base, soon, soon.at)).toBe(false);
  });

  it('sends a held fix once the interval has passed, even if it was taken early', () => {
    // The bug this replaces: the interval was measured between the two
    // READINGS, so a fix taken two seconds after the last write was two
    // seconds after it forever and could never be sent. `watchPosition`
    // reports movement, so a rider who moved and then stopped got no further
    // callback and the position they stopped at was never written — the
    // customer's map stayed a block behind for as long as they stood there.
    const early = { latitude: 14.61, longitude: 121.01, at: base.at + 2_000 };
    expect(shouldShareFix(base, early, early.at)).toBe(false);
    expect(shouldShareFix(base, early, base.at + SHARE_INTERVAL_MS + 1)).toBe(true);
  });

  it('sends when both are true', () => {
    const moved = {
      latitude: base.latitude + 0.001, // ~110m
      longitude: base.longitude,
      at: base.at + SHARE_INTERVAL_MS + 1,
    };
    expect(shouldShareFix(base, moved, moved.at)).toBe(true);
  });

  it('holds the distance filter just under and just over', () => {
    const at = base.at + SHARE_INTERVAL_MS + 1;
    // A tenth of the threshold is noise from a stationary phone.
    const jitter = { latitude: base.latitude + 0.00002, longitude: base.longitude, at };
    expect(shouldShareFix(base, jitter, at)).toBe(false);
    // Just past it is real movement.
    const real = { latitude: base.latitude + 0.0003, longitude: base.longitude, at };
    expect(shouldShareFix(base, real, at)).toBe(true);
    expect(SHARE_MIN_METRES).toBeGreaterThan(10);
  });

  it('refuses a reading that is not a number', () => {
    for (const value of [null, undefined, 'x', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readCoordinate(value)).toBeNull();
    }
    expect(readCoordinate(14.6)).toBe(14.6);
  });
});

describe('what the customer is told', () => {
  it('gives distance, never an arrival time', () => {
    // Minutes from a straight line across a city with one bridge is the
    // number that makes somebody stand at a gate.
    expect(describeDistance(380)).toBe('380 m away');
    expect(describeDistance(1_240)).toBe('1.2 km away');
    const component = source('src/components/orders/RiderMap.tsx');
    expect(component).not.toMatch(/minutes away|min away|arriv(al|ing) in/i);
  });

  it('rounds a short distance rather than claiming metres it does not have', () => {
    // A GPS fix is good to a few metres; "387 m away" is precision theatre.
    expect(describeDistance(387)).toBe('390 m away');
    expect(describeDistance(4)).toBe('10 m away');
  });

  it('measures to the dropoff', () => {
    const rider = { latitude: 14.6, longitude: 121.0 };
    const dropoff = { latitude: 14.6045, longitude: 121.0 };
    // ~500m north.
    expect(metresToDropoff(rider, dropoff)).toBeGreaterThan(450);
    expect(metresToDropoff(rider, dropoff)).toBeLessThan(550);
  });
});

describe('the privacy boundary', () => {
  const reader = codeOnly('src/lib/orders/rider-position.ts');

  it('takes an order and a user, never a rider', () => {
    // A function that answered "where is partner X" would be one query away
    // from a screen that tracks a person rather than a delivery.
    expect(reader).toMatch(/orderId: string; userId: string/);
    expect(reader).not.toMatch(/fleetPartnerId/);
  });

  it('checks the order against the signed-in customer', () => {
    expect(reader).toMatch(/order\.customerId !== input\.userId/);
  });

  it('applies the status and freshness gates on the server', () => {
    // Not in the component: a client-side freshness check is a suggestion.
    expect(reader).toMatch(/isTrackableStatus\(order\.status\)/);
    expect(reader).toMatch(/positionIsFresh\(rider\.locationUpdatedAt/);
  });

  it('refuses everything the same way', () => {
    // A caller who could tell "not your order" from "no fix yet" could use
    // this to learn whether an order id exists.
    const returns = [...reader.matchAll(/return null;/g)];
    expect(returns.length).toBeGreaterThanOrEqual(6);
    expect(reader).not.toMatch(/throw new/);
  });

  it('drops a fix outside the country', () => {
    // Geolocation reports (0, 0) on a failed lock, and a pin in the Gulf of
    // Guinea would put the map over the ocean.
    expect(reader).toMatch(/isInPhilippines/);
  });

  it('never lets the page read the position columns itself', () => {
    // The page includes the rider for their NAME; the columns would bypass
    // the freshness rule entirely.
    const page = codeOnly('src/app/orders/[orderId]/page.tsx');
    expect(page).not.toMatch(/currentLatitude|currentLongitude|locationUpdatedAt/);
    expect(page).toMatch(/isTrackableStatus\(order\.status\)/);
  });
});

describe('the transport', () => {
  it('polls faster than the page refresh, and says why', () => {
    // A whole-page refresh re-renders the timeline, the receipt and the
    // rating form to move a pin.
    expect(TRACKING_POLL_MS).toBeLessThan(15_000);
    const action = source('src/lib/actions/tracking-actions.ts');
    expect(action).toMatch(/three fields/);
  });

  it('ages the fix against the server’s clock', () => {
    // A handset ten minutes out would otherwise be told a current fix is
    // stale, or — worse — a stale one is current.
    const action = codeOnly('src/lib/actions/tracking-actions.ts');
    expect(action).toMatch(/serverNowMs/);
    const component = codeOnly('src/components/orders/RiderMap.tsx');
    expect(component).toMatch(/result\.serverNowMs - result\.updatedAtMs/);
  });

  it('stops when the tab is hidden', () => {
    const component = codeOnly('src/components/orders/RiderMap.tsx');
    expect(component).toMatch(/visibilityState !== 'visible'/);
  });
});

describe('the rider’s side, which did not exist', () => {
  it('is the first caller of updateLocationAction', () => {
    // The action has been in the codebase since dispatch was built and
    // nothing ever called it: a position was written once, when a partner
    // went online, and then aged.
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/updateLocationAction\(/);
  });

  it('watches rather than polling the radio', () => {
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/watchPosition\(/);
    expect(share).toMatch(/clearWatch\(/);
  });

  it('throttles the writes through the shared rule', () => {
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/shouldShareFix\(/);
  });

  it('keeps the newest reading and reconsiders it on a clock', () => {
    // A refused fix must be held, not dropped: see the held-fix case above.
    // The flush has to be quicker than the write interval or holding it just
    // moves the delay somewhere else.
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/latest\.current = \{/);
    expect(share).toMatch(/setInterval\(share, SHARE_FLUSH_MS\)/);
    expect(share).toMatch(/clearInterval\(flush\)/);
    expect(SHARE_FLUSH_MS).toBeLessThan(SHARE_INTERVAL_MS);
  });

  it('does not overlap writes, and only trusts one that succeeded', () => {
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/if \(next === null \|\| inFlight\.current\) return;/);
    // `lastSent` is what the database is believed to hold, so a failed write
    // must not advance it — otherwise one dropped request loses the position.
    expect(share).toMatch(/if \(!result\.ok\) return;\s*lastSent\.current = sending;/);
  });

  it('runs only while the rider is online', () => {
    const share = codeOnly('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/if \(!isOnline\)/);
    expect(source('src/app/fleet/layout.tsx')).toMatch(/isOnline=\{partner\.isOnline\}/);
  });

  it('tells the rider it is running', () => {
    // A background location share nobody mentions is the kind of thing that
    // ends up in a news story.
    const share = source('src/components/fleet/LocationShare.tsx');
    expect(share).toMatch(/Sharing your location/);
    expect(share).toMatch(/blocked for this site/);
  });
});

describe('the map’s own honesty', () => {
  const component = codeOnly('src/components/orders/RiderMap.tsx');

  it('loads Leaflet’s own stylesheet, in every component that draws a map', () => {
    // Skipping this does not fail loudly. The tiles arrive, Leaflet marks
    // them loaded, and they stack down the page in document flow because
    // `.leaflet-tile { position: absolute }` lives in that stylesheet — so a
    // test counting tiles passes while the map is unreadable. Asserted across
    // every map component rather than just this one: the omission is easy to
    // repeat and invisible until somebody looks at a screen.
    for (const file of [
      'src/components/orders/RiderMap.tsx',
      'src/components/admin/LocationPicker.tsx',
    ]) {
      expect(codeOnly(file), file).toMatch(/import 'leaflet\/dist\/leaflet\.css'/);
    }
  });

  it('counts tiles rather than trusting Leaflet’s load event', () => {
    // `load` fires when the batch settles whether the tiles arrived or
    // failed, so a naive listener calls a grey box ready.
    expect(component).toMatch(/tileerror/);
    expect(component).toMatch(/loaded === 0 && failed > 0/);
  });

  it('treats a hang as a failure too', () => {
    expect(component).toMatch(/setTimeout\(/);
  });

  it('frames both pins once, then leaves the view alone', () => {
    // A map that recentres every ten seconds cannot be read, and cannot be
    // panned by somebody looking ahead.
    expect(component).toMatch(/fitBounds\(/);
    expect(component).toMatch(/if \(!fitted\)/);
  });

  it('renders the attribution the tiles require', () => {
    expect(component).toMatch(/attribution: tileSource\.attribution/);
  });

  it('is loaded only on a live delivery, and the console says why', () => {
    const health = source('src/app/admin/health/page.tsx');
    expect(health).toMatch(/Map tiles/);
    expect(health).toMatch(/MAP_TILE_URL/);
    expect(health).toMatch(/proportional to live deliveries/);
  });
});
