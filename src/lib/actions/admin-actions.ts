'use server';

import { revalidatePath } from 'next/cache';
import {
  AdminAction,
  NotificationDeliveryStatus,
  RecoveryMethod,
  ServiceKey,
  SubscriptionStatus,
  StoreRole,
  VerificationStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  AdminAccessRequiredError,
  AuditReasonRequiredError,
  MAX_ADJUSTMENT_CENTAVOS,
  normaliseReason,
  recordAdminAction,
  requireAdmin,
  type AdminActionResult,
} from '@/lib/admin/access';
import { recordAdjustment } from '@/lib/wallet/ledger';
import { centavosFromPesoInput, formatCentavos } from '@/lib/money';
import { cancelSubscription } from '@/lib/subscriptions/enrollment';
import {
  movePhoneNumber,
  PhoneAlreadyInUseError,
  SamePhoneError,
  RECOVERY_CREDIT_FREEZE_DAYS,
} from '@/lib/auth/recovery';
import {
  InvalidPhoneNumberError,
  maskPhilippineMobile,
  normalisePhilippineMobile,
} from '@/lib/auth/phone';
import {
  grantStoreAccessAsAdmin,
  revokeStoreAccessAsAdmin,
} from '@/lib/merchant/staff';
import {
  PaymentAlreadySettledError,
  PaymentNotExpectedError,
  confirmPayment,
  recordRefundToSource,
  refusePayment,
} from '@/lib/payments/manual';
import {
  PayoutExceedsBalanceError,
  positionOf,
  recordSettlementEntry,
  type PartyRef,
} from '@/lib/settlement/ledger';
import {
  InvalidCommissionError,
  InvalidSettlementEntryError,
  assertCommissionInRange,
  payableCentavos,
} from '@/lib/settlement/policy';
import {
  AlreadyAMemberError,
  InviteNotFoundError,
  LastOwnerError,
} from '@/lib/merchant/staff-policy';
import { uniqueStoreSlug } from '@/lib/admin/stores';
import {
  AlreadyInThatStateError,
  DecisionNeedsReasonError,
  NotAnApplicationError,
  UndecidableStatusError,
  decideVerification,
  setPartnerSuspended,
} from '@/lib/fleet/verification';
import {
  VERIFICATION_STATUS_LABEL,
  isDecision,
} from '@/lib/fleet/verification-policy';
import {
  isFiniteCoordinate,
  isInPhilippines,
  looksSwapped,
} from '@/lib/geo/philippines';

/**
 * Everything the console can change.
 *
 * Three rules hold for every action in this file, without exception.
 *
 *  1. `requireAdmin()` first. A server action is its own entry point — the
 *     layout's check does not cover it, and anybody who can post to the app
 *     can post to this.
 *  2. A reason, at least eight characters. Not decoration: it is the only part
 *     of the audit row that answers "was this legitimate", and the database
 *     refuses a row without one.
 *  3. The change and its audit entry commit together. Logging afterwards loses
 *     the record exactly when the process dies mid-action, which is the case
 *     somebody will later need to reconstruct.
 *
 * They return a result rather than throwing at the caller, because the caller
 * is a form and the person filling it in needs a sentence, not a stack.
 */

const DENIED: AdminActionResult = {
  ok: false,
  message: 'That is only available to an administrator.',
};

/**
 * Wraps an action so authorisation and reason failures become messages.
 *
 * Anything else is rethrown: an unexpected error must not be flattened into
 * "something went wrong" on a screen that changes money and access.
 */
async function guarded(
  run: () => Promise<AdminActionResult>,
): Promise<AdminActionResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    // Two administrators looking at the same payment queue is normal, and the
    // second one to tap Confirm should read a sentence rather than a stack
    // trace. Handled here so it also never lands on `/admin/errors`: a race
    // the code refused correctly is not a fault.
    if (
      error instanceof PaymentAlreadySettledError ||
      error instanceof PaymentNotExpectedError
    ) {
      return { ok: false, message: error.message };
    }
    // Settlement refusals are all sentences an operator can act on: a payout
    // bigger than the balance, a missing reference, a commission that is a
    // typo. None is a fault, so none should reach `/admin/errors` either.
    if (
      error instanceof PayoutExceedsBalanceError ||
      error instanceof InvalidSettlementEntryError ||
      error instanceof InvalidCommissionError
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

// --- The service registry ----------------------------------------------------

/**
 * Switches a vertical on or off for everyone.
 *
 * This is the switch the whole registry design exists for: launching Mart is a
 * row change, not a deploy. It also refuses to activate a service that is
 * available in no city, because a tappable tile that cannot take an order in
 * any city is a worse experience than a "coming soon" one.
 */
export async function setServiceActiveAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const key = String(formData.get('serviceKey') ?? '') as ServiceKey;
    const isActive = formData.get('isActive') === 'true';
    const reason = normaliseReason(formData.get('reason'));

    const service = await prisma.service.findUnique({ where: { key } });
    if (!service) return { ok: false, message: 'No such service.' };

    if (isActive && service.availableCityIds.length === 0) {
      return {
        ok: false,
        message: `${service.displayName} is available in no city yet. Launch it in a city first — a tile that cannot take an order anywhere is worse than "coming soon".`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { key },
        data: {
          isActive,
          // The two flags are the same decision seen from both sides, so they
          // move together. Leaving `isComingSoon` true on an active service
          // would render a live vertical dimmed and untappable.
          isComingSoon: !isActive,
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SERVICE_AVAILABILITY_CHANGED,
          subjectType: 'Service',
          subjectId: key,
          subjectLabel: service.displayName,
          reason,
          detail: {
            before: { isActive: service.isActive, isComingSoon: service.isComingSoon },
            after: { isActive, isComingSoon: !isActive },
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/services');
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message: `${service.displayName} is now ${isActive ? 'live' : 'off'}.`,
    };
  });
}

/** Launches a vertical in a city, or withdraws it. */
export async function setServiceCityAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const key = String(formData.get('serviceKey') ?? '') as ServiceKey;
    const cityId = String(formData.get('cityId') ?? '');
    const available = formData.get('available') === 'true';
    const reason = normaliseReason(formData.get('reason'));

    const [service, city] = await Promise.all([
      prisma.service.findUnique({ where: { key } }),
      prisma.city.findUnique({ where: { id: cityId } }),
    ]);
    if (!service || !city) return { ok: false, message: 'No such service or city.' };

    const before = service.availableCityIds;
    const after = available
      ? [...new Set([...before, cityId])]
      : before.filter((id) => id !== cityId);

    if (before.length === after.length && before.every((id) => after.includes(id))) {
      return { ok: false, message: 'Nothing to change.' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { key },
        // Withdrawing the last city also switches the service off: leaving it
        // active with nowhere to order is the state that produces a tile which
        // fails at checkout instead of at the tile.
        data: {
          availableCityIds: after,
          ...(after.length === 0 && service.isActive
            ? { isActive: false, isComingSoon: true }
            : {}),
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SERVICE_CITY_CHANGED,
          subjectType: 'Service',
          subjectId: key,
          subjectLabel: `${service.displayName} — ${city.name}`,
          reason,
          detail: { city: city.name, available, before, after },
        },
        tx,
      );
    });

    revalidatePath('/admin/services');
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message: available
        ? `${service.displayName} is now available in ${city.name}.`
        : `${service.displayName} withdrawn from ${city.name}.` +
          (after.length === 0 ? ' That was the last city, so the service is now off.' : ''),
    };
  });
}

// --- Errors ------------------------------------------------------------------

/**
 * Marks a fault fixed, or reopens one.
 *
 * "Fixed" is a claim by a person, not a fact the system can check — so it is
 * recorded with who and why, like every other privileged change. The row is
 * not deleted: a fault that comes back needs its history, and the next
 * occurrence reopens it automatically anyway (see `reportError`).
 */
export async function resolveErrorReportAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const id = String(formData.get('errorId') ?? '');
    const resolved = formData.get('resolved') !== 'false';
    const reason = normaliseReason(formData.get('reason'));

    const report = await prisma.errorReport.findUnique({
      where: { id },
      select: { id: true, kind: true, message: true, route: true, resolvedAt: true },
    });
    if (!report) return { ok: false, message: 'No such error report.' };

    await prisma.$transaction(async (tx) => {
      await tx.errorReport.update({
        where: { id },
        data: resolved
          ? { resolvedAt: new Date(), resolvedByUserId: admin.id }
          : { resolvedAt: null, resolvedByUserId: null },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.ERROR_REPORT_RESOLVED,
          subjectType: 'ErrorReport',
          subjectId: id,
          // The kind and route, not the message: an audit label is read in a
          // list and a stack line would make that list unreadable.
          subjectLabel: `${report.kind}${report.route ? ` at ${report.route}` : ''}`,
          reason,
          detail: { resolved, wasResolvedAt: report.resolvedAt },
        },
        tx,
      );
    });

    revalidatePath('/admin/errors');
    return {
      ok: true,
      message: resolved
        ? 'Marked fixed. It will reopen by itself if it happens again.'
        : 'Reopened.',
    };
  });
}

// --- People ------------------------------------------------------------------

/**
 * Blocks or unblocks an account.
 *
 * Blocking does not remove roles: an admin who is blocked stops being able to
 * use the console, which is the point — `getAdminUser` checks `isBlocked`
 * separately from the role for exactly this reason.
 */
export async function setUserBlockedAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const userId = String(formData.get('userId') ?? '');
    const blocked = formData.get('blocked') === 'true';
    const reason = normaliseReason(formData.get('reason'));

    if (userId === admin.id) {
      // Not a hypothetical: the block button sits on a page an admin can reach
      // for their own account, and locking yourself out is unrecoverable
      // without database access.
      return { ok: false, message: 'You cannot block your own account.' };
    }

    const subject = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, fullName: true, isBlocked: true },
    });
    if (!subject) return { ok: false, message: 'No such account.' };
    if (subject.isBlocked === blocked) {
      return { ok: false, message: 'That account is already in that state.' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { isBlocked: blocked } });
      // Blocking without ending the sessions leaves somebody signed in and
      // wondering why nothing works. Sessions are revocable server-side
      // precisely so this is possible.
      if (blocked) {
        await tx.session.deleteMany({ where: { userId } });
      }
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.USER_BLOCK_CHANGED,
          subjectType: 'User',
          subjectId: userId,
          subjectLabel: subject.fullName ?? subject.phone,
          reason,
          detail: { before: subject.isBlocked, after: blocked },
        },
        tx,
      );
    });

    revalidatePath(`/admin/users/${userId}`);
    return {
      ok: true,
      message: blocked
        ? 'Account blocked and signed out everywhere.'
        : 'Account unblocked.',
    };
  });
}

// --- Credits -----------------------------------------------------------------

/**
 * A signed correction to somebody's credits.
 *
 * Goes through `recordAdjustment`, which is the same one function every balance
 * change goes through — it writes a `WalletTransaction` and recalculates the
 * balance from the ledger. Nothing here touches a balance field, and there is
 * no path in this file that could: the ledger table refuses UPDATE and DELETE
 * at the database level, and an ADJUSTMENT without an admin fails a CHECK.
 *
 * This is a correction, not a top-up. It exists so a support agent can undo a
 * mistake the system made — a refund that did not fire, a promo credited
 * twice — and `MAX_ADJUSTMENT_CENTAVOS` is what keeps it that.
 */
export async function adjustCreditsAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const userId = String(formData.get('userId') ?? '');
    const reason = normaliseReason(formData.get('reason'));
    const pesos = Number(formData.get('pesos'));

    if (!Number.isFinite(pesos) || pesos === 0) {
      return { ok: false, message: 'Enter an amount in pesos. Negative takes credits away.' };
    }
    // Money is integer centavos everywhere. Rounding at the boundary rather
    // than storing a float is the whole convention.
    const amountCentavos = Math.round(pesos * 100);

    if (Math.abs(amountCentavos) > MAX_ADJUSTMENT_CENTAVOS) {
      return {
        ok: false,
        message:
          `A single adjustment is capped at ${formatCentavos(MAX_ADJUSTMENT_CENTAVOS)}. ` +
          'This is for correcting a mistake, not for issuing credit at scale — ' +
          'a promotion belongs in a campaign with its own approval, not in one ' +
          'form field.',
      };
    }

    const subject = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, fullName: true },
    });
    if (!subject) return { ok: false, message: 'No such account.' };

    let balanceAfter = 0;
    await prisma.$transaction(async (tx) => {
      const result = await recordAdjustment(
        {
          userId,
          adminUserId: admin.id,
          amountCentavos,
          // The reason is carried into the ledger row as well as the audit
          // row, because a customer asking "what is this line" is asking the
          // ledger, and it should be able to answer without a join.
          description: `Adjustment by ${admin.fullName ?? admin.phone}: ${reason}`,
        },
        tx,
      );
      balanceAfter = result.balanceCentavos;

      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.CREDITS_ADJUSTED,
          subjectType: 'User',
          subjectId: userId,
          subjectLabel: subject.fullName ?? subject.phone,
          reason,
          detail: {
            amountCentavos,
            balanceAfterCentavos: result.balanceCentavos,
            transactionId: result.transaction.id,
          },
        },
        tx,
      );
    });

    revalidatePath(`/admin/users/${userId}`);
    return {
      ok: true,
      message:
        `${amountCentavos > 0 ? 'Credited' : 'Debited'} ${formatCentavos(Math.abs(amountCentavos))}. ` +
        `Balance is now ${formatCentavos(balanceAfter)}.`,
    };
  });
}

// --- Notification deliveries -------------------------------------------------

/**
 * Puts a failed delivery back in the queue.
 *
 * For the case the retry policy is not built for: three attempts failed
 * because a gateway was down, somebody fixed the gateway, and the message is
 * still worth sending. Resets the attempt count so the backoff starts over.
 */
export async function requeueDeliveryAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const deliveryId = String(formData.get('deliveryId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const delivery = await prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        channel: true,
        status: true,
        attempts: true,
        lastError: true,
        notification: { select: { title: true, user: { select: { phone: true } } } },
      },
    });
    if (!delivery) return { ok: false, message: 'No such delivery.' };
    if (delivery.status !== NotificationDeliveryStatus.FAILED) {
      return {
        ok: false,
        message: `That delivery is ${delivery.status}, not FAILED. Only a failed one can be requeued.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: NotificationDeliveryStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(),
          // The old error is cleared, because the row is no longer failed and
          // a CHECK constraint insists a FAILED row is the only kind that
          // carries one.
          lastError: null,
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.DELIVERY_REQUEUED,
          subjectType: 'NotificationDelivery',
          subjectId: deliveryId,
          subjectLabel: `${delivery.channel} — ${delivery.notification.title}`,
          reason,
          detail: { previousAttempts: delivery.attempts, previousError: delivery.lastError },
        },
        tx,
      );
    });

    revalidatePath('/admin/health');
    return { ok: true, message: 'Queued. The next maintenance run will attempt it.' };
  });
}

// --- Subscriptions -----------------------------------------------------------

/** Ends a live subscription now, with the reason kept. */
export async function endSubscriptionAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const userId = String(formData.get('userId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const subscription = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      },
      include: {
        plan: { select: { name: true } },
        user: { select: { phone: true, fullName: true } },
      },
    });
    if (!subscription) return { ok: false, message: 'That account has no live subscription.' };

    // Cancellation goes through the enrollment layer rather than an update
    // here, so the one-live-subscription invariant and the end-date rules stay
    // in one place.
    await cancelSubscription({ userId });
    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SUBSCRIPTION_CHANGED,
      subjectType: 'UserSubscription',
      subjectId: subscription.id,
      subjectLabel: `${subscription.plan.name} — ${subscription.user.fullName ?? subscription.user.phone}`,
      reason,
      detail: { origin: subscription.origin, previousStatus: subscription.status },
    });

    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: `${subscription.plan.name} ended.` };
  });
}

// --- Account recovery --------------------------------------------------------

/**
 * Moves an account to a new phone number, by hand.
 *
 * The fallback for the majority who never added an email — and the single most
 * dangerous thing in this console, because the person asking is by definition
 * somebody who cannot prove they hold the number on the account.
 *
 * What makes it safe enough to offer is that it is not treated as more trusted
 * than the self-service route. It goes through the same `movePhoneNumber`, so
 * it gets the same three-day credit freeze, the same alert to the old number,
 * and the same session revocation. An administrator cannot skip any of them,
 * and the confirmation says so — because the temptation, when a real customer
 * is on the phone insisting, is to want a version without the freeze.
 *
 * The reason field is where the actual verification lives. "Confirmed order
 * DA-20260907-JBFP2 and last four of card" is a reason. "Customer asked" is
 * the shape of a social-engineering success, and it will be in the log.
 */
export async function moveAccountPhoneAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const userId = String(formData.get('userId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    let newPhone: string;
    try {
      newPhone = normalisePhilippineMobile(String(formData.get('newPhone') ?? ''));
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }

    const subject = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, fullName: true },
    });
    if (!subject) return { ok: false, message: 'No such account.' };

    if (subject.id === admin.id) {
      // Not paranoia: an admin moving their own number through the console
      // would revoke their own session mid-request and freeze their own
      // credits, and there is a normal settings path for it.
      return {
        ok: false,
        message: 'Use your own profile to change your own number.',
      };
    }

    try {
      await prisma.$transaction(async (tx) => {
        const recovery = await movePhoneNumber(
          {
            userId,
            newPhone,
            method: RecoveryMethod.SUPPORT_ASSISTED,
            assistedByUserId: admin.id,
            reason,
            now: new Date(),
          },
          tx,
        );

        await recordAdminAction(
          {
            actorId: admin.id,
            action: AdminAction.ACCOUNT_RECOVERED,
            subjectType: 'User',
            subjectId: userId,
            subjectLabel: subject.fullName ?? subject.phone,
            reason,
            detail: {
              // The old number is in the recovery row too; repeated here so the
              // audit log reads without a join.
              previousPhone: subject.phone,
              newPhone,
              recoveryId: recovery.id,
              creditsFrozenUntil: recovery.creditsFrozenUntil.toISOString(),
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof PhoneAlreadyInUseError || error instanceof SamePhoneError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }

    revalidatePath(`/admin/users/${userId}`);
    return {
      ok: true,
      message:
        `Moved to ${maskPhilippineMobile(newPhone)}. Every session is revoked, ` +
        `credits are frozen for ${RECOVERY_CREDIT_FREEZE_DAYS} days, and the ` +
        'previous number is texted on the next maintenance run.',
    };
  });
}

// --- Partner stores ----------------------------------------------------------

/**
 * Creating a store, and naming who runs it.
 *
 * These DO carry a reason and an audit row, unlike the support controls,
 * because they move access: `grantStoreAccess` hands somebody the power to
 * change prices and accept orders in a real business, and `createStore` hands
 * out the first one. That is squarely the kind of thing the audit log exists
 * for.
 *
 * Why the console can do this at all: a brand-new partner shop has nobody at
 * it who could invite the first owner. Everything after that first owner —
 * the rest of the staff, the menu, the prep time — belongs to the shop itself.
 */
export async function createStoreAction(
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const name = String(formData.get('name') ?? '').trim();
  const cityId = String(formData.get('cityId') ?? '').trim();
  const addressLine = String(formData.get('addressLine') ?? '').trim();
  const ownerPhone = String(formData.get('ownerPhone') ?? '').trim();
  const latitude = Number(formData.get('latitude'));
  const longitude = Number(formData.get('longitude'));
  const serviceKeys = formData
    .getAll('serviceKeys')
    .map((value) => String(value))
    .filter((value): value is ServiceKey => value in ServiceKey);

  if (name.length < 2) return { ok: false, message: 'The shop needs a name.' };
  if (addressLine.length < 4) return { ok: false, message: 'The shop needs an address.' };
  if (serviceKeys.length === 0) {
    return { ok: false, message: 'Pick at least one service this shop is for.' };
  }
  // Checked rather than trusted: an empty number field arrives as NaN, and a
  // store at 0,0 is in the Atlantic — every delivery fee from it would be
  // computed from the Gulf of Guinea.
  //
  // The bounds come from the same module the map picker uses. They were
  // written out here in full once, which is exactly the pair that drifts: a
  // picker that lets somebody drop a pin the server then rejects is worse
  // than no picker.
  if (!isFiniteCoordinate(latitude) || !isFiniteCoordinate(longitude)) {
    return { ok: false, message: 'The shop needs coordinates.' };
  }
  if (!isInPhilippines({ latitude, longitude })) {
    return {
      ok: false,
      message: looksSwapped({ latitude, longitude })
        ? 'Those look like the right numbers the wrong way round — latitude ' +
          'first, then longitude.'
        : 'Those coordinates are not in the Philippines.',
    };
  }

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const city = await prisma.city.findUnique({ where: { id: cityId } });
  if (!city) return { ok: false, message: 'Pick a city.' };

  const slug = await uniqueStoreSlug(name);

  try {
    const store = await prisma.$transaction(async (tx) => {
      const created = await tx.store.create({
        data: {
          name,
          slug,
          cityId,
          addressLine,
          latitude,
          longitude,
          serviceKeys,
          // NOT visible. A shop with no menu is worse than a shop that is not
          // there: a customer finds it, opens it, and sees nothing. The console
          // makes it visible once the owner has entered a menu.
          isVisible: false,
        },
      });

      const outcome = await grantStoreAccessAsAdmin(
        {
          storeId: created.id,
          adminId: admin.id,
          rawPhone: ownerPhone,
          role: StoreRole.OWNER,
        },
        tx,
      );

      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.STORE_MEMBERSHIP_CHANGED,
          subjectType: 'Store',
          subjectId: created.id,
          subjectLabel: created.name,
          reason,
          detail: {
            created: true,
            slug: created.slug,
            cityId,
            serviceKeys,
            ownerPhone: maskPhilippineMobile(outcome.phone),
            ownerHadAccount: outcome.kind === 'ADDED',
          },
        },
        tx,
      );

      return { created, outcome };
    });

    revalidatePath('/admin/stores');
    return {
      ok: true,
      message:
        store.outcome.kind === 'ADDED'
          ? `${store.created.name} created. The owner can open it now. It is hidden from customers until it has a menu.`
          : `${store.created.name} created. The owner has no TARA account yet — they get access the first time they sign in with that number.`,
    };
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, message: "Check the owner's mobile number." };
    }
    throw error;
  }
}

export async function setStoreVisibilityAction(
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const storeId = String(formData.get('storeId') ?? '').trim();
  const visible = String(formData.get('visible') ?? '') === '1';

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, _count: { select: { menuItems: true } } },
  });
  if (!store) return { ok: false, message: 'No such store.' };

  if (visible && store._count.menuItems === 0) {
    return {
      ok: false,
      message:
        'That shop has no menu yet. A customer would find it, open it and see ' +
        'nothing — have the owner add items first.',
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.store.update({ where: { id: store.id }, data: { isVisible: visible } });
    await recordAdminAction(
      {
        actorId: admin.id,
        action: AdminAction.STORE_MEMBERSHIP_CHANGED,
        subjectType: 'Store',
        subjectId: store.id,
        subjectLabel: store.name,
        reason,
        detail: { isVisible: visible },
      },
      tx,
    );
  });

  revalidatePath('/admin/stores');
  revalidatePath(`/admin/stores/${store.id}`);
  return {
    ok: true,
    message: visible
      ? `${store.name} is now visible to customers.`
      : `${store.name} is hidden from customers.`,
  };
}

export async function grantStoreAccessAction(
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const storeId = String(formData.get('storeId') ?? '').trim();
  const rawPhone = String(formData.get('phone') ?? '').trim();
  const role = String(formData.get('role') ?? '') as StoreRole;
  if (!(role in StoreRole)) return { ok: false, message: 'Pick a role.' };

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true },
  });
  if (!store) return { ok: false, message: 'No such store.' };

  try {
    const outcome = await grantStoreAccessAsAdmin({
      storeId: store.id,
      adminId: admin.id,
      rawPhone,
      role,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.STORE_MEMBERSHIP_CHANGED,
      subjectType: 'Store',
      subjectId: store.id,
      subjectLabel: store.name,
      reason,
      detail: {
        granted: role,
        phone: maskPhilippineMobile(outcome.phone),
        hadAccount: outcome.kind === 'ADDED',
      },
    });

    revalidatePath(`/admin/stores/${store.id}`);
    return {
      ok: true,
      message:
        outcome.kind === 'ADDED'
          ? `Added to ${store.name}.`
          : `No TARA account on that number yet — the invitation waits for their first sign-in.`,
    };
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, message: 'Check that mobile number.' };
    }
    if (error instanceof AlreadyAMemberError || error instanceof LastOwnerError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

export async function revokeStoreAccessAction(
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const storeId = String(formData.get('storeId') ?? '').trim();
  const memberId = String(formData.get('memberId') ?? '').trim();

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true },
  });
  if (!store) return { ok: false, message: 'No such store.' };

  try {
    const outcome = await revokeStoreAccessAsAdmin({ storeId: store.id, memberId });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.STORE_MEMBERSHIP_CHANGED,
      subjectType: 'Store',
      subjectId: store.id,
      subjectLabel: store.name,
      reason,
      detail: { revoked: outcome.role, userId: outcome.userId },
    });

    revalidatePath(`/admin/stores/${store.id}`);
    return { ok: true, message: `Removed from ${store.name}. They have been told.` };
  } catch (error) {
    if (error instanceof LastOwnerError || error instanceof InviteNotFoundError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

// --- The fleet ---------------------------------------------------------------

/**
 * A decision on one fleet application.
 *
 * This is the action that ended the last SSH-only job in the application.
 * `npm run fleet:approve` still works and still says the same things, but it
 * cannot record who decided, cannot tell the rider, and needs somebody with a
 * shell and the production database — for a job that is done daily, from a
 * phone, while looking at a photograph of a licence.
 *
 * One service per submission, deliberately: the form posts a single
 * `serviceType`, so nothing here can clear somebody for two verticals at once.
 * The reason is required by the audit trail like everywhere else in this file,
 * and on a refusal it is ALSO what the applicant is shown on their own screen —
 * one field rather than two, because an administrator writing "see notes" in
 * the box the rider reads is how a refusal becomes a dead end.
 */
export async function decideFleetApplicationAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const partnerId = String(formData.get('partnerId') ?? '').trim();
    const serviceType = String(formData.get('serviceType') ?? '').trim();
    const decision = String(formData.get('decision') ?? '').trim();
    const reason = normaliseReason(formData.get('reason'));

    if (!isDecision(decision)) {
      return { ok: false, message: 'Approve, refuse or suspend — nothing else.' };
    }
    if (!(serviceType in ServiceKey)) {
      return { ok: false, message: 'That is not a service.' };
    }

    const partner = await prisma.fleetPartner.findUnique({
      where: { id: partnerId },
      select: { id: true, user: { select: { fullName: true, phone: true } } },
    });
    if (!partner) return { ok: false, message: 'No such fleet partner.' };

    try {
      const outcome = await decideVerification({
        fleetPartnerId: partner.id,
        serviceType: serviceType as ServiceKey,
        status: decision,
        reason,
        decidedByUserId: admin.id,
      });

      await recordAdminAction({
        actorId: admin.id,
        action: AdminAction.FLEET_VERIFICATION_CHANGED,
        subjectType: 'FleetPartner',
        subjectId: partner.id,
        subjectLabel: partner.user.fullName ?? partner.user.phone,
        reason,
        detail: {
          serviceType,
          decision,
          enabledServices: outcome.enabledServices,
        },
      });

      revalidatePath('/admin/fleet');
      revalidatePath(`/admin/fleet/${partner.id}`);
      return {
        ok: true,
        message:
          decision === VerificationStatus.APPROVED
            ? `Approved for ${outcome.serviceName}. They have been told, and offers can reach them.`
            : `${outcome.serviceName} set to ${VERIFICATION_STATUS_LABEL[decision].toLowerCase()}. They have been told, with the reason.`,
      };
    } catch (error) {
      if (
        error instanceof NotAnApplicationError ||
        error instanceof UndecidableStatusError ||
        error instanceof AlreadyInThatStateError ||
        error instanceof DecisionNeedsReasonError
      ) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  });
}

/**
 * Stops a partner working, or lets them start again.
 *
 * Not a judgement about documents — "not today, whatever the documents say" —
 * so it leaves every per-service approval intact and reinstating somebody is
 * one click rather than three decisions taken again. The audit row is what
 * makes that reversible without argument.
 */
export async function setFleetSuspensionAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const partnerId = String(formData.get('partnerId') ?? '').trim();
    const suspended = formData.get('suspended') === 'true';
    const reason = normaliseReason(formData.get('reason'));

    const partner = await prisma.fleetPartner.findUnique({
      where: { id: partnerId },
      select: {
        id: true,
        isSuspended: true,
        user: { select: { fullName: true, phone: true } },
      },
    });
    if (!partner) return { ok: false, message: 'No such fleet partner.' };
    if (partner.isSuspended === suspended) {
      return { ok: false, message: 'That partner is already in that state.' };
    }

    await prisma.$transaction(async (tx) => {
      await setPartnerSuspended({
        fleetPartnerId: partner.id,
        isSuspended: suspended,
        client: tx,
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.FLEET_SUSPENSION_CHANGED,
          subjectType: 'FleetPartner',
          subjectId: partner.id,
          subjectLabel: partner.user.fullName ?? partner.user.phone,
          reason,
          detail: { before: partner.isSuspended, after: suspended },
        },
        tx,
      );
    });

    revalidatePath('/admin/fleet');
    revalidatePath(`/admin/fleet/${partner.id}`);
    return {
      ok: true,
      message: suspended
        ? 'Suspended from all work, and taken offline.'
        : 'Reinstated. Their existing approvals are unchanged.',
    };
  });
}

/**
 * Somebody checked the account and the money is there.
 *
 * The most consequential button in the console: it releases an order to a
 * kitchen on one person's word that a payment arrived. Hence the reason and
 * the audit row — not as ceremony, but because a chargeback or a dispute
 * months later is answered by "who confirmed this, when, and what did they say
 * they were looking at".
 *
 * The amount is optional and defaults to the order total. It is settable
 * because the thing that actually goes wrong on this rail is somebody sending
 * ₱300 for a ₱324 order, and recording what really arrived — rather than what
 * was owed — is what keeps the ledger worth reading. A short payment leaves the
 * order waiting and tells the customer what is missing.
 *
 * The payment method is read off the order inside `confirmPayment` and
 * deliberately not named here: an invariant test forbids the words for a
 * credits top-up rail anywhere in this file's code, one of which collides with
 * the name of a payment instrument. Keeping the instrument out of this file
 * costs nothing and keeps that rule at full strength.
 */
export async function confirmPaymentAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const orderId = String(formData.get('orderId') ?? '');
    const reason = normaliseReason(formData.get('reason'));
    const rawAmount = String(formData.get('amount') ?? '').trim();

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, totalCentavos: true },
    });
    if (!order) return { ok: false, message: 'No such order.' };

    let amountCentavos = order.totalCentavos;
    if (rawAmount) {
      const parsed = centavosFromPesoInput(rawAmount);
      if (parsed === null) {
        return { ok: false, message: 'Write the amount in pesos, like 324 or 324.50.' };
      }
      amountCentavos = parsed;
    }

    const { paymentStatus, released } = await confirmPayment({
      orderId: order.id,
      adminUserId: admin.id,
      amountCentavos,
      note: reason,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.PAYMENT_CONFIRMED,
      subjectType: 'Order',
      subjectId: order.id,
      subjectLabel: order.orderNumber,
      reason,
      detail: { amountCentavos, owed: order.totalCentavos, paymentStatus, released },
    });

    revalidatePath('/admin/payments');
    revalidatePath(`/admin/orders/${order.orderNumber}`);
    return {
      ok: true,
      message: released
        ? `Confirmed ${formatCentavos(amountCentavos)}. The order is on its way to the store.`
        : `Recorded ${formatCentavos(amountCentavos)}, which is short of ${formatCentavos(
            order.totalCentavos,
          )}. The order is still waiting and the customer has been told.`,
    };
  });
}

/**
 * The reference did not check out.
 *
 * Does not cancel the order, on purpose. A mistyped digit is the likeliest
 * explanation and the money may well be sitting in the account — so the
 * customer keeps their slot until the payment window runs out on its own, and
 * gets told why so they can send a corrected reference. Cancelling on the
 * first bad reference would strand real payments.
 *
 * The reason is shown to the CUSTOMER verbatim, which makes this the one audit
 * reason in this file that somebody outside the company reads. Worth knowing
 * before writing "nonsense" in it.
 */
export async function refusePaymentAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const orderId = String(formData.get('orderId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true },
    });
    if (!order) return { ok: false, message: 'No such order.' };

    await refusePayment({ orderId: order.id, adminUserId: admin.id, note: reason });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.PAYMENT_REFUSED,
      subjectType: 'Order',
      subjectId: order.id,
      subjectLabel: order.orderNumber,
      reason,
    });

    revalidatePath('/admin/payments');
    revalidatePath(`/admin/orders/${order.orderNumber}`);
    return {
      ok: true,
      message: 'Refused, and the customer has been told why. Their order still has time to pay.',
    };
  });
}

/**
 * Records that the money has been sent back.
 *
 * Records, not performs. Nothing in this codebase can push money into
 * somebody's wallet, so this is a person saying "I have done it" with their
 * name against it. That is exactly why it takes a reason and writes an audit
 * row: it is a claim about the world, not a state change in a database.
 *
 * It cannot route money into credits. That refusal lives in the payment
 * module and again in the database, because returning real money as spendable
 * balance would be a top-up path, and this product does not have one.
 */
export async function recordRefundSentAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const orderId = String(formData.get('orderId') ?? '');
    const reason = normaliseReason(formData.get('reason'));
    const rawAmount = String(formData.get('amount') ?? '').trim();

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true },
    });
    if (!order) return { ok: false, message: 'No such order.' };

    const amountCentavos = centavosFromPesoInput(rawAmount);
    if (amountCentavos === null || amountCentavos <= 0) {
      return { ok: false, message: 'Write what you sent, in pesos, like 324 or 324.50.' };
    }

    await recordRefundToSource({
      orderId: order.id,
      adminUserId: admin.id,
      amountCentavos,
      note: reason,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.PAYMENT_REFUNDED,
      subjectType: 'Order',
      subjectId: order.id,
      subjectLabel: order.orderNumber,
      reason,
      detail: { amountCentavos },
    });

    revalidatePath('/admin/payments');
    revalidatePath(`/admin/orders/${order.orderNumber}`);
    return {
      ok: true,
      message: `Recorded ${formatCentavos(amountCentavos)} sent back. The customer has been told.`,
    };
  });
}

// --- Settlement --------------------------------------------------------------

/**
 * Reads a party from a form.
 *
 * The console posts `party` and `partyId` rather than two optional id fields,
 * so a form cannot describe a row that belongs to a store and a rider at once
 * — which the database would refuse anyway, less helpfully.
 */
function partyFromForm(formData: FormData): PartyRef | null {
  const party = String(formData.get('party') ?? '');
  const partyId = String(formData.get('partyId') ?? '');
  if (!partyId) return null;
  if (party === 'STORE') return { party: 'STORE', storeId: partyId };
  if (party === 'FLEET_PARTNER') {
    return { party: 'FLEET_PARTNER', fleetPartnerId: partyId };
  }
  return null;
}

/** The partner's name, for the audit row and the confirmation sentence. */
async function partyLabel(ref: PartyRef): Promise<string> {
  if (ref.party === 'STORE') {
    const store = await prisma.store.findUnique({
      where: { id: ref.storeId },
      select: { name: true },
    });
    return store?.name ?? ref.storeId;
  }
  const partner = await prisma.fleetPartner.findUnique({
    where: { id: ref.fleetPartnerId },
    select: { user: { select: { fullName: true, displayName: true, phone: true } } },
  });
  return (
    partner?.user.displayName ?? partner?.user.fullName ?? partner?.user.phone ?? ref.fleetPartnerId
  );
}

/**
 * Records a payout to a store or a rider.
 *
 * Records, not sends. Nothing in this codebase can move money into somebody's
 * bank account, so this is a person saying "I have paid them" with their name,
 * a reference and a reason against it. That is the same honesty the customer
 * refund control takes, and for the same reason: a button that looked like it
 * paid somebody would be the most dangerous thing in the console.
 *
 * It cannot exceed the balance. Paying past what is owed is an unrecorded loan
 * that the next accrual silently swallows, and on a rider who is holding our
 * cash it would be handing money to somebody already in debt to us.
 */
export async function recordPayoutAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const ref = partyFromForm(formData);
    if (!ref) return { ok: false, message: 'No such partner.' };

    const amountCentavos = centavosFromPesoInput(
      String(formData.get('amount') ?? '').trim(),
    );
    if (amountCentavos === null || amountCentavos <= 0) {
      return { ok: false, message: 'Write what you sent, in pesos, like 1200 or 1200.50.' };
    }

    const reference = String(formData.get('reference') ?? '').trim();
    if (reference.length < 3) {
      return {
        ok: false,
        message: 'Give the transfer reference — it is what makes this checkable later.',
      };
    }

    const label = await partyLabel(ref);
    const before = await positionOf(ref);

    await recordSettlementEntry({
      ref,
      type: 'PAYOUT_SENT',
      amountCentavos,
      description: `Payout · ${reference}`,
      reference,
      actorUserId: admin.id,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SETTLEMENT_PAYOUT_RECORDED,
      subjectType: ref.party === 'STORE' ? 'Store' : 'FleetPartner',
      subjectId: ref.party === 'STORE' ? ref.storeId : ref.fleetPartnerId,
      subjectLabel: label,
      reason,
      detail: {
        amountCentavos,
        reference,
        balanceBeforeCentavos: before.balanceCentavos,
        payableBeforeCentavos: payableCentavos(before),
      },
    });

    revalidatePath('/admin/settlement');
    return {
      ok: true,
      message: `Recorded ${formatCentavos(amountCentavos)} paid to ${label}.`,
    };
  });
}

/**
 * Records cash a rider handed in.
 *
 * The other direction, and the one that actually closes the loop on a cash
 * order: the rider collected ₱399 at the door, earned ₱39 of it, and hands
 * back ₱360. Their balance returns to zero and the money is ours again.
 */
export async function recordRemittanceAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const ref = partyFromForm(formData);
    if (!ref) return { ok: false, message: 'No such partner.' };

    const amountCentavos = centavosFromPesoInput(
      String(formData.get('amount') ?? '').trim(),
    );
    if (amountCentavos === null || amountCentavos <= 0) {
      return { ok: false, message: 'Write what you received, in pesos, like 360 or 360.50.' };
    }

    const reference = String(formData.get('reference') ?? '').trim();
    if (reference.length < 3) {
      return {
        ok: false,
        message: 'Give a receipt number or say who took it in — this is a cash handover.',
      };
    }

    const label = await partyLabel(ref);

    await recordSettlementEntry({
      ref,
      type: 'CASH_REMITTED',
      amountCentavos,
      description: `Cash handed in · ${reference}`,
      reference,
      actorUserId: admin.id,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SETTLEMENT_REMITTANCE_RECORDED,
      subjectType: ref.party === 'STORE' ? 'Store' : 'FleetPartner',
      subjectId: ref.party === 'STORE' ? ref.storeId : ref.fleetPartnerId,
      subjectLabel: label,
      reason,
      detail: { amountCentavos, reference },
    });

    revalidatePath('/admin/settlement');
    return {
      ok: true,
      message: `Recorded ${formatCentavos(amountCentavos)} handed in by ${label}.`,
    };
  });
}

/**
 * A signed correction to what a partner is owed.
 *
 * Exists because the real world produces cases no rule anticipated: a rider
 * who paid a shop directly to keep an order moving, a damaged order somebody
 * absorbed, a fee waived after an argument. The alternative to an audited
 * adjustment is somebody editing the ledger, which the database refuses, or a
 * balance nobody can reconcile — so this is the pressure valve, and it is
 * built to leave a mark.
 */
export async function adjustSettlementAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const ref = partyFromForm(formData);
    if (!ref) return { ok: false, message: 'No such partner.' };

    const raw = String(formData.get('amount') ?? '').trim();
    const negative = raw.startsWith('-');
    const magnitude = centavosFromPesoInput(negative ? raw.slice(1) : raw);
    if (magnitude === null || magnitude <= 0) {
      return {
        ok: false,
        message:
          'Write the correction in pesos, like 150 to credit them or -150 to charge them.',
      };
    }
    const amountCentavos = negative ? -magnitude : magnitude;

    const reference = String(formData.get('reference') ?? '').trim();
    if (reference.length < 3) {
      return { ok: false, message: 'Give a reference: a ticket number, or what this settles.' };
    }

    const label = await partyLabel(ref);

    await recordSettlementEntry({
      ref,
      type: 'ADJUSTMENT',
      amountCentavos,
      description: `Adjustment · ${reference}`,
      reference,
      actorUserId: admin.id,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SETTLEMENT_ADJUSTED,
      subjectType: ref.party === 'STORE' ? 'Store' : 'FleetPartner',
      subjectId: ref.party === 'STORE' ? ref.storeId : ref.fleetPartnerId,
      subjectLabel: label,
      reason,
      detail: { amountCentavos, reference },
    });

    revalidatePath('/admin/settlement');
    return {
      ok: true,
      message:
        amountCentavos > 0
          ? `Credited ${label} ${formatCentavos(amountCentavos)}.`
          : `Charged ${label} ${formatCentavos(-amountCentavos)}.`,
    };
  });
}

/**
 * Sets a shop's commission rate.
 *
 * In basis points, because a percentage typed as a decimal is how somebody
 * sets 250% instead of 2.5%. Applies to FUTURE orders only: settled ones keep
 * what they settled at, which is what makes a rate change safe to make on a
 * Tuesday afternoon.
 */
export async function setStoreCommissionAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const storeId = String(formData.get('storeId') ?? '');

    const basisPoints = Number(String(formData.get('basisPoints') ?? '').trim());
    if (!Number.isFinite(basisPoints)) {
      return { ok: false, message: 'Write the rate in basis points, like 250 for 2.5%.' };
    }
    assertCommissionInRange(basisPoints);

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, commissionBasisPoints: true },
    });
    if (!store) return { ok: false, message: 'No such store.' };

    await prisma.$transaction(async (tx) => {
      await tx.store.update({
        where: { id: store.id },
        data: { commissionBasisPoints: basisPoints },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.STORE_COMMISSION_CHANGED,
          subjectType: 'Store',
          subjectId: store.id,
          subjectLabel: store.name,
          reason,
          detail: { before: store.commissionBasisPoints, after: basisPoints },
        },
        tx,
      );
    });

    revalidatePath('/admin/settlement');
    return {
      ok: true,
      message: `${store.name} now pays ${(basisPoints / 100).toFixed(2)}% on food. Existing orders keep what they settled at.`,
    };
  });
}
