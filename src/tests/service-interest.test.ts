import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NotificationChannel, NotificationKind, ServiceKey } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { foldDemand, type DemandRow } from '@/lib/services/interest';
import { describeAskCount } from '@/lib/services/presentation';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Demand for the verticals that do not exist yet.
 *
 * The load-bearing decision in this feature is that two different things are
 * counted separately: an ACCOUNT that asked, which required a code sent to a
 * real phone, and a TAP from somebody not signed in, which anybody who can
 * post a form can produce. Adding them together would give the console a
 * number one person with a script can move, and a launch decision made on it.
 * Most of what follows is about keeping them apart.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function row(fields: Partial<DemandRow> & { userId: string | null }): DemandRow {
  return {
    serviceKey: fields.serviceKey ?? ServiceKey.MART,
    cityId: fields.cityId ?? 'city_manila',
    askCount: fields.askCount ?? 1,
    userId: fields.userId,
  };
}

describe('counting who asked', () => {
  it('counts one account once, however many times they asked', () => {
    // askCount is a tally of repeats, not of people. A person who taps every
    // week is still one person deciding whether Mart is worth building.
    const demand = foldDemand([row({ userId: 'u1', askCount: 9 })]);
    expect(demand.get(ServiceKey.MART)?.accounts).toBe(1);
    expect(demand.get(ServiceKey.MART)?.anonymous).toBe(0);
  });

  it('counts anonymous taps as taps, because there is nobody to count', () => {
    const demand = foldDemand([row({ userId: null, askCount: 12 })]);
    expect(demand.get(ServiceKey.MART)?.accounts).toBe(0);
    expect(demand.get(ServiceKey.MART)?.anonymous).toBe(12);
  });

  it('never adds the two together', () => {
    const demand = foldDemand([
      row({ userId: 'u1' }),
      row({ userId: 'u2' }),
      row({ userId: null, askCount: 500 }),
    ]);
    const mart = demand.get(ServiceKey.MART)!;
    expect(mart.accounts).toBe(2);
    expect(mart.anonymous).toBe(500);
    // If these were ever summed, 502 people would appear to want Mart in
    // Manila on the strength of one afternoon with a loop.
    expect(mart.accounts + mart.anonymous).toBe(502);
    expect(mart).not.toHaveProperty('total');
  });

  it('keeps cities apart, because a launch is one city at a time', () => {
    const demand = foldDemand([
      row({ userId: 'u1', cityId: 'city_manila' }),
      row({ userId: 'u2', cityId: 'city_cebu' }),
      row({ userId: 'u3', cityId: 'city_cebu' }),
    ]);
    const mart = demand.get(ServiceKey.MART)!;
    expect(mart.accounts).toBe(3);
    expect(mart.byCity.map((city) => [city.cityId, city.accounts])).toEqual([
      ['city_cebu', 2],
      ['city_manila', 1],
    ]);
  });

  it('puts the busiest city first', () => {
    const demand = foldDemand([
      row({ userId: 'u1', cityId: 'city_a' }),
      row({ userId: 'u2', cityId: 'city_b' }),
      row({ userId: 'u3', cityId: 'city_b' }),
      row({ userId: 'u4', cityId: 'city_c' }),
      row({ userId: 'u5', cityId: 'city_c' }),
      row({ userId: 'u6', cityId: 'city_c' }),
    ]);
    expect(demand.get(ServiceKey.MART)!.byCity.map((city) => city.cityId)).toEqual([
      'city_c',
      'city_b',
      'city_a',
    ]);
  });

  it('ranks by accounts before taps, not the other way round', () => {
    const demand = foldDemand([
      row({ userId: 'u1', cityId: 'city_real' }),
      row({ userId: null, cityId: 'city_noisy', askCount: 9000 }),
    ]);
    expect(demand.get(ServiceKey.MART)!.byCity[0]?.cityId).toBe('city_real');
  });

  it('keeps services apart', () => {
    const demand = foldDemand([
      row({ serviceKey: ServiceKey.MART, userId: 'u1' }),
      row({ serviceKey: ServiceKey.RIDE, userId: 'u1' }),
      row({ serviceKey: ServiceKey.RIDE, userId: 'u2' }),
    ]);
    expect(demand.get(ServiceKey.MART)?.accounts).toBe(1);
    expect(demand.get(ServiceKey.RIDE)?.accounts).toBe(2);
    // One person can want two things.
    expect(demand.size).toBe(2);
  });

  it('reports nothing for a service nobody asked for', () => {
    expect(foldDemand([]).size).toBe(0);
    expect(foldDemand([row({ userId: 'u1' })]).get(ServiceKey.RIDE)).toBeUndefined();
  });

  it('survives a zero tally', () => {
    // `_sum.askCount` is null when a group is empty, which the query maps to 0.
    const demand = foldDemand([row({ userId: null, askCount: 0 })]);
    expect(demand.get(ServiceKey.MART)?.anonymous).toBe(0);
  });
});

describe('what the tile says back', () => {
  it('tells the first person they are the first', () => {
    expect(describeAskCount(1)).toBe('Noted — you are the first');
  });

  it('counts the others, not the total', () => {
    // "you and 33 others" reads as a crowd; "34 people" reads as a statistic
    // and makes the reader wonder whether they are included.
    expect(describeAskCount(2)).toBe('Noted — you and 1 other');
    expect(describeAskCount(34)).toBe('Noted — you and 33 others');
  });

  it('never says nothing, even with no count to show', () => {
    expect(describeAskCount(undefined)).toBe('Noted — you are the first');
    expect(describeAskCount(0)).toBe('Noted — you are the first');
  });
});

describe('telling people when it launches', () => {
  it('does not cost a peso a head', () => {
    // The recipient asked us to note that they wanted Mart. They did not ask
    // to be texted, and a launch announcement to a waiting list is the shape
    // of message that teaches people to ignore texts from us.
    const policy = KIND_POLICY[NotificationKind.SERVICE_NOW_AVAILABLE];
    expect(policy.channels).not.toContain(NotificationChannel.SMS);
    expect(policy.channels).toContain(NotificationChannel.PUSH);
    expect(policy.channels).toContain(NotificationChannel.IN_APP);
  });

  it('is not unmutable — nobody needs this at 2am', () => {
    expect(KIND_POLICY[NotificationKind.SERVICE_NOW_AVAILABLE].unmutable).toBeUndefined();
  });

  it('reminds the person that they asked', () => {
    // The tap could have been months ago, and an unexplained "Mart is open!"
    // is indistinguishable from marketing.
    const rendered = renderNotification(NotificationKind.SERVICE_NOW_AVAILABLE, {
      serviceName: 'Mart',
      cityName: 'Iloilo City',
    });
    expect(rendered.title).toContain('Mart');
    expect(rendered.title).toContain('Iloilo City');
    expect(rendered.body).toMatch(/you asked/i);
  });

  it('reads sensibly with no city name to hand', () => {
    const rendered = renderNotification(NotificationKind.SERVICE_NOW_AVAILABLE, {
      serviceName: 'Mart',
    });
    expect(rendered.title).toBe('Mart is open');
    expect(rendered.body).not.toMatch(/undefined|null/);
  });

  it('names the vertical from the registry, never from the template', () => {
    // No template in the system knows that food exists; the service's own
    // display name arrives in the context.
    const templates = source('src/lib/notifications/templates.ts');
    expect(templates).not.toMatch(/\bMart\b/);
  });
});

describe('the shape of the feature', () => {
  it('records interest without requiring an account', async () => {
    // The tiles are the first thing a stranger sees. A waiting list that only
    // counts people who already signed up measures the wrong population.
    const action = source('src/lib/actions/interest-actions.ts');
    expect(action).not.toMatch(/requireCurrentUser|requireOnboardedUser/);
    expect(action).toMatch(/getCurrentUser/);
  });

  it('validates the service against the registry rather than a list', () => {
    const code = source('src/lib/services/interest.ts');
    expect(code).toMatch(/getService\(/);
    expect(code).toMatch(/isOrderableIn\(/);
  });

  it('refuses to record interest in something already on sale', () => {
    // Otherwise a launched vertical keeps accruing "unmet demand" forever.
    expect(source('src/lib/services/interest.ts')).toMatch(/ServiceAlreadyLiveError/);
  });

  it('only ever tries to notify a row that has somebody to notify', () => {
    const code = source('src/lib/services/interest.ts');
    expect(code).toMatch(/userId: \{ not: null \}/);
  });

  it('dedupes the launch message on the interest row itself', () => {
    // Not on the service: withdrawing a city and re-adding it must not tell
    // the same person twice about the same request.
    expect(source('src/lib/orders/maintenance.ts')).toMatch(
      /dedupeKey: `service-live:\$\{row\.interestId\}`/,
    );
  });

  it('bounds the launch sweep, because it shares a cron with dispatch', () => {
    const code = source('src/lib/services/interest.ts');
    expect(code).toMatch(/limit = \d+/);
    expect(code).toMatch(/take: limit/);
  });
});
