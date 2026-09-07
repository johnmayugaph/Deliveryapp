import {
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ALWAYS_ON_CHANNELS, CHANNEL_DEFAULTS, KIND_POLICY } from '@/lib/notifications/policy';
import { skipPendingForChannel } from '@/lib/notifications/deliver';

/** Reading the inbox, and the one switch a person actually has. */

export async function listNotifications(
  userId: string,
  options: { limit?: number } = {},
) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 50,
    include: {
      deliveries: { select: { channel: true, status: true, sentAt: true } },
    },
  });
}

export async function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Marks one as read. Scoped by user, so an id from elsewhere reads nothing. */
export async function markRead(input: { userId: string; notificationId: string }) {
  const { count } = await prisma.notification.updateMany({
    where: { id: input.notificationId, userId: input.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export async function markAllRead(userId: string): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

/**
 * The channels a person can actually change, with their current state.
 *
 * IN_APP is excluded: it is the record of what somebody was told, and switching
 * it off would mean losing history rather than being left alone. The SQL guard
 * refuses a preference row for it too.
 */
export async function listChannelSwitches(userId: string) {
  const stored = await prisma.notificationPreference.findMany({ where: { userId } });
  const byChannel = new Map(stored.map((row) => [row.channel, row.enabled] as const));

  return Object.values(NotificationChannel)
    .filter((channel) => !ALWAYS_ON_CHANNELS.includes(channel))
    .map((channel) => ({
      channel,
      enabled:
        byChannel.get(channel) ??
        // The default depends on urgency, and the switch is one control, so it
        // shows the operational default — which is what the channel is for.
        CHANNEL_DEFAULTS[channel].OPERATIONAL,
      isDefault: !byChannel.has(channel),
      /** What this channel currently carries, so the screen can say. */
      carriesKinds: Object.entries(KIND_POLICY)
        .filter(([, policy]) => policy.channels.includes(channel))
        .map(([kind]) => kind),
    }));
}

export class ChannelNotSwitchableError extends Error {
  constructor(channel: NotificationChannel) {
    super(
      `${channel} cannot be switched off: it is the record of what somebody was told.`,
    );
    this.name = 'ChannelNotSwitchableError';
  }
}

/**
 * Sets a channel switch.
 *
 * Turning a channel off also skips what is already queued for it — otherwise a
 * backlog keeps arriving after somebody has asked it to stop, which reads as
 * the setting not working.
 */
export async function setChannelEnabled(input: {
  userId: string;
  channel: NotificationChannel;
  enabled: boolean;
}) {
  if (ALWAYS_ON_CHANNELS.includes(input.channel)) {
    throw new ChannelNotSwitchableError(input.channel);
  }

  await prisma.notificationPreference.upsert({
    where: { userId_channel: { userId: input.userId, channel: input.channel } },
    create: { userId: input.userId, channel: input.channel, enabled: input.enabled },
    update: { enabled: input.enabled },
  });

  if (!input.enabled) {
    await skipPendingForChannel({ userId: input.userId, channel: input.channel });
  }
}

/** For the inbox row: which channels this message actually went out through. */
export function sentChannels(
  deliveries: readonly { channel: NotificationChannel; status: NotificationDeliveryStatus }[],
): NotificationChannel[] {
  return deliveries
    .filter((delivery) => delivery.status === NotificationDeliveryStatus.SENT)
    .map((delivery) => delivery.channel);
}
