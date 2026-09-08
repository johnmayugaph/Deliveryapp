import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NotificationChannel,
  NotificationKind,
  NotificationUrgency,
} from '@prisma/client';
import {
  ALERT_COOLDOWN_SECONDS,
  SUSTAINED_ALERT_COOLDOWN_SECONDS,
  SUSTAINED_MINUTES,
  alertWorthSending,
  sustainedRun,
} from '@/lib/pricing/surge-alert-policy';
import {
  KIND_POLICY,
  PERISHABLE_MAX_AGE_SECONDS,
  deliverableAt,
  perishedBy,
} from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Surge notifications.
 *
 * One idea carries this file: **the market is measured every minute, and
 * almost none of those minutes are news.** A feature that notified on every
 * measurement would send sixty pushes an hour to every rider in a city, and
 * the result is not an informed fleet — it is an app whose notifications
 * everybody has muted, including the ones saying an order is waiting.
 *
 * The second idea is that this message expires. Every other kind in the system
 * describes something that happened and reads the same at 6am; "it is busy
 * right now, come out" becomes false rather than late, and a rider who gets up
 * for a surge that ended at midnight has been lied to by the app.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

function codeOnly(relativePath: string): string {
  return stripComments(source(relativePath));
}

describe('only a step UP is news', () => {
  it('alerts when surge appears', () => {
    expect(alertWorthSending({ surgeCentavos: 2_000, previousCentavos: 0 })).toBe(true);
  });

  it('alerts when the step climbs', () => {
    expect(alertWorthSending({ surgeCentavos: 4_000, previousCentavos: 2_000 })).toBe(
      true,
    );
  });

  it('says nothing while the surge is unchanged', () => {
    // THE failure this whole module exists to prevent. A market busy for
    // twenty minutes has been measured twenty times, and everyone eligible was
    // told on the first one.
    expect(alertWorthSending({ surgeCentavos: 2_000, previousCentavos: 2_000 })).toBe(
      false,
    );
  });

  it('says nothing when the step falls', () => {
    // A rider invited out by "₱40 extra" who arrives to ₱20 was misled by a
    // message that was true when sent, which is worse than silence.
    expect(alertWorthSending({ surgeCentavos: 2_000, previousCentavos: 4_000 })).toBe(
      false,
    );
  });

  it('says nothing when the surge ends', () => {
    expect(alertWorthSending({ surgeCentavos: 0, previousCentavos: 4_000 })).toBe(false);
  });

  it('says nothing about a calm market that was always calm', () => {
    expect(alertWorthSending({ surgeCentavos: 0, previousCentavos: 0 })).toBe(false);
  });

  it('sends at most once across a whole busy hour of measurements', () => {
    // The realistic sequence: surge starts, holds for twenty minutes, steps up
    // once, holds, fades. Two pieces of news in an hour, not sixty.
    const readings = [
      0, 0, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000,
      2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 4_000, 4_000, 4_000,
      4_000, 4_000, 4_000, 4_000, 2_000, 2_000, 0, 0,
    ];
    let sent = 0;
    for (let index = 1; index < readings.length; index += 1) {
      if (
        alertWorthSending({
          surgeCentavos: readings[index]!,
          previousCentavos: readings[index - 1]!,
        })
      ) {
        sent += 1;
      }
    }
    expect(sent).toBe(2);
  });
});

describe('the cooldown', () => {
  it('is long enough to decide, get ready and reach a pickup', () => {
    expect(ALERT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(30 * 60);
    // And short enough that a genuinely new rush later in the evening lands.
    expect(ALERT_COOLDOWN_SECONDS).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it('is checked against the notification record, not a column on the rider', () => {
    // A "lastAlertedAt" column would be a second truth that can disagree with
    // what the inbox says somebody was told.
    const alerts = codeOnly('src/lib/pricing/surge-alerts.ts');
    expect(alerts).toMatch(/db\.notification\.findMany/);
    expect(alerts).toMatch(/kind: NotificationKind\.SURGE_ACTIVE/);
    expect(alerts).toMatch(/createdAt: \{ gte: since \}/);
    expect(codeOnly('prisma/schema.prisma')).not.toMatch(/lastSurgeAlertAt/);
  });

  it('scopes the cooldown to the market, so two services can both speak', () => {
    const alerts = codeOnly('src/lib/pricing/surge-alerts.ts');
    expect(alerts).toMatch(/dedupeKey: \{ startsWith: alertKeyPrefix\(/);
  });

  it('gives administrators a whole shift between sustained reports', () => {
    expect(SUSTAINED_ALERT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(60 * 60);
  });
});

describe('a market that stopped being a spike', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  it('measures the run from the clock, not by counting rows', () => {
    // Counting rows assumes the sweep never missed a beat: forty snapshots is
    // forty minutes only if the cron ran every minute, and a cron that stalled
    // would otherwise make a short rush look like a long one.
    const sparse = [
      { surgeCentavos: 6_000, createdAt: at(0) },
      { surgeCentavos: 6_000, createdAt: at(50) },
    ];
    const run = sustainedRun(sparse, 6_000);
    expect(run.readings).toBe(2);
    expect(run.minutes).toBe(50);
  });

  it('ends the run at the first dip below the ceiling', () => {
    // A market that fell to a lower step and climbed again has had riders
    // reach it, which is the ladder working rather than a staffing problem.
    const run = sustainedRun(
      [
        { surgeCentavos: 6_000, createdAt: at(0) },
        { surgeCentavos: 6_000, createdAt: at(10) },
        { surgeCentavos: 4_000, createdAt: at(20) },
        { surgeCentavos: 6_000, createdAt: at(30) },
        { surgeCentavos: 6_000, createdAt: at(90) },
      ],
      6_000,
    );
    expect(run.readings).toBe(2);
    expect(run.minutes).toBe(10);
    expect(run.minutes).toBeLessThan(SUSTAINED_MINUTES);
  });

  it('reports nothing for a rush that clears itself', () => {
    const run = sustainedRun(
      [
        { surgeCentavos: 6_000, createdAt: at(0) },
        { surgeCentavos: 6_000, createdAt: at(12) },
      ],
      6_000,
    );
    expect(run.minutes).toBeLessThan(SUSTAINED_MINUTES);
  });

  it('reports a market pinned at the ceiling for the threshold', () => {
    const run = sustainedRun(
      [
        { surgeCentavos: 6_000, createdAt: at(0) },
        { surgeCentavos: 6_000, createdAt: at(SUSTAINED_MINUTES) },
      ],
      6_000,
    );
    expect(run.minutes).toBeGreaterThanOrEqual(SUSTAINED_MINUTES);
  });

  it('does not count readings taken under a ladder that no longer exists', () => {
    // Found against the real database. The top step was switched off, so the
    // ceiling dropped from ₱50 to ₱20 — and with an at-or-above comparison
    // every historical ₱50 reading counted as being at the new ceiling. The
    // run stretched back through a different ladder and the alert announced
    // 765 minutes of short staffing that never happened.
    const run = sustainedRun(
      [
        { surgeCentavos: 2_000, createdAt: at(0) },
        { surgeCentavos: 5_000, createdAt: at(700) },
        { surgeCentavos: 5_000, createdAt: at(765) },
      ],
      2_000,
    );
    expect(run.readings).toBe(1);
    expect(run.minutes).toBe(0);
  });

  it('reports nothing when no ladder exists to be at the top of', () => {
    expect(sustainedRun([{ surgeCentavos: 0, createdAt: at(0) }], 0)).toEqual({
      minutes: 0,
      readings: 0,
    });
  });

  it('only considers a market at the TOP of its ladder', () => {
    // A city sitting at the ₱20 step for an hour is surge doing its job.
    const alerts = codeOnly('src/lib/pricing/surge-alerts.ts');
    expect(alerts).toMatch(/_max: \{ surgeCentavos: true \}/);
    expect(alerts).toMatch(/market\.surgeCentavos < ceiling/);
  });
});

describe('a perishable message is dropped, not held', () => {
  const twoAmManila = new Date('2026-09-06T18:00:00.000Z');
  const noonManila = new Date('2026-09-06T04:00:00.000Z');

  it('is the only kind marked perishable', () => {
    const perishable = Object.entries(KIND_POLICY)
      .filter(([, policy]) => policy.perishable)
      .map(([kind]) => kind);
    expect(perishable).toEqual([NotificationKind.SURGE_ACTIVE]);
  });

  it('drops a busy alert caught in quiet hours', () => {
    // Deferring it to 6am does not make it late, it makes it false.
    expect(
      deliverableAt({
        urgency: NotificationUrgency.INFORMATIONAL,
        channel: NotificationChannel.PUSH,
        now: twoAmManila,
        perishable: true,
      }),
    ).toBeNull();
  });

  it('still delivers it in the middle of the day', () => {
    expect(
      deliverableAt({
        urgency: NotificationUrgency.INFORMATIONAL,
        channel: NotificationChannel.PUSH,
        now: noonManila,
        perishable: true,
      }),
    ).toEqual(noonManila);
  });

  it('never drops the inbox copy, so a rider up at 2am can still read it', () => {
    // What quiet hours remove is the interruption, not the information.
    expect(
      deliverableAt({
        urgency: NotificationUrgency.INFORMATIONAL,
        channel: NotificationChannel.IN_APP,
        now: twoAmManila,
        perishable: true,
      }),
    ).toEqual(twoAmManila);
  });

  it('still defers an ordinary informational push rather than dropping it', () => {
    const when = deliverableAt({
      urgency: NotificationUrgency.INFORMATIONAL,
      channel: NotificationChannel.PUSH,
      now: twoAmManila,
    });
    expect(when).not.toBeNull();
    expect(when!.getTime()).toBeGreaterThan(twoAmManila.getTime());
  });

  it('goes stale in the queue on the same window the snapshot does', () => {
    expect(PERISHABLE_MAX_AGE_SECONDS).toBe(5 * 60);
    const now = new Date('2026-09-06T04:00:00.000Z');
    expect(perishedBy(new Date(now.getTime() - 60_000), now)).toBe(false);
    expect(perishedBy(new Date(now.getTime() - 20 * 60_000), now)).toBe(true);
  });

  it('is written as EXPIRED rather than SKIPPED', () => {
    // "They muted this" and "we decided it had gone stale" are different
    // facts, and only one of them means somebody chose not to hear it.
    const enqueue = codeOnly('src/lib/notifications/enqueue.ts');
    expect(enqueue).toMatch(/'EXPIRED' as const/);
    const deliver = codeOnly('src/lib/notifications/deliver.ts');
    expect(deliver).toMatch(/NotificationDeliveryStatus\.EXPIRED/);
    expect(deliver).toMatch(/perishedBy\(delivery\.notification\.createdAt, now\)/);
  });
});

describe('who is told', () => {
  it('invites riders who are offline, not the ones already working', () => {
    // An online rider is already in the dispatch loop and their offers carry
    // the surge in the earnings figure; a second message says nothing new.
    const alerts = codeOnly('src/lib/pricing/surge-alerts.ts');
    expect(alerts).toMatch(/isOnline: false/);
    expect(alerts).toMatch(/isSuspended: false/);
    expect(alerts).toMatch(/wantsBusyAlerts: true/);
    expect(alerts).toMatch(/enabledServices: \{ has: serviceType \}/);
    expect(alerts).toMatch(/homeCityId: cityId/);
  });

  it('lets a rider decline the invitation without muting order updates', () => {
    // NotificationPreference is keyed by CHANNEL, so declining through it
    // would also switch off "an order is waiting for you".
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/wantsBusyAlerts Boolean @default\(true\)/);
    const actions = codeOnly('src/lib/actions/fleet-actions.ts');
    expect(actions).toMatch(/setBusyAlertsAction/);
    expect(actions).toMatch(/data: \{ wantsBusyAlerts \}/);
  });

  it('tells the rider what the switch does NOT change', () => {
    // "Stop telling me about surge" reads as "stop paying me surge" to
    // somebody scanning it, and a rider who believes that never touches it.
    const toggle = source('src/components/fleet/BusyAlertsToggle.tsx');
    expect(toggle).toMatch(/does not change what you are paid/);
  });
});

describe('what the message says', () => {
  it('carries the amount, because "it is busy" is not a decision', () => {
    const rendered = renderNotification(NotificationKind.SURGE_ACTIVE, {
      cityName: 'Manila',
      surgeLabel: 'Sobrang busy',
      surgeCentavos: 2_500,
      surgeOrdersWaiting: 4,
      surgeRidersAvailable: 1,
    });
    expect(rendered.title).toContain('₱25.00');
    expect(rendered.title).toContain('Manila');
    expect(rendered.body).toContain('Sobrang busy');
    expect(rendered.body).toContain('4 orders');
  });

  it('counts one waiting order in the singular', () => {
    const rendered = renderNotification(NotificationKind.SURGE_ACTIVE, {
      cityName: 'Manila',
      surgeCentavos: 2_000,
      surgeOrdersWaiting: 1,
    });
    expect(rendered.body).toContain('1 order waiting');
    expect(rendered.body).not.toContain('1 orders');
  });

  it('never costs a peso a rider', () => {
    // It goes to a whole city's worth of riders at once, so the volume is
    // exactly the number that spikes on the worst night.
    expect(KIND_POLICY[NotificationKind.SURGE_ACTIVE].channels).not.toContain(
      NotificationChannel.SMS,
    );
    expect(KIND_POLICY[NotificationKind.SURGE_SUSTAINED].channels).not.toContain(
      NotificationChannel.SMS,
    );
  });

  it('is informational, so quiet hours apply to it at all', () => {
    // Marking it OPERATIONAL would push it through 2am, which is the app
    // deciding to work the night shift on somebody else's behalf.
    expect(KIND_POLICY[NotificationKind.SURGE_ACTIVE].urgency).toBe(
      NotificationUrgency.INFORMATIONAL,
    );
  });

  it('tells administrators the answer is riders, not a higher step', () => {
    const rendered = renderNotification(NotificationKind.SURGE_SUSTAINED, {
      cityName: 'Manila',
      surgeCentavos: 6_000,
      surgeMinutes: 55,
      surgeOrdersWaiting: 9,
      surgeRidersAvailable: 0,
    });
    expect(rendered.body).toMatch(/short staffing rather than a spike/);
    expect(rendered.body).toMatch(/higher step will not fix it/);
  });

  it('is not marked perishable, unlike the rider alert', () => {
    // "This city was short of riders for an hour last night" reads the same
    // over breakfast, and is arguably more useful then.
    expect(KIND_POLICY[NotificationKind.SURGE_SUSTAINED].perishable).toBeUndefined();
  });
});

describe('the alert and the price come from one reading', () => {
  it('alerts at the instant the sweep stamped, not a fresh one', () => {
    // Found in a browser, after the units and the live-database checks both
    // passed. The sweep called the two passes with two separate `new Date()`
    // calls; `previousReadings` asks for the newest row with `createdAt < now`,
    // so the alert pass's slightly later instant included the row just
    // written. The previous reading WAS the current reading, no market ever
    // looked changed, and not one rider was ever told anything.
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    expect(sweep).toMatch(/sendSurgeAlerts\(surge\.written, surge\.at\)/);
    expect(sweep).not.toMatch(/sendSurgeAlerts\([^)]*new Date\(\)/);
    const surge = codeOnly('src/lib/pricing/surge.ts');
    expect(surge).toMatch(/at: now,/);
    // And the comparison is strict, so sharing the instant excludes this
    // pass's own rows rather than including them.
    expect(codeOnly('src/lib/pricing/surge-alerts.ts')).toMatch(
      /createdAt: \{ lt: now \}/,
    );
  });

  it('alerts from the rows the sweep just wrote', () => {
    // Re-measuring for the alert would let the two disagree, and then a rider
    // is invited out by a number no customer was ever quoted.
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    expect(sweep).toMatch(/sendSurgeAlerts\(surge\.written,/);
    // Never a fresh measurement for the alert's benefit.
    expect(sweep).not.toMatch(/sendSurgeAlerts\(await measureMarket/);
    const surge = codeOnly('src/lib/pricing/surge.ts');
    expect(surge).toMatch(/written: rows\.map/);
  });

  it('runs before the delivery pass, so an alert goes out the same minute', () => {
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    const alerts = sweep.indexOf('await sendSurgeAlerts(');
    const deliver = sweep.indexOf('await deliverPending()');
    expect(alerts).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(alerts);
  });

  it('shows the rider the same snapshot a quote reads', () => {
    // A notification saying "₱20 extra" points at the offers board. If the
    // board recomputed from the live queue the two could disagree.
    const surge = codeOnly('src/lib/pricing/surge.ts');
    const busy = surge.slice(surge.indexOf('export async function busyMarketsForPartner'));
    expect(busy).toMatch(/await currentSurge\(/);
    expect(busy).not.toMatch(/ordersWaitingByCity|surgeForMarket/);
    expect(codeOnly('src/app/fleet/page.tsx')).toMatch(/busyMarketsForPartner\(partner\)/);
  });

  it('never lets an alert failure cost the measurement', () => {
    // The pricing is already written and correct by the time this runs.
    const alerts = codeOnly('src/lib/pricing/surge-alerts.ts');
    expect((alerts.match(/\} catch \{/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the alert nobody can write', () => {
  it('does not pretend to detect its own sweep stopping', () => {
    // The thing that would detect it is the thing that stopped. An alert
    // written from inside the sweep to say the sweep is not running is a check
    // that can never fire, and this codebase has produced enough of those.
    // Whitespace-normalised: the reasoning is wrapped across comment lines,
    // and a regex that depends on where the wrap falls breaks on a reformat.
    const alerts = source('src/lib/pricing/surge-alerts.ts')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\s+/g, ' ');
    expect(alerts).toContain(
      'the thing that would detect it is the thing that stopped',
    );
    expect(alerts).toContain('a check that can never fire');
    const kinds = source('prisma/schema.prisma');
    expect(kinds).not.toMatch(/SURGE_SWEEP_STOPPED|SURGE_STALLED/);
    // Covered where it can be: a banner on the screen, honest about being
    // visible only to somebody who opens it.
    expect(codeOnly('src/app/admin/surge/page.tsx')).toMatch(/cronLooksStopped/);
  });
});
