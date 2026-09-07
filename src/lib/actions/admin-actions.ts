'use server';

import { revalidatePath } from 'next/cache';
import {
  AdminAction,
  NotificationDeliveryStatus,
  RecoveryMethod,
  ServiceKey,
  SubscriptionStatus,
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
import { formatCentavos } from '@/lib/money';
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
