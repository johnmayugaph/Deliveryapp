import { describeSmsSetup } from '@/lib/auth/sms';
import Link from 'next/link';
import { NotificationChannel } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { deliveryHealth, demoDataPresence } from '@/lib/admin/queries';
import { operatingDataGaps } from '@/lib/admin/operating-data';
import { resolveChannels } from '@/lib/notifications/channels';
import { isPushConfigured } from '@/lib/notifications/push/vapid';
import { captchaIsHalfConfigured, isCaptchaConfigured } from '@/lib/auth/captcha';
import { backupState } from '@/lib/backup/queries';
import { menuImageFootprint } from '@/lib/media/menu-images';
import { OPENSTREETMAP, tileSource } from '@/lib/geo/tiles';
import { paymentRailStatus } from '@/lib/payments/rails';
import { supportSummary } from '@/lib/support/queries';
import { contactDetails, describeContactPosture } from '@/lib/support/contact';
import {
  SUPPORT_RESPONSE_TARGET_MINUTES,
  describeWait,
} from '@/lib/support/policy';
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

  const [health, demo, backups, support, photos, gaps] = await Promise.all([
    deliveryHealth(),
    demoDataPresence(),
    backupState(),
    supportSummary(),
    menuImageFootprint(),
    operatingDataGaps(),
  ]);

  // Read on the server, like everywhere else this is used: a NEXT_PUBLIC_
  // variable would bake the build machine's setting into the image.
  const source = tileSource();
  const tiles = {
    url: source.url,
    isDefault: source.url === OPENSTREETMAP.url,
  };

  // Reduced to a status before it reaches the page: the account NUMBER is
  // configuration a health screen has no reason to print, and the label is
  // enough to say whether the rail is on.
  const paymentRail = paymentRailStatus();

  const contact = contactDetails();
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

      {gaps.length > 0 ? (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
          <p className="font-semibold">
            {gaps.length === 1
              ? 'One feature is switched off because the rows it reads do not exist.'
              : `${gaps.length} features are switched off because the rows they read do not exist.`}
          </p>
          {/* Not "misconfigured". Every one of these can be a deliberate
              launch choice — no surge, no points programme — and the screen
              has no way to tell a choice from an oversight. What it CAN do is
              stop the choice being invisible, which is the whole reason this
              panel exists: a deployment rehearsal found three of them at zero
              on a database provisioned exactly as the documentation said. */}
          <p className="mt-1">
            Each of these is a feature that exists in full and does nothing.
            Some may be what you intended; the point is that until now there
            was nowhere to see which.
          </p>
          <ul className="mt-2 space-y-2">
            {gaps.map((gap) => (
              <li key={gap.what} className="rounded-lg bg-black/5 px-2.5 py-2">
                <p>{gap.consequence}</p>
                {gap.fix.kind === 'screen' ? (
                  <Link
                    href={gap.fix.href}
                    className="mt-1 inline-block font-semibold underline"
                  >
                    {gap.fix.href}
                  </Link>
                ) : (
                  <>
                    <pre className="mt-1.5 overflow-x-auto rounded bg-black/5 px-2 py-1.5 text-[11px]">
                      {gap.fix.command}
                    </pre>
                    <p className="mt-1">{gap.fix.note}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {demo.demoUsers > 0 || demo.demoStores > 0 ? (
        <div
          className={
            demo.usableHere
              ? 'rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200'
              : 'rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200'
          }
        >
          <p className="font-semibold">
            {demo.demoUsers} demo account{demo.demoUsers === 1 ? '' : 's'} and{' '}
            {demo.demoStores} demo store{demo.demoStores === 1 ? '' : 's'} are still
            in this database
            {demo.demoAdmins > 0
              ? `, ${demo.demoAdmins} of them holding ADMIN`
              : ''}
            .
          </p>
          {demo.usableHere ? (
            <p className="mt-1">
              Fine here — this is not a production runtime, and the demo data is
              what makes a fresh clone usable. It must not reach a deployment
              real people can open: the seed uses real Philippine number
              formats, so a stranger owns every one of those numbers. Purge it
              as the first step of going live.
            </p>
          ) : (
            <p className="mt-1">
              Demo accounts are refused a session here, so nobody can sign into
              them — but the stores are visible and a customer can order from
              them, and nobody will cook it. Purge them now.
            </p>
          )}
          <pre className="mt-2 overflow-x-auto rounded-lg bg-black/5 px-2.5 py-2 text-[11px]">
            npm run db:purge-demo{'\n'}npm run db:purge-demo -- --confirm
          </pre>
          {demo.realAdmins === 0 ? (
            <p className="mt-2 font-semibold">
              There is no non-demo administrator account. Make one on a number
              you control before purging, or nobody will be able to open this
              console: npm run admin:grant -- 09XXXXXXXXX --reason &ldquo;…&rdquo;
            </p>
          ) : null}
        </div>
      ) : null}

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
              ? `Set an SMS gateway: ${describeSmsSetup()}. `
              : ''}
            {stuck.some((row) => row.channel === NotificationChannel.PUSH)
              ? 'Run npm run push:keys for push. '
              : ''}
            The backlog goes out on the first pass after that.
          </p>
        </div>
      ) : null}

      {captchaIsHalfConfigured() ? (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
          <p className="font-semibold">
            The CAPTCHA has one key, not two — so it is doing nothing.
          </p>
          <p className="mt-1">
            <code>TURNSTILE_SECRET_KEY</code> and{' '}
            <code>NEXT_PUBLIC_TURNSTILE_SITE_KEY</code> are both required. With
            only one set the login screen deliberately behaves as though no
            CAPTCHA were configured, because the alternative — a widget nobody
            can solve, or a token nobody checks — would lock every customer out
            rather than let a few extra requests through. The rate limits are
            still in force. Set the other half.
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
        title="Backups"
        description="The credits ledger and the order history exist nowhere else. This panel says what this application can actually see — which is less than you might want."
        action={
          <Pill tone={backups.posture.alarming ? 'bad' : backups.posture.verifiable ? 'good' : 'warn'}>
            {backups.posture.strategy === 'none'
              ? 'Not declared'
              : backups.posture.strategy === 'host'
                ? 'Host-managed'
                : 'From the script'}
          </Pill>
        }
      >
        <div className="space-y-3 px-4 py-3">
          <p
            className={`text-xs leading-relaxed ${
              backups.posture.alarming ? 'font-semibold text-red-800' : 'text-ink-muted'
            }`}
          >
            {backups.posture.headline}
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Last backup"
              value={backups.lastSuccessAt ? manilaTime(backups.lastSuccessAt) : 'Never'}
              note={
                backups.sizeBytes === null
                  ? undefined
                  : `${(backups.sizeBytes / 1_048_576).toFixed(1)} MB`
              }
            />
            <Stat
              label="Restored and checked"
              value={backups.lastVerifiedAt ? manilaTime(backups.lastVerifiedAt) : 'Never'}
              note={backups.lastVerifiedAt ? undefined : 'npm run db:restore-check'}
            />
            <Stat
              label="Encrypted"
              value={
                backups.encrypted === null ? '—' : backups.encrypted ? 'Yes' : 'No'
              }
              note={
                backups.encrypted === false
                  ? 'set BACKUP_ENCRYPTION_KEY'
                  : undefined
              }
            />
            <Stat
              label="Failed since"
              value={String(backups.failuresSinceSuccess)}
              note="attempts since the last success"
            />
            {/* Menu photographs are bytes in this database, so they are bytes
                in every dump of it. Shown next to the backup size because
                that is where "why did the backup get big" gets asked. */}
            <Stat
              label="Menu photos"
              value={String(photos.count)}
              note={
                photos.count === 0
                  ? 'none uploaded yet'
                  : `${(photos.bytes / 1_048_576).toFixed(1)} MB of this database`
              }
            />
          </div>

          {backups.lastFailure && backups.failuresSinceSuccess > 0 ? (
            <p className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-relaxed text-red-900">
              Last failure {manilaTime(backups.lastFailure.startedAt)}:{' '}
              {backups.lastFailure.error ?? 'no reason recorded'}
            </p>
          ) : null}

          <p className="text-[11px] leading-relaxed text-ink-faint">
            Whatever this says, the thing that actually saves you is
            point-in-time recovery on the database host — it survives this
            machine, and this application cannot see whether it is switched on.
            The dump is the copy you can take somewhere else.
          </p>
        </div>
      </Panel>

      <Panel
        title="Taking money"
        description="Cash on delivery always works. Prepayment needs an account for customers to send to, and it is what takes cash out of a rider's hands."
        action={
          <Pill tone={paymentRail.configured ? 'good' : 'warn'}>
            {paymentRail.configured ? paymentRail.label : 'Cash only'}
          </Pill>
        }
      >
        <div className="space-y-2 px-4 py-3">
          <p
            className={`text-xs leading-relaxed ${
              paymentRail.configured ? 'text-ink-muted' : 'font-semibold text-amber-800'
            }`}
          >
            {paymentRail.configured
              ? `Customers can pay in advance by ${paymentRail.label} transfer, and somebody here confirms each one against the account. Prepaid orders wait in PENDING_PAYMENT and never reach a store unconfirmed.`
              : 'Every order is cash on delivery, so riders carry money for the whole shift. Set PAYMENT_TRANSFER_LABEL, PAYMENT_TRANSFER_ACCOUNT_NAME and PAYMENT_TRANSFER_ACCOUNT_NUMBER — all three, or the method stays off — to let customers pay in advance.'}
          </p>
          {paymentRail.missing.length > 0 && paymentRail.missing.length < 3 ? (
            <p className="text-[11px] font-semibold leading-relaxed text-amber-800">
              Partly configured, so it is switched off on purpose: {paymentRail.missing.join(', ')}{' '}
              {paymentRail.missing.length === 1 ? 'is' : 'are'} missing. Offering a
              transfer with no account to send it to takes an order nobody can pay.
            </p>
          ) : null}
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Confirmation is a person reading a statement, not a webhook, and that
            is a deliberate limit rather than a stopgap: it needs no provider
            account, has no per-transaction fee, and does not scale past the
            volume one person can check. There is a seam for a provider rail when
            it starts hurting — see docs/architecture.md.
          </p>
        </div>
      </Panel>

      <Panel
        title="Map tiles"
        description="Live tracking puts a map on a customer's screen, which is the point at which whose tiles these are stops being a detail."
        action={
          <Pill tone={tiles.isDefault ? 'warn' : 'good'}>
            {tiles.isDefault ? 'OpenStreetMap' : 'Your own'}
          </Pill>
        }
      >
        <div className="space-y-2 px-4 py-3">
          {/* Written down here rather than left in a code comment because it
              is a licence matter, not a performance one: OSM's tile policy
              covers light use, and a map on every live delivery is not that.
              The seam has existed since the store picker was built; this is
              the deployment that has to use it. */}
          <p
            className={`text-xs leading-relaxed ${
              tiles.isDefault ? 'font-semibold text-amber-800' : 'text-ink-muted'
            }`}
          >
            {tiles.isDefault
              ? 'Tiles are coming from OpenStreetMap’s own servers. Their policy allows light use, and a map on every live delivery is not light use — set MAP_TILE_URL to a provider or to tiles you host before real volume.'
              : 'Tiles are coming from your own MAP_TILE_URL, which is what a customer-facing map needs.'}
          </p>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            The map only loads while a rider is carrying an order, so requests
            are proportional to live deliveries rather than to page views. It is
            never on a delivered order.
          </p>
          <p className="break-all font-mono text-[11px] text-ink-faint">{tiles.url}</p>
        </div>
      </Panel>

      <Panel
        title="Reaching a person"
        description="Two paths, and they are not alternatives: a ticket for somebody signed in, and a phone number or email for somebody who cannot sign in at all."
        action={
          <Pill tone={contact.channels.length === 0 ? 'bad' : 'good'}>
            {contact.channels.length === 0 ? 'No public channel' : 'Reachable'}
          </Pill>
        }
      >
        <div className="space-y-3 px-4 py-3">
          <p
            className={`text-xs leading-relaxed ${
              contact.channels.length === 0
                ? 'font-semibold text-red-800'
                : 'text-ink-muted'
            }`}
          >
            {describeContactPosture()}
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Waiting on us" value={String(support.waiting)} />
            <Stat
              label="Never answered"
              value={String(support.neverAnswered)}
              note={support.neverAnswered > 0 ? 'nobody has replied at all' : undefined}
            />
            <Stat
              label="Longest wait"
              value={
                support.waiting === 0 ? '—' : describeWait(support.longestWaitMinutes)
              }
              note={
                support.longestWaitMinutes >= SUPPORT_RESPONSE_TARGET_MINUTES
                  ? 'past the target'
                  : undefined
              }
            />
            <Stat
              label="Typical first reply"
              value={
                support.medianFirstReplyMinutes === null
                  ? '—'
                  : describeWait(support.medianFirstReplyMinutes)
              }
              note={`median of ${support.answeredThisWeek} this week`}
            />
          </div>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            The queue lives at /admin/support. An unanswered ticket alerts every
            administrator when it is raised, and again once it has been waiting
            past the target — which needs the order sweep to be running.
          </p>
        </div>
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
          <Stat
            label="Login CAPTCHA"
            value={isCaptchaConfigured() ? 'On' : 'Off'}
            note={
              isCaptchaConfigured()
                ? 'Turnstile, checked before any code is sent'
                : 'rate limits only — every request past them costs a peso'
            }
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
