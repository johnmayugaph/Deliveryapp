import Link from 'next/link';
import { notFound } from 'next/navigation';
import { VerificationStatus } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { consolePartnerDetail } from '@/lib/admin/fleet';
import {
  VERIFICATION_STATUS_LABEL,
  canDecide,
  describeWait,
  isWaitingOnUs,
  permitsWork,
} from '@/lib/fleet/verification-policy';
import {
  decideFleetApplicationAction,
  setFleetSuspensionAction,
} from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  Empty,
  Panel,
  PersonLink,
  Pill,
  Stat,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';
import { formatPhilippineMobile } from '@/lib/auth/phone';

export const dynamic = 'force-dynamic';

/**
 * One fleet partner, and the decisions waiting on them.
 *
 * Every application gets its own set of controls rather than one form with a
 * service dropdown. That is the screen enforcing what the data model already
 * says: approving somebody is not a thing you do to a person, it is a thing you
 * do to one application, and a form that could send "approve" without naming a
 * service is a form that will eventually approve the wrong one.
 *
 * A refusal's reason is shown to the applicant on their own profile screen, so
 * the field says so where it is typed. It is the same text the audit row keeps,
 * because two boxes is how "see notes" ends up being what the rider reads.
 */
export default async function AdminFleetPartnerPage({
  params,
}: {
  params: Promise<{ partnerId: string }>;
}) {
  const { partnerId } = await params;
  await requireAdmin();

  const detail = await consolePartnerDetail(partnerId);
  if (!detail) notFound();

  const { partner, user, applications, cityName } = detail;
  const now = new Date();
  const waiting = applications.filter((row) => isWaitingOnUs(row.status));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/fleet" className="text-[11px] font-semibold text-brand-700">
          ← Fleet
        </Link>
        <h1 className="mt-1 text-lg font-bold">
          {user.fullName ?? user.displayName ?? formatPhilippineMobile(user.phone)}
        </h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <PersonLink user={user} />
          <span>·</span>
          <span>{humaniseEnum(partner.vehicleType)}</span>
          {partner.vehiclePlate ? <span>· {partner.vehiclePlate}</span> : null}
          <span>· {cityName ?? 'no home city'}</span>
          {partner.isSuspended ? <Pill tone="bad">Suspended</Pill> : null}
          {user.isBlocked ? <Pill tone="bad">Account blocked</Pill> : null}
          {partner.isOnline && !partner.isSuspended ? <Pill tone="good">Online</Pill> : null}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Waiting on us"
          value={String(waiting.length)}
          note={
            waiting.length > 0
              ? `oldest ${describeWait(waiting[0]!.submittedAt ?? waiting[0]!.createdAt, now)}`
              : undefined
          }
        />
        {/* Named from the registry, like every other service label in the
            application — an operator should not have to know that RIDE is
            what customers call Sakay. */}
        <Stat
          label="Approved for"
          value={String(partner.enabledServices.length)}
          note={
            applications
              .filter((application) => permitsWork(application.status))
              .map((application) => application.serviceName)
              .join(', ') || 'nothing yet'
          }
        />
        <Stat label="Deliveries" value={String(partner.completedOrderCount)} />
        <Stat
          label="Rating"
          value={partner.ratingCount === 0 ? '—' : partner.ratingAvg.toFixed(1)}
          note={partner.ratingCount === 0 ? 'no ratings yet' : `${partner.ratingCount} ratings`}
        />
      </div>

      <Panel
        title="Applications"
        description="One decision per service. The partner is told which service it was about, and a refusal carries the reason you write here."
      >
        {applications.length === 0 ? (
          <Empty>
            This partner has applied for nothing. They choose a service from
            their own profile screen — the console cannot apply on their behalf,
            because an approval nobody submitted documents for is exactly what
            per-service verification exists to prevent.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {applications.map((application) => (
              <li key={application.id} className="px-4 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-semibold">
                      {application.serviceName}
                      {application.isActiveService ? null : (
                        <span className="ml-1.5 text-[10px] font-normal text-ink-faint">
                          service not live yet
                        </span>
                      )}
                    </p>
                    {/* "They were told" belongs on the ROW, not only in the
                        confirmation sentence, because whether the partner was
                        notified is the one thing an administrator cannot
                        otherwise see. It is true by construction HERE: the
                        message is enqueued in the same transaction as the
                        decision.
                        
                        And only where a decider is recorded. A row decided by
                        `npm run fleet:approve` has no decider and sent no
                        message, so claiming otherwise would be a comfortable
                        lie about somebody who is still waiting to hear. */}
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {application.submittedAt
                        ? `applied ${manilaTime(application.submittedAt)}`
                        : 'never submitted'}
                      {application.decidedAt
                        ? ` · decided ${manilaTime(application.decidedAt)}${
                            application.decidedBy
                              ? ` by ${application.decidedBy} · they were told`
                              : ' in a shell, so nobody told them'
                          }`
                        : ''}
                    </p>
                  </div>
                  <Pill
                    tone={
                      application.status === VerificationStatus.APPROVED
                        ? 'good'
                        : application.status === VerificationStatus.PENDING
                          ? 'warn'
                          : application.status === VerificationStatus.NOT_SUBMITTED
                            ? 'neutral'
                            : 'bad'
                    }
                  >
                    {VERIFICATION_STATUS_LABEL[application.status]}
                  </Pill>
                </div>

                {/* Only where there is a decision to take. "No documents
                    attached" is a warning about an application; on a service
                    nobody applied for it is just noise. */}
                {canDecide(application.status) ? (
                  <p className="mt-2 text-[11px] text-ink-muted">
                    <span className="font-semibold">Documents:</span>{' '}
                    {application.documents.length === 0 ? (
                      <span className="text-amber-700">
                        none attached — there is nothing here to check, so ask
                        before approving
                      </span>
                    ) : (
                      application.documents.join(', ')
                    )}
                  </p>
                ) : null}

                {application.rejectionReason ? (
                  <p className="mt-1 text-[11px] text-rose-700">
                    <span className="font-semibold">They were told:</span>{' '}
                    {application.rejectionReason}
                  </p>
                ) : null}

                {canDecide(application.status) ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {application.status === VerificationStatus.APPROVED ? null : (
                      <ReasonForm
                        action={decideFleetApplicationAction}
                        hidden={{
                          partnerId: partner.id,
                          serviceType: application.serviceType,
                          decision: VerificationStatus.APPROVED,
                        }}
                        submitLabel={`Approve for ${application.serviceName}`}
                        placeholder="What you checked, or who asked"
                      >
                        Offers in {application.serviceName} can reach them
                        immediately. Nothing about any other service changes.
                      </ReasonForm>
                    )}

                    {application.status === VerificationStatus.REJECTED ? null : (
                      <ReasonForm
                        action={decideFleetApplicationAction}
                        hidden={{
                          partnerId: partner.id,
                          serviceType: application.serviceType,
                          decision: VerificationStatus.REJECTED,
                        }}
                        submitLabel="Refuse"
                        tone="danger"
                        placeholder="Expired licence, unreadable photo…"
                      >
                        <strong>The applicant is shown this reason.</strong> It is
                        the only thing that tells them what to fix, so write it
                        for them and not for the log.
                      </ReasonForm>
                    )}

                    {application.status === VerificationStatus.APPROVED ? (
                      <ReasonForm
                        action={decideFleetApplicationAction}
                        hidden={{
                          partnerId: partner.id,
                          serviceType: application.serviceType,
                          decision: VerificationStatus.SUSPENDED,
                        }}
                        submitLabel="Suspend this approval"
                        tone="danger"
                        placeholder="Why, in terms they can act on"
                      >
                        Stops {application.serviceName} work only. The applicant
                        is shown this reason.
                      </ReasonForm>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-faint">
                    Nothing to decide until they apply.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={partner.isSuspended ? 'Reinstate' : 'Suspend from all work'}
        description="A different judgement from the ones above: not whether the documents are good, but whether they should be working at all today."
      >
        <div className="px-4 py-4">
          <ReasonForm
            action={setFleetSuspensionAction}
            hidden={{
              partnerId: partner.id,
              suspended: partner.isSuspended ? 'false' : 'true',
            }}
            submitLabel={partner.isSuspended ? 'Reinstate' : 'Suspend'}
            tone={partner.isSuspended ? 'default' : 'danger'}
          >
            {partner.isSuspended
              ? 'Their per-service approvals were left intact, so this puts them straight back to work.'
              : 'Takes them offline immediately and stops every service at once. Their approvals are kept, so reinstating is one click.'}
          </ReasonForm>
        </div>
      </Panel>
    </div>
  );
}
