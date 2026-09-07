import Link from 'next/link';
import { NotificationChannel } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { deliveryHealth } from '@/lib/admin/queries';
import { resolveChannels } from '@/lib/notifications/channels';
import { isPushConfigured } from '@/lib/notifications/push/vapid';
import { requeueDeliveryAction } from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Whether messages are actually arriving.
 *
 * The number that matters is not "sent" — it is PENDING on a channel with no
 * adapter, because that is the failure that looks like nothing at all. A
 * deployment with no SMS gateway and no VAPID keys queues messages forever and
 * reports no errors, and the only place that shows up is here.
 *
 * So the top of the page asks the adapters themselves what is configured,
 * rather than inferring it from the rows. An unconfigured channel with a
 * backlog is the one line worth putting in red.
 */
export default async function AdminHealthPage() {
  await requireAdmin();

  const health = await deliveryHealth();
  // Asked of the same function the cron uses, so this reports what would
  // actually happen on the next pass rather than a separate guess at it.
  const configured = resolveChannels();

  const totals = health.byChannel.reduce(
    (sum, row) => ({
      pending: sum.pending + row.pending,
      sent: sum.sent + row.sent,
      failed: sum.failed + row.failed,
      skipped: sum.skipped + row.skipped,
    }),
    { pending: 0, sent: 0, failed: 0, skipped: 0 },
  );

  const stuck = health.byChannel.filter(
    (row) => row.pending > 0 && !configured.has(row.channel),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Delivery health</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Sending happens on the cron pass (<code>npm run jobs:orders</code>),
          not on a request. How quickly a store hears about an order is bounded
          by how often that runs.
        </p>
      </div>

      {stuck.length > 0 ? (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
          <p className="font-semibold">
            {stuck.map((row) => row.channel).join(' and ')} has a backlog and no
            adapter configured.
          </p>
          <p className="mt-1">
            Nothing is being sent on{' '}
            {stuck.length === 1 ? 'that channel' : 'those channels'} and nothing
            is raising an error — the rows are queued, which is the honest state
            and also the one nobody notices.{' '}
            {stuck.some((row) => row.channel === NotificationChannel.SMS)
              ? 'Set SEMAPHORE_API_KEY for SMS. '
              : ''}
            {stuck.some((row) => row.channel === NotificationChannel.PUSH)
              ? 'Run npm run push:keys for push. '
              : ''}
            The backlog goes out on the first pass after that.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sent" value={String(totals.sent)} />
        <Stat label="Queued" value={String(totals.pending)} note="waiting for the next pass" />
        <Stat label="Gave up" value={String(totals.failed)} note="after three attempts" />
        <Stat
          label="Not attempted"
          value={String(totals.skipped)}
          note="switched off, or nothing to send to"
        />
      </div>

      <Panel
        title="By channel"
        description="Configured means an adapter was built. An unconfigured channel keeps its queue rather than discarding it."
      >
        <TableScroll>
          <thead>
            <tr>
              <Th>Channel</Th>
              <Th>Configured</Th>
              <Th numeric>Queued</Th>
              <Th numeric>Sent</Th>
              <Th numeric>Gave up</Th>
              <Th numeric>Not attempted</Th>
            </tr>
          </thead>
          <tbody>
            {health.byChannel.map((row) => (
              <tr key={row.channel}>
                <Td>
                  <span className="font-semibold">{row.channel}</span>
                </Td>
                <Td>
                  {configured.has(row.channel) ? (
                    <Pill tone="good">Yes</Pill>
                  ) : (
                    <Pill tone={row.pending > 0 ? 'bad' : 'warn'}>No</Pill>
                  )}
                </Td>
                <Td numeric>{row.pending}</Td>
                <Td numeric>{row.sent}</Td>
                <Td numeric muted={row.failed === 0}>
                  {row.failed}
                </Td>
                <Td numeric muted>
                  {row.skipped}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </Panel>

      <Panel
        title="Push devices"
        description="A device the push service has told us is gone stays on record rather than being deleted, so support can see that somebody had push and lost it."
      >
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
          <Stat
            label="VAPID keys"
            value={isPushConfigured() ? 'Set' : 'Missing'}
            note={isPushConfigured() ? undefined : 'npm run push:keys'}
          />
          <Stat label="Devices gone" value={String(health.expiredPushDevices)} note="404 or 410" />
          <Stat
            label="Cron"
            value="jobs:orders"
            note="delivers the outbox on every run"
          />
        </div>
      </Panel>

      <Panel
        title="Deliveries that gave up"
        description="Three attempts failed. Requeue one if the cause has been fixed — it resets the attempt count."
      >
        {health.recentFailures.length === 0 ? (
          <Empty>Nothing has failed outright.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th>Message</Th>
                <Th>Recipient</Th>
                <Th numeric>Attempts</Th>
                <Th>Last error</Th>
                <Th>Requeue</Th>
              </tr>
            </thead>
            <tbody>
              {health.recentFailures.map((delivery) => (
                <tr key={delivery.id}>
                  <Td>
                    <Pill tone="bad">{delivery.channel}</Pill>
                  </Td>
                  <Td>
                    <span className="font-medium">{delivery.notification.title}</span>
                    <span className="mt-0.5 block text-[10px] text-ink-faint">
                      {humaniseEnum(delivery.notification.kind)} ·{' '}
                      {manilaTime(delivery.notification.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/users/${delivery.notification.user.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {delivery.notification.user.fullName ?? delivery.notification.user.phone}
                    </Link>
                  </Td>
                  <Td numeric>{delivery.attempts}</Td>
                  <Td muted>
                    <span className="block max-w-xs break-words">
                      {delivery.lastError ?? '—'}
                    </span>
                  </Td>
                  <Td>
                    <ReasonForm
                      action={requeueDeliveryAction}
                      hidden={{ deliveryId: delivery.id }}
                      submitLabel="Requeue"
                      placeholder="What was fixed"
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
