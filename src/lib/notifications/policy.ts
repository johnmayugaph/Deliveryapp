import {
  NotificationChannel,
  NotificationKind,
  NotificationUrgency,
} from '@prisma/client';

/**
 * Who gets interrupted, through what, and when.
 *
 * Every policy in this file is a value rather than a branch, for the same
 * reason the service registry is data: the questions "should this wake someone
 * at 2am" and "does this cost us a peso per recipient" are product decisions
 * that change without the code around them changing.
 */

/** Whose screen a message belongs on. Not a role — one person can be several. */
export type NotificationAudience = 'CUSTOMER' | 'MERCHANT' | 'FLEET_PARTNER';

export interface KindPolicy {
  urgency: NotificationUrgency;
  /**
   * Channels this kind may use, before the recipient's own switches. IN_APP is
   * on every kind: the inbox is the record.
   */
  channels: readonly NotificationChannel[];
}

/**
 * Keyed by EVERY kind, so adding one is a compile error until somebody decides
 * whether it is worth an SMS.
 */
export const KIND_POLICY: Readonly<Record<NotificationKind, KindPolicy>> = {
  // Somebody is waiting on an action, and the tab is probably closed. These are
  // the two that justify the cost of a message.
  [NotificationKind.ORDER_SUBMITTED]: {
    urgency: NotificationUrgency.OPERATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },
  [NotificationKind.DISPATCH_OFFER]: {
    urgency: NotificationUrgency.OPERATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },
  // Losing an order to a timeout is worth telling a store about even though the
  // moment to act has passed: it is the only way they learn it happened.
  [NotificationKind.ORDER_LOST_TO_TIMEOUT]: {
    urgency: NotificationUrgency.OPERATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },

  // A customer waiting on food is watching the screen; and where they are not,
  // the two moments that matter are "a rider has it" and "it is here".
  [NotificationKind.ORDER_RIDER_ASSIGNED]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },
  [NotificationKind.ORDER_ARRIVED]: {
    urgency: NotificationUrgency.OPERATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },
  // A cancellation is money and dinner both changing, so it goes out properly.
  [NotificationKind.ORDER_CANCELLED]: {
    urgency: NotificationUrgency.OPERATIONAL,
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
    ],
  },

  // Progress worth recording, not worth paying for.
  [NotificationKind.ORDER_ACCEPTED]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
  [NotificationKind.ORDER_READY]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
  [NotificationKind.ORDER_PICKED_UP]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
  [NotificationKind.ORDER_DELIVERED]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
  [NotificationKind.CREDITS_GRANTED]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
  [NotificationKind.SUBSCRIPTION_ENDED]: {
    urgency: NotificationUrgency.INFORMATIONAL,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  },
};

/**
 * What a channel does for someone who has never touched the setting.
 *
 * SMS defaults ON for operational messages and OFF for everything else. That
 * split is the whole reason `urgency` exists: a store that misses an order
 * loses money, while a customer does not need to pay attention to "the store is
 * cooking" — and every INFORMATIONAL text we send is a peso spent to be
 * slightly annoying.
 *
 * Push has no such trade-off, so it carries everything. The pair together is
 * the point: push does the volume for free, and SMS is kept for the messages
 * that must arrive even on a phone with no browser permission granted.
 */
export const CHANNEL_DEFAULTS: Readonly<
  Record<NotificationChannel, Readonly<Record<NotificationUrgency, boolean>>>
> = {
  // Not a preference: the inbox is the record of what somebody was told.
  [NotificationChannel.IN_APP]: {
    [NotificationUrgency.OPERATIONAL]: true,
    [NotificationUrgency.INFORMATIONAL]: true,
  },
  // Push costs nothing per message and reaches a closed tab, so both urgencies
  // default on. The restraint that SMS needs — is this worth a peso — does not
  // apply; what does apply is quiet hours, which `deliverableAt` handles by
  // deferring an informational push rather than dropping it.
  [NotificationChannel.PUSH]: {
    [NotificationUrgency.OPERATIONAL]: true,
    [NotificationUrgency.INFORMATIONAL]: true,
  },
  [NotificationChannel.SMS]: {
    [NotificationUrgency.OPERATIONAL]: true,
    [NotificationUrgency.INFORMATIONAL]: false,
  },
};

/** The one channel a person cannot switch off, because it is the record. */
export const ALWAYS_ON_CHANNELS: readonly NotificationChannel[] = [
  NotificationChannel.IN_APP,
];

/**
 * Resolves whether a channel carries a given kind for a given person.
 *
 * A stored preference overrides the default for that channel, but only where a
 * preference is allowed to exist at all.
 */
export function channelCarries(input: {
  channel: NotificationChannel;
  urgency: NotificationUrgency;
  /** The recipient's stored switch for this channel, if they have set one. */
  preference?: boolean | undefined;
}): boolean {
  if (ALWAYS_ON_CHANNELS.includes(input.channel)) {
    return true;
  }
  if (input.preference !== undefined) {
    // Somebody who turned SMS on wants the informational ones too; somebody who
    // turned it off means it.
    return input.preference;
  }
  return CHANNEL_DEFAULTS[input.channel][input.urgency];
}

// --- Quiet hours -------------------------------------------------------------

/** Philippine Standard Time. No daylight saving, so a fixed offset is correct. */
const PH_UTC_OFFSET_HOURS = 8;
/** Quiet from 22:00 to 06:00 local. */
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 6;

/** The hour of day in Manila for an instant. */
export function philippineHour(at: Date): number {
  return (at.getUTCHours() + PH_UTC_OFFSET_HOURS) % 24;
}

export function isQuietHour(at: Date): boolean {
  const hour = philippineHour(at);
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * The next instant quiet hours end.
 *
 * Used to defer rather than drop: a message held at 1am is still worth having
 * at 6am, and dropping it would mean a customer never learns their order was
 * cancelled overnight.
 */
export function quietHoursEnd(at: Date): Date {
  const hour = philippineHour(at);
  const hoursUntilSix = hour < QUIET_HOURS_END ? QUIET_HOURS_END - hour : 24 - hour + QUIET_HOURS_END;
  const end = new Date(at.getTime() + hoursUntilSix * 60 * 60 * 1000);
  // Land exactly on the hour, so a night's worth of deferrals do not fan out
  // across the 6am minute they happened to be enqueued in.
  end.setUTCMinutes(0, 0, 0);
  return end;
}

/**
 * When a delivery should next be attempted, given the policy and the clock.
 *
 * OPERATIONAL messages ignore quiet hours. Somebody is waiting on an action,
 * and a store that finds out at 6am about an order placed at 1am has already
 * lost it.
 */
export function deliverableAt(input: {
  urgency: NotificationUrgency;
  channel: NotificationChannel;
  now: Date;
}): Date {
  if (ALWAYS_ON_CHANNELS.includes(input.channel)) {
    return input.now;
  }
  if (input.urgency === NotificationUrgency.OPERATIONAL) {
    return input.now;
  }
  return isQuietHour(input.now) ? quietHoursEnd(input.now) : input.now;
}

// --- Retries -----------------------------------------------------------------

/**
 * Three attempts, then it is a FAILED row with the gateway's own words in it.
 *
 * Retrying forever turns one broken number into an unbounded spend, and an SMS
 * that finally lands two hours later is worse than none: the order it was about
 * has already been cancelled.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** 1 minute, then 5, then 25. */
export function retryDelayMs(attempts: number): number {
  const minutes = [1, 5, 25];
  return (minutes[Math.min(attempts, minutes.length - 1)] ?? 25) * 60 * 1000;
}
