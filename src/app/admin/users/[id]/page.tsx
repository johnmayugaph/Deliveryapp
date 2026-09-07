import Link from 'next/link';
import { notFound } from 'next/navigation';
import { VerificationStatus } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import {
  listAdminActions,
  MAX_ADJUSTMENT_CENTAVOS,
  requireAdmin,
} from '@/lib/admin/access';
import { userDetail } from '@/lib/admin/queries';
import {
  adjustCreditsAction,
  endSubscriptionAction,
  moveAccountPhoneAction,
  setUserBlockedAction,
} from '@/lib/actions/admin-actions';
import { listRecoveries, RECOVERY_CREDIT_FREEZE_DAYS } from '@/lib/auth/recovery';
import { LIVE_SUBSCRIPTION_STATUSES } from '@/lib/subscriptions/enrollment';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  StatusPill,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * One person.
 *
 * The three controls here are the ones support genuinely needs and nothing
 * else: block an account, correct a credits balance, end a subscription. Each
 * takes a reason, writes an audit row in the same transaction, and is capped
 * or routed so it cannot become something it should not be — the credits
 * control goes through the ledger function and is capped, because a support
 * tool that can issue unlimited credit is a support tool that will.
 *
 * What is absent is as deliberate: no role editing (a role change is a
 * decision with consequences across three apps and belongs in a reviewed
 * script), no phone number editing (the phone IS the identity, and changing it
 * is an account takeover with extra steps), and no top-up.
 */
export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  const { id } = await params;

  const [user, auditTrail, recoveries] = await Promise.all([
    userDetail(id),
    listAdminActions({ subjectType: 'User', subjectId: id, limit: 30 }),
    listRecoveries(id),
  ]);
  if (!user) notFound();

  // The same definition of "live" the enrollment layer uses, imported rather
  // than restated, so the console cannot disagree with the invariant the
  // database enforces.
  const liveSubscription = user.subscriptions.find((subscription) =>
    LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status),
  );
  const approvedFor =
    user.fleetPartner?.serviceVerifications.filter(
      (verification) => verification.status === VerificationStatus.APPROVED,
    ) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold">
              {user.fullName ?? user.displayName ?? '(no name yet)'}
            </h1>
            {user.isBlocked ? <Pill tone="bad">Blocked</Pill> : null}
            {user.roles.map((role) => (
              <Pill key={role}>{humaniseEnum(role)}</Pill>
            ))}
          </div>
          <p className="mt-1 font-mono text-xs text-ink-muted">{user.phone}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Joined {manilaTime(user.createdAt)}
            {user.onboardedAt ? ` · onboarded ${manilaTime(user.onboardedAt)}` : ' · never onboarded'}
            {` · ${user._count.sessions} active session${user._count.sessions === 1 ? '' : 's'}`}
          </p>
        </div>
        <Link href="/admin/users" className="text-[12px] font-semibold text-brand-700">
          ← Search
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Credits"
          value={formatCentavos(user.wallet?.balanceCentavos ?? 0)}
          note={user.wallet?.isFrozen ? 'frozen' : 'spendable on orders'}
        />
        <Stat label="Orders" value={String(user.orders.length)} note="most recent 20 shown" />
        <Stat
          label="Subscription"
          value={liveSubscription ? liveSubscription.plan.name : 'None'}
          note={liveSubscription ? humaniseEnum(liveSubscription.origin) : undefined}
        />
        <Stat
          label="Push devices"
          value={String(user.pushSubscriptions.filter((device) => !device.expiredAt).length)}
          note={`${user.pushSubscriptions.length} recorded`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title={user.isBlocked ? 'Unblock this account' : 'Block this account'}
          description={
            user.isBlocked
              ? 'They will be able to sign in again.'
              : 'Signs them out everywhere and stops them signing back in.'
          }
        >
          <div className="px-4 py-3">
            {user.id === admin.id ? (
              <p className="text-xs text-ink-muted">
                This is your own account. Blocking it would lock you out of the
                console with no way back in, so the action refuses.
              </p>
            ) : (
              <ReasonForm
                action={setUserBlockedAction}
                hidden={{ userId: user.id, blocked: user.isBlocked ? 'false' : 'true' }}
                submitLabel={user.isBlocked ? 'Unblock' : 'Block and sign out'}
                tone={user.isBlocked ? 'default' : 'danger'}
              >
                {user.isBlocked
                  ? null
                  : 'Their sessions are deleted too — blocking without that leaves somebody signed in and wondering why nothing works.'}
              </ReasonForm>
            )}
          </div>
        </Panel>

        <Panel
          title="Correct their credits"
          description={`Goes through the ledger. Capped at ${formatCentavos(MAX_ADJUSTMENT_CENTAVOS)} per adjustment.`}
        >
          <div className="px-4 py-3">
            <ReasonForm
              action={adjustCreditsAction}
              hidden={{ userId: user.id }}
              submitLabel="Record adjustment"
              placeholder="Ticket number, and what went wrong"
              extraFields={
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    Amount in pesos
                  </span>
                  <input
                    name="pesos"
                    type="number"
                    step="0.01"
                    required
                    placeholder="50 to credit, -50 to take back"
                    aria-label="Amount in pesos"
                    className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-xs"
                  />
                </label>
              }
            >
              For correcting a mistake the system made — a refund that did not
              fire, a promo credited twice. It writes a ledger row and
              recalculates the balance from the ledger; nothing here can set a
              balance directly.
            </ReasonForm>
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Move this account to a new number"
          description={`The fallback for somebody who never added a recovery email. Same safeguards as self-service: sessions revoked, credits frozen ${RECOVERY_CREDIT_FREEZE_DAYS} days, previous number texted.`}
        >
          <div className="px-4 py-3">
            {user.id === admin.id ? (
              <p className="text-xs text-ink-muted">
                This is your own account. Moving your own number here would
                revoke your own session mid-request and freeze your own credits,
                so the action refuses — use your profile.
              </p>
            ) : (
              <ReasonForm
                action={moveAccountPhoneAction}
                hidden={{ userId: user.id }}
                submitLabel="Move the number"
                tone="danger"
                placeholder="What you checked — order number, address, last order total"
                extraFields={
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      New number
                    </span>
                    <input
                      name="newPhone"
                      inputMode="tel"
                      required
                      placeholder="0917 123 4567"
                      aria-label="New phone number"
                      className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-xs"
                    />
                  </label>
                }
              >
                The reason field is the verification. Write what you actually
                checked — a recent order number, a saved address, the total on
                their last order. &ldquo;Customer asked&rdquo; is the shape a
                social-engineering success takes, and it stays in the log.
              </ReasonForm>
            )}
          </div>
        </Panel>

        <Panel
          title="Number history"
          description="Append-only. Every move this account has ever had."
        >
          {recoveries.length === 0 ? (
            <Empty>This account has never changed its number.</Empty>
          ) : (
            <ul className="divide-y divide-black/5">
              {recoveries.map((recovery) => (
                <li key={recovery.id} className="px-4 py-2 text-xs">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={recovery.method === 'SUPPORT_ASSISTED' ? 'warn' : 'neutral'}>
                      {humaniseEnum(recovery.method)}
                    </Pill>
                    <span className="text-ink-faint">{manilaTime(recovery.createdAt)}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px]">
                    {recovery.previousPhone} → {recovery.newPhone}
                  </p>
                  <p className="mt-0.5 text-ink-muted">
                    {recovery.viaEmail
                      ? `Proved with ${recovery.viaEmail}`
                      : `By ${recovery.assistedBy?.fullName ?? recovery.assistedBy?.phone ?? 'an administrator'}`}
                    {recovery.reason ? ` — ${recovery.reason}` : ''}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {recovery.alertSentAt
                      ? `Previous number alerted ${manilaTime(recovery.alertSentAt)}`
                      : recovery.alertError
                        ? `Alert undeliverable: ${recovery.alertError}`
                        : 'Alert to the previous number still queued'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {liveSubscription ? (
        <Panel
          title={`${liveSubscription.plan.name} — ${humaniseEnum(liveSubscription.status)}`}
          description={`${humaniseEnum(liveSubscription.origin)}${
            liveSubscription.renewsAt ? `, renews ${manilaTime(liveSubscription.renewsAt)}` : ''
          }`}
        >
          <div className="px-4 py-3">
            {liveSubscription.grantNote ? (
              <p className="mb-2 text-xs leading-relaxed text-ink-muted">
                Granted with the note: “{liveSubscription.grantNote}”
              </p>
            ) : null}
            <ReasonForm
              action={endSubscriptionAction}
              hidden={{ userId: user.id }}
              submitLabel="End it now"
              tone="danger"
            >
              Ends immediately rather than at the end of the term.
            </ReasonForm>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Credits ledger"
        description="Append-only. The balance above is derived from these rows, not stored independently."
      >
        {!user.wallet || user.wallet.transactions.length === 0 ? (
          <Empty>No credits have ever moved on this account.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Balance after</Th>
                <Th>Description</Th>
                <Th>Recorded by</Th>
              </tr>
            </thead>
            <tbody>
              {user.wallet.transactions.map((entry) => (
                <tr key={entry.id}>
                  <Td muted>{manilaTime(entry.createdAt)}</Td>
                  <Td>
                    <Pill tone={entry.amountCentavos > 0 ? 'good' : 'neutral'}>
                      {humaniseEnum(entry.type)}
                    </Pill>
                  </Td>
                  <Td numeric>
                    <span className={entry.amountCentavos > 0 ? 'text-emerald-700' : ''}>
                      {entry.amountCentavos > 0 ? '+' : '−'}
                      {formatCentavos(Math.abs(entry.amountCentavos))}
                    </span>
                  </Td>
                  <Td numeric muted>
                    {formatCentavos(entry.balanceAfterCentavos)}
                  </Td>
                  <Td muted>{entry.description}</Td>
                  <Td muted>
                    {entry.adminUser
                      ? (entry.adminUser.fullName ?? entry.adminUser.phone)
                      : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel title="Recent orders">
        {user.orders.length === 0 ? (
          <Empty>No orders.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th numeric>Total</Th>
                <Th>Placed</Th>
              </tr>
            </thead>
            <tbody>
              {user.orders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <Link
                      href={`/admin/orders/${order.orderNumber}`}
                      className="font-mono text-[11px] font-semibold text-brand-700 hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                  </Td>
                  <Td>{order.serviceType}</Td>
                  <Td>
                    <StatusPill status={order.status} />
                  </Td>
                  <Td numeric>{formatCentavos(order.totalCentavos)}</Td>
                  <Td muted>{manilaTime(order.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Notification settings" description="What they chose, and what they can be reached on.">
          <ul className="divide-y divide-black/5 text-xs">
            {user.notificationPreferences.length === 0 ? (
              <li className="px-4 py-2 text-ink-muted">
                Never touched a setting — everything is on its default.
              </li>
            ) : (
              user.notificationPreferences.map((preference) => (
                <li key={preference.id} className="flex items-baseline gap-2 px-4 py-2">
                  <span className="w-16 font-semibold">{preference.channel}</span>
                  <Pill tone={preference.enabled ? 'good' : 'neutral'}>
                    {preference.enabled ? 'On' : 'Off'}
                  </Pill>
                  <span className="text-ink-faint">
                    changed {manilaTime(preference.updatedAt)}
                  </span>
                </li>
              ))
            )}
            {user.pushSubscriptions.map((device) => (
              <li key={device.id} className="px-4 py-2">
                <span className="text-ink-muted">Push device</span>{' '}
                <Pill tone={device.expiredAt ? 'bad' : 'good'}>
                  {device.expiredAt ? 'gone' : 'live'}
                </Pill>{' '}
                <span className="text-ink-faint">
                  last seen {manilaTime(device.lastSeenAt)}
                  {device.failureCount > 0 ? ` · ${device.failureCount} recent failures` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Other roles" description="Where else this account appears.">
          <ul className="divide-y divide-black/5 text-xs">
            {user.storeMemberships.map((membership) => (
              <li key={membership.id} className="px-4 py-2">
                <span className="font-semibold">{membership.store.name}</span>{' '}
                <Pill>{humaniseEnum(membership.role)}</Pill>
              </li>
            ))}
            {user.fleetPartner ? (
              <li className="px-4 py-2">
                <span className="font-semibold">Fleet partner</span>{' '}
                <Pill>{humaniseEnum(user.fleetPartner.vehicleType)}</Pill>{' '}
                <Pill tone={user.fleetPartner.isSuspended ? 'bad' : user.fleetPartner.isOnline ? 'good' : 'neutral'}>
                  {user.fleetPartner.isSuspended
                    ? 'suspended'
                    : user.fleetPartner.isOnline
                      ? 'online'
                      : 'offline'}
                </Pill>
                <p className="mt-1 text-ink-muted">
                  {approvedFor.length === 0
                    ? 'Approved for nothing yet — approval is held per service.'
                    : `Approved for ${approvedFor.map((v) => v.serviceType).join(', ')}`}
                </p>
              </li>
            ) : null}
            {user.storeMemberships.length === 0 && !user.fleetPartner ? (
              <li className="px-4 py-2 text-ink-muted">Customer only.</li>
            ) : null}
          </ul>
        </Panel>
      </div>

      <Panel
        title="Admin actions on this account"
        description="Append-only, and the reason is required by the database rather than by the form."
      >
        {auditTrail.length === 0 ? (
          <Empty>Nobody has changed anything on this account.</Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {auditTrail.map((event) => (
              <li key={event.id} className="px-4 py-2 text-xs">
                <span className="text-ink-faint">{manilaTime(event.createdAt)}</span>{' '}
                <span className="font-semibold">{humaniseEnum(event.action)}</span> by{' '}
                {event.actor.fullName ?? event.actor.phone}
                <p className="mt-0.5 text-ink-muted">{event.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
