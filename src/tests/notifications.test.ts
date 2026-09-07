import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  NotificationChannel,
  NotificationKind,
  NotificationUrgency,
  OrderStatus,
} from '@prisma/client';
import {
  ALWAYS_ON_CHANNELS,
  CHANNEL_DEFAULTS,
  KIND_POLICY,
  MAX_DELIVERY_ATTEMPTS,
  channelCarries,
  deliverableAt,
  isQuietHour,
  philippineHour,
  quietHoursEnd,
  retryDelayMs,
} from '@/lib/notifications/policy';
import {
  ORDER_STATUS_NOTIFICATIONS,
  notificationForStatus,
} from '@/lib/notifications/order-events';
import { NOTIFICATION_TEMPLATES, renderNotification } from '@/lib/notifications/templates';

describe('the kind policy', () => {
  it('covers every kind', () => {
    for (const kind of Object.values(NotificationKind)) {
      expect(KIND_POLICY[kind], kind).toBeDefined();
      expect(KIND_POLICY[kind].channels.length).toBeGreaterThan(0);
    }
  });

  it('always includes the inbox, because it is the record', () => {
    for (const kind of Object.values(NotificationKind)) {
      expect(KIND_POLICY[kind].channels, kind).toContain(NotificationChannel.IN_APP);
    }
  });

  it('reserves SMS for the moments somebody is waiting on an action', () => {
    // The two that justify the cost: a store that misses an order loses money,
    // and an offer expires in a minute.
    for (const kind of [
      NotificationKind.ORDER_SUBMITTED,
      NotificationKind.DISPATCH_OFFER,
    ]) {
      expect(KIND_POLICY[kind].urgency).toBe(NotificationUrgency.OPERATIONAL);
      expect(KIND_POLICY[kind].channels).toContain(NotificationChannel.SMS);
    }

    // And the ones that do not: progress a customer can see on the screen.
    // Asserted as "no SMS" rather than as an exact list, because the exact
    // list is not the invariant — adding a channel that costs nothing should
    // not have to touch this test, and adding one that costs money should.
    for (const kind of [
      NotificationKind.ORDER_ACCEPTED,
      NotificationKind.ORDER_READY,
      NotificationKind.ORDER_PICKED_UP,
      NotificationKind.ORDER_DELIVERED,
      NotificationKind.CREDITS_GRANTED,
      NotificationKind.SUBSCRIPTION_ENDED,
    ]) {
      expect(KIND_POLICY[kind].channels, kind).not.toContain(NotificationChannel.SMS);
    }
  });

  it('sends push for everything, because push is free', () => {
    // The whole reason both channels exist. Withholding a free channel from a
    // message worth writing down would need a reason, and there is not one.
    for (const kind of Object.values(NotificationKind)) {
      expect(KIND_POLICY[kind].channels, kind).toContain(NotificationChannel.PUSH);
    }
  });

  it('defaults push on for both urgencies and SMS on only for operational', () => {
    expect(CHANNEL_DEFAULTS[NotificationChannel.PUSH]).toEqual({
      OPERATIONAL: true,
      INFORMATIONAL: true,
    });
    expect(CHANNEL_DEFAULTS[NotificationChannel.SMS]).toEqual({
      OPERATIONAL: true,
      INFORMATIONAL: false,
    });
  });

  it('still defers an informational push into quiet hours', () => {
    // Free does not mean welcome at 2am. Push is not in ALWAYS_ON_CHANNELS
    // precisely so quiet hours apply to it.
    const oneAmManila = new Date('2026-09-06T17:00:00.000Z');
    expect(
      deliverableAt({
        urgency: NotificationUrgency.INFORMATIONAL,
        channel: NotificationChannel.PUSH,
        now: oneAmManila,
      }).getTime(),
    ).toBeGreaterThan(oneAmManila.getTime());
  });

  it('lets an operational push through quiet hours', () => {
    const oneAmManila = new Date('2026-09-06T17:00:00.000Z');
    expect(
      deliverableAt({
        urgency: NotificationUrgency.OPERATIONAL,
        channel: NotificationChannel.PUSH,
        now: oneAmManila,
      }).getTime(),
    ).toBe(oneAmManila.getTime());
  });

  it('lets somebody switch push off', () => {
    expect(ALWAYS_ON_CHANNELS).not.toContain(NotificationChannel.PUSH);
    expect(
      channelCarries({
        channel: NotificationChannel.PUSH,
        urgency: NotificationUrgency.OPERATIONAL,
        preference: false,
      }),
    ).toBe(false);
  });
});

describe('channel switches', () => {
  it('cannot turn off the inbox', () => {
    expect(ALWAYS_ON_CHANNELS).toContain(NotificationChannel.IN_APP);
    expect(
      channelCarries({
        channel: NotificationChannel.IN_APP,
        urgency: NotificationUrgency.INFORMATIONAL,
        preference: false,
      }),
    ).toBe(true);
  });

  it('defaults SMS on for operational and off for informational', () => {
    expect(CHANNEL_DEFAULTS.SMS.OPERATIONAL).toBe(true);
    expect(CHANNEL_DEFAULTS.SMS.INFORMATIONAL).toBe(false);

    expect(
      channelCarries({
        channel: NotificationChannel.SMS,
        urgency: NotificationUrgency.OPERATIONAL,
      }),
    ).toBe(true);
    expect(
      channelCarries({
        channel: NotificationChannel.SMS,
        urgency: NotificationUrgency.INFORMATIONAL,
      }),
    ).toBe(false);
  });

  it('lets a stored switch beat the default in both directions', () => {
    expect(
      channelCarries({
        channel: NotificationChannel.SMS,
        urgency: NotificationUrgency.OPERATIONAL,
        preference: false,
      }),
    ).toBe(false);
    expect(
      channelCarries({
        channel: NotificationChannel.SMS,
        urgency: NotificationUrgency.INFORMATIONAL,
        preference: true,
      }),
    ).toBe(true);
  });
});

describe('quiet hours', () => {
  // 18:00 UTC is 02:00 in Manila.
  const twoAm = new Date('2026-09-07T18:00:00.000Z');
  // 06:00 UTC is 14:00 in Manila.
  const twoPm = new Date('2026-09-07T06:00:00.000Z');

  it('reads the hour in Manila, not in UTC', () => {
    expect(philippineHour(twoAm)).toBe(2);
    expect(philippineHour(twoPm)).toBe(14);
  });

  it('covers 22:00 to 06:00 local', () => {
    expect(isQuietHour(twoAm)).toBe(true);
    expect(isQuietHour(twoPm)).toBe(false);
    // 22:00 and 05:59 local are quiet; 06:00 is not.
    expect(isQuietHour(new Date('2026-09-07T14:00:00.000Z'))).toBe(true);
    expect(isQuietHour(new Date('2026-09-07T21:59:00.000Z'))).toBe(true);
    expect(isQuietHour(new Date('2026-09-07T22:00:00.000Z'))).toBe(false);
  });

  it('defers an informational SMS to the end of quiet hours rather than dropping it', () => {
    const when = deliverableAt({
      urgency: NotificationUrgency.INFORMATIONAL,
      channel: NotificationChannel.SMS,
      now: twoAm,
    });
    expect(when.getTime()).toBeGreaterThan(twoAm.getTime());
    expect(philippineHour(when)).toBe(6);
    expect(when.toISOString()).toBe(quietHoursEnd(twoAm).toISOString());
  });

  it('sends an operational SMS at 2am anyway', () => {
    // A store that finds out at 6am about an order placed at 1am has lost it.
    expect(
      deliverableAt({
        urgency: NotificationUrgency.OPERATIONAL,
        channel: NotificationChannel.SMS,
        now: twoAm,
      }).toISOString(),
    ).toBe(twoAm.toISOString());
  });

  it('never defers the inbox', () => {
    expect(
      deliverableAt({
        urgency: NotificationUrgency.INFORMATIONAL,
        channel: NotificationChannel.IN_APP,
        now: twoAm,
      }).toISOString(),
    ).toBe(twoAm.toISOString());
  });

  it('lands the deferral on the hour, so a night of them does not fan out', () => {
    const one = quietHoursEnd(new Date('2026-09-07T17:03:00.000Z'));
    const two = quietHoursEnd(new Date('2026-09-07T19:47:00.000Z'));
    expect(one.getUTCMinutes()).toBe(0);
    expect(one.toISOString()).toBe(two.toISOString());
  });
});

describe('retries', () => {
  it('backs off, then gives up', () => {
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(25 * 60_000);
    // Beyond the table it stays at the longest delay rather than growing
    // without bound.
    expect(retryDelayMs(9)).toBe(25 * 60_000);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
  });
});

describe('which statuses notify', () => {
  it('decides for every status in the superset', () => {
    for (const status of Object.values(OrderStatus)) {
      expect(
        Object.prototype.hasOwnProperty.call(ORDER_STATUS_NOTIFICATIONS, status),
        `${status} has no entry, so nobody has decided whether it notifies`,
      ).toBe(true);
    }
  });

  it('tells the store about an order waiting for a decision', () => {
    const spec = notificationForStatus(OrderStatus.PENDING_MERCHANT_ACCEPTANCE);
    expect(spec?.audiences.MERCHANT).toBe(NotificationKind.ORDER_SUBMITTED);
    expect(spec?.audiences.CUSTOMER).toBeUndefined();
  });

  it('says different things to different people about the same timeout', () => {
    const spec = notificationForStatus(OrderStatus.CANCELLED_BY_SYSTEM);
    expect(spec?.audiences.CUSTOMER).toBe(NotificationKind.ORDER_CANCELLED);
    expect(spec?.audiences.MERCHANT).toBe(NotificationKind.ORDER_LOST_TO_TIMEOUT);
  });

  it('does not tell somebody what they just did themselves', () => {
    // The customer pressed cancel; the store is the one who needs to hear.
    const spec = notificationForStatus(OrderStatus.CANCELLED_BY_CUSTOMER);
    expect(spec?.audiences.CUSTOMER).toBeUndefined();
    expect(spec?.audiences.MERCHANT).toBe(NotificationKind.ORDER_CANCELLED);
  });

  it('stays quiet through the statuses nobody can act on', () => {
    for (const status of [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PREPARING,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      OrderStatus.IN_TRANSIT,
      OrderStatus.COMPLETED,
    ]) {
      expect(notificationForStatus(status), status).toBeNull();
    }
  });

  it('names an audience for every status that does notify', () => {
    for (const [status, spec] of Object.entries(ORDER_STATUS_NOTIFICATIONS)) {
      if (spec === null) continue;
      expect(Object.keys(spec.audiences).length, status).toBeGreaterThan(0);
    }
  });
});

describe('templates', () => {
  it('covers every kind', () => {
    for (const kind of Object.values(NotificationKind)) {
      expect(NOTIFICATION_TEMPLATES[kind], kind).toBeTypeOf('function');
    }
  });

  it('renders a title, a body and a short form for every kind', () => {
    for (const kind of Object.values(NotificationKind)) {
      const rendered = renderNotification(kind, {
        serviceName: 'Food',
        orderNumber: 'DA-20260907-ABCDE',
        storeName: 'Aling Nena Carinderia',
        amountCentavos: 49900,
        earningsCentavos: 8900,
        secondsToAnswer: 60,
        distanceLabel: '1.9 km',
        creditsCentavos: 780,
        creditsReason: 'Credits back.',
        planName: 'TARA Plus',
      });
      expect(rendered.title.length, kind).toBeGreaterThan(0);
      expect(rendered.body.length, kind).toBeGreaterThan(0);
      expect(rendered.sms.length, kind).toBeGreaterThan(0);
      // A text arrives with no screen around it, so it must not be longer than
      // a couple of segments or it costs double to send.
      expect(rendered.sms.length, `${kind} SMS is too long`).toBeLessThanOrEqual(320);
    }
  });

  it('leaves a space around punctuation in the short forms', () => {
    // "TARA— ₱89.00" is what happens when a joined string forgets one,
    // and it is the kind of thing only a real send makes obvious.
    for (const kind of Object.values(NotificationKind)) {
      const rendered = renderNotification(kind, {
        serviceName: 'Food',
        orderNumber: 'DA-1',
        earningsCentavos: 8900,
        secondsToAnswer: 60,
        creditsCentavos: 780,
      });
      expect(rendered.sms, kind).not.toMatch(/[A-Za-z0-9](—|·)/);
      expect(rendered.sms, kind).not.toMatch(/\s{2,}/);
    }
  });

  it('carries the order number into the text, where there is no screen', () => {
    const rendered = renderNotification(NotificationKind.ORDER_ARRIVED, {
      serviceName: 'Food',
      orderNumber: 'DA-20260907-ABCDE',
    });
    expect(rendered.sms).toContain('DA-20260907-ABCDE');
  });

  it('takes the vertical name from the caller rather than naming food', () => {
    const rendered = renderNotification(NotificationKind.ORDER_DELIVERED, {
      serviceName: 'Parcel',
    });
    expect(rendered.body).toContain('Parcel');
  });

  it('leaves out a refund line when there was no refund', () => {
    const withRefund = renderNotification(NotificationKind.ORDER_CANCELLED, {
      serviceName: 'Food',
      orderNumber: 'DA-1',
      amountCentavos: 49900,
    });
    const without = renderNotification(NotificationKind.ORDER_CANCELLED, {
      serviceName: 'Food',
      orderNumber: 'DA-1',
    });
    expect(withRefund.body).toContain('₱499.00');
    expect(without.body).not.toMatch(/₱/);
  });
});

/**
 * The notification layer sits underneath the order state machine, and a message
 * that throws must never roll back a delivered order. The transaction-safety
 * argument only holds if enqueueing cannot raise on the ordinary duplicate
 * case, which is what `skipDuplicates` is for.
 */
describe('enqueueing cannot break what it reports on', () => {
  const source = readFileSync(
    path.resolve(__dirname, '..', 'lib', 'notifications', 'enqueue.ts'),
    'utf8',
  );

  it('inserts with skipDuplicates rather than catching a unique violation', () => {
    expect(source).toContain('skipDuplicates: true');
    // A caught P2002 would be too late: inside a caller's transaction the
    // failed statement has already aborted it at the database level.
    expect(source).not.toContain('P2002');
  });

  it('always writes a dedupe key', () => {
    expect(source).toContain('dedupeKey: input.dedupeKey');
  });
});
