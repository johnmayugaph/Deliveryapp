'use server';

import { revalidatePath } from 'next/cache';
import {
  AdminAction,
  NotificationDeliveryStatus,
  RecoveryMethod,
  PromoKind,
  ServiceKey,
  SubscriptionStatus,
  StoreRole,
  TierBenefitType,
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
import {
  SURGE_CEILING_CENTAVOS,
  firstDescendingStep,
  ladderFor,
} from '@/lib/pricing/surge-policy';
import {
  CITY_ERROR_MESSAGES,
  FEE_RULE_ERROR_MESSAGES,
  readCityEntry,
  readFeeRule,
} from '@/lib/admin/service-areas';
import { MAX_REWARD_CENTAVOS, farmerMargin } from '@/lib/referrals/policy';
import {
  MAX_DISCOUNT_CENTAVOS,
  codeLooksPlausible,
  exposureFor,
  giveawayFor,
  normalisePromoCode,
} from '@/lib/promo/policy';
import { MAX_GIFT_CARD_CENTAVOS } from '@/lib/gift-cards/policy';
import {
  GiftCardAmountError,
  GiftCardNotVoidableError,
  issueGiftCard,
  voidGiftCard,
} from '@/lib/gift-cards/issue';
import { PROGRAMME_ID } from '@/lib/referrals/programme';
import { PARTNER_PROGRAMME_ID } from '@/lib/referrals/partner-programme';
import {
  MAX_PARTNER_REWARD_CENTAVOS,
  acquisitionCost,
} from '@/lib/referrals/partner-policy';
import {
  MAX_TIER_PERCENT_BASIS_POINTS,
  MAX_TIER_PRIORITY_WEIGHT,
  TIER_BENEFIT_NAME,
  isBillBenefit,
} from '@/lib/loyalty/tier-benefits';
import { STORE_PROGRAMME_ID } from '@/lib/referrals/store-programme';
import { attributeStoreReferral } from '@/lib/referrals/store-attribution';
import {
  MAX_STORE_REWARD_CENTAVOS,
  storeAcquisitionCost,
} from '@/lib/referrals/store-policy';
import {
  MAX_POINTS_PER_PESO_BASIS_POINTS,
  effectiveGivebackBasisPoints,
} from '@/lib/loyalty/policy';
import { PROGRAMME_ID as LOYALTY_PROGRAMME_ID } from '@/lib/loyalty/programme';
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
  InvoiceNotCollectableError,
  InvoiceNotFoundError,
  refuseInvoiceClaim,
  settleInvoice,
  voidInvoice,
} from '@/lib/subscriptions/billing';
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
import { parseMinuteOfDay } from '@/lib/merchant/opening-hours';
import { addMenuItem } from '@/lib/merchant/menu';
import {
  DEFAULT_CATEGORY,
  DuplicateItemNameError,
  ItemNameRequiredError,
  MenuFullError,
  parsePrice,
  PriceNotUnderstoodError,
  PriceOutOfRangeError,
} from '@/lib/merchant/menu-policy';
import {
  changedStoreFields,
  ImageUrlNotUnderstoodError,
  ImageUrlTooLongError,
  parseImageUrl,
  uniqueStoreSlug,
  type StoreFieldValue,
} from '@/lib/admin/stores';
import {
  ImageTooLargeError,
  ImageWrongShapeError,
  MAX_IMAGE_BYTES,
  NotAnImageError,
} from '@/lib/media/image-bytes';
import {
  parseStoreImageKind,
  pruneOrphanStoreImages,
  putStoreImage,
  removeStoreImage,
  StoreImageKindUnknownError,
  StoreNotFoundError,
  STORE_IMAGE_LABEL,
} from '@/lib/media/store-images';
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
    // "That card has already been redeemed, so correct the balance instead" is
    // a sentence, not a fault. Two administrators looking at the same list is
    // normal, and so is somebody redeeming a card while one of them cancels it.
    if (
      error instanceof GiftCardNotVoidableError ||
      error instanceof GiftCardAmountError
    ) {
      return { ok: false, message: error.message };
    }
    // A bill somebody else confirmed, cancelled, or paid a second ago. Two
    // administrators working the same invoice queue is normal, and every one
    // of these refusals is a sentence rather than a fault — so none should
    // land on `/admin/errors` either.
    if (
      error instanceof InvoiceNotCollectableError ||
      error instanceof InvoiceNotFoundError
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

/**
 * Active or inactive — whether customers can find this shop.
 *
 * A SWITCH, not a form. It replaced a panel with a reason box and a red
 * button, which was three interactions for a two-state fact and read like a
 * dangerous operation rather than the everyday one it is.
 *
 * THE REASON IS WRITTEN BY THE SYSTEM HERE, and this is the only console
 * action where that is true. A switch cannot stop to ask why, and the choice
 * was between a switch with an automatic reason and a form with a typed one.
 * What is kept is the part that matters most when a shop goes dark and nobody
 * remembers touching it: the audit row still names WHO flipped it, WHEN, and
 * in which direction. What is given up is the ticket number. Two guard tests
 * in `store-staff.test.ts` and `admin-access.test.ts` record that this action
 * is the exception, so the next one cannot join it quietly.
 */
/** Prep time bounds, the same pair the shop's own settings screen enforces. */
const MIN_PREP_MINUTES = 1;
const MAX_PREP_MINUTES = 180;

/**
 * One shop, one form, one save.
 *
 * WHY THIS REPLACED FIVE PANELS. A shop's details were spread across the
 * console and the shop's own back office — the name and address could only be
 * changed with a psql prompt, the commission had its own panel, the prep time
 * lived in the merchant screen, and nothing put them on one page. Somebody
 * onboarding a partner had to know which of four screens held the field they
 * wanted, and two of them did not exist.
 *
 * So every column of `Store` that a person may set is in this one action, and
 * the page above it is one form with one button. The exceptions are the two
 * that are not really fields:
 *
 *  - The **logo and banner** stay their own upload controls. A file picker is
 *    not a text input; making it part of the form would mean re-uploading two
 *    images every time somebody fixes a phone number.
 *  - **Active / inactive** stays a switch. It is one bit, it is flipped far
 *    more often than anything else here, and burying it in a form behind a
 *    Save button is how a shop stays dark for an hour longer than it should.
 *
 * **The slug is NOT editable**, and that is deliberate rather than an
 * oversight: it is the shop's public address. Changing it turns every link a
 * customer saved, every link the shop posted on Facebook, and every search
 * result into a 404 — silently, with nothing in the console to say so. The
 * form shows it so an operator can copy it; changing one is a job for somebody
 * who can also put a redirect in front of it.
 *
 * ONE AUDIT ROW, listing only what actually changed. A row saying "the store
 * was edited" is no use six months later; a row saying the commission went
 * from 0 to 250 and the address moved is the whole point of keeping it.
 *
 * **NO TYPED REASON.** The form had one and it was removed on request: fixing
 * an address a partner just corrected over the phone is routine, and a
 * mandatory sentence in front of every save is friction on the common case.
 * What is kept is the row itself — who, when, and every field with both
 * sides — because `commissionBasisPoints` is on this form, and that is the
 * number a shop is paid by. When a partner disputes a payout, that row is the
 * only thing that answers "who agreed this rate, and when".
 *
 * So the reason is composed from the diff instead of being asked for. It
 * still goes through `normaliseReason`, because the column's rules do not
 * change just because the source did.
 */
export async function updateStoreProfileAction(
  _previous: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const storeId = String(formData.get('storeId') ?? '').trim();

    const text = (field: string): string => String(formData.get(field) ?? '').trim();

    const name = text('name');
    const addressLine = text('addressLine');
    const cityId = text('cityId');
    const description = text('description');
    const phoneRaw = text('contactPhone');
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

    // The same coordinate checks the create form makes, for the same reason: a
    // store at 0,0 is in the Atlantic, and every delivery fee quoted from it
    // would be computed from the Gulf of Guinea.
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

    const prepMinutes = Math.floor(Number(formData.get('preparationMinutes')));
    if (
      !Number.isInteger(prepMinutes) ||
      prepMinutes < MIN_PREP_MINUTES ||
      prepMinutes > MAX_PREP_MINUTES
    ) {
      return {
        ok: false,
        message: `Prep time is between ${MIN_PREP_MINUTES} and ${MAX_PREP_MINUTES} minutes.`,
      };
    }

    // --- posted opening hours -------------------------------------------
    //
    // Read as a pair. A window with one end is a schedule nothing can
    // evaluate, and the database refuses it anyway — better to say so here
    // than to hand somebody a constraint violation.
    const readWindow = (
      openField: string,
      closeField: string,
      label: string,
    ): { from: number | null; to: number | null } | { error: string } => {
      const openRaw = text(openField);
      const closeRaw = text(closeField);
      if (openRaw === '' && closeRaw === '') return { from: null, to: null };
      if (openRaw === '' || closeRaw === '') {
        return { error: `Give both a start and an end for the ${label}, or neither.` };
      }
      const from = parseMinuteOfDay(openRaw);
      const to = parseMinuteOfDay(closeRaw);
      if (from === null || to === null) {
        return { error: `Those ${label} times are not times. Use 24-hour, like 08:00.` };
      }
      if (from === to) {
        return { error: `A ${label} that starts and ends at the same minute is never open.` };
      }
      return { from, to };
    };

    const hours = readWindow('opensAt', 'closesAt', 'opening hours');
    if ('error' in hours) return { ok: false, message: hours.error };
    const brk = readWindow('breakStart', 'breakEnd', 'break');
    if ('error' in brk) return { ok: false, message: brk.error };
    if (brk.from !== null && hours.from === null) {
      return {
        ok: false,
        message: 'A break only means something inside posted opening hours. Set those first.',
      };
    }

    const basisPoints = Number(text('commissionBasisPoints'));
    if (!Number.isFinite(basisPoints)) {
      return { ok: false, message: 'Write the commission in basis points, like 250 for 2.5%.' };
    }
    // Throws `InvalidCommissionError`, which `guarded` turns into a sentence.
    assertCommissionInRange(basisPoints);

    // Stored in one shape so two shops entered by two people are searchable as
    // one number rather than as "0917…" and "+63917…".
    let contactPhone: string | null = null;
    if (phoneRaw !== '') {
      try {
        contactPhone = normalisePhilippineMobile(phoneRaw);
      } catch (error) {
        if (error instanceof InvalidPhoneNumberError) {
          return { ok: false, message: "Check the shop's mobile number." };
        }
        throw error;
      }
    }

    const city = await prisma.city.findUnique({ where: { id: cityId }, select: { id: true } });
    if (!city) return { ok: false, message: 'Pick a city.' };

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        contactPhone: true,
        cityId: true,
        addressLine: true,
        latitude: true,
        longitude: true,
        serviceKeys: true,
        preparationMinutes: true,
        commissionBasisPoints: true,
        opensAtMinute: true,
        closesAtMinute: true,
        breakStartMinute: true,
        breakEndMinute: true,
      },
    });
    if (!store) return { ok: false, message: 'No such store.' };

    const next = {
      name,
      description: description === '' ? null : description,
      contactPhone,
      cityId,
      addressLine,
      latitude,
      longitude,
      serviceKeys,
      preparationMinutes: prepMinutes,
      commissionBasisPoints: basisPoints,
      opensAtMinute: hours.from,
      closesAtMinute: hours.to,
      breakStartMinute: brk.from,
      breakEndMinute: brk.to,
    };

    // The comparison is its own function, and tested: both halves of it fail
    // quietly. See `changedStoreFields`.
    const changed = changedStoreFields(
      store as unknown as Record<string, StoreFieldValue>,
      next as unknown as Record<string, StoreFieldValue>,
    );

    if (Object.keys(changed).length === 0) {
      return { ok: false, message: 'Nothing on that form is different yet.' };
    }

    // Written from what changed, not typed. See the note on this action.
    const reason = normaliseReason(
      `Store details edited from the console: ${Object.keys(changed).join(', ')}.`,
    );

    await prisma.$transaction(async (tx) => {
      await tx.store.update({ where: { id: store.id }, data: next });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.STORE_PROFILE_CHANGED,
          subjectType: 'Store',
          subjectId: store.id,
          subjectLabel: store.name,
          reason,
          detail: { changed },
        },
        tx,
      );
    });

    revalidatePath('/admin/stores');
    revalidatePath(`/admin/stores/${store.id}`);
    revalidatePath(`/stores/${store.slug}`);
    // The shop's own screens read the prep time and the name too.
    revalidatePath(`/merchant/${store.id}/settings`);
    // Money: the settlement screen shows the rate this just changed.
    if (changed.commissionBasisPoints) revalidatePath('/admin/settlement');

    const fields = Object.keys(changed).length;
    return {
      ok: true,
      message: `Saved ${fields} ${fields === 1 ? 'change' : 'changes'} to ${name}.`,
    };
  });
}

/**
 * Putting a dish on a shop's menu, from the console.
 *
 * WHY THE CONSOLE CAN DO THIS AT ALL. A store with no menu cannot be made
 * Active — a customer would find it, open it and see nothing — and until now
 * the only way to get a first dish onto it was for the owner to sign in and
 * do it themselves. So a shop onboarded on a Friday afternoon sat dark until
 * somebody at the shop got round to it, and the operator who onboarded them
 * could see the problem on their screen and do nothing about it.
 *
 * THE SAME `addMenuItem` THE SHOP USES. Not a second insert with the same
 * shape: one path means the duplicate-name check, the category placement, the
 * 300-item cap and the sort ordering cannot drift between the two doors. What
 * differs is only who is allowed through — `requireAdmin` here, membership
 * there.
 *
 * NOT a general admin override on `requireStoreAccess`. That would have been
 * two lines and would have quietly handed every administrator the merchant's
 * whole surface — accepting orders, changing prices, printing the queue — on
 * a page about adding a dish.
 */
export async function addStoreMenuItemAction(
  _previous: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();

    const storeId = String(formData.get('storeId') ?? '').trim();
    const name = String(formData.get('name') ?? '').trim();
    const category = String(formData.get('category') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    const priceRaw = String(formData.get('price') ?? '').trim();

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, slug: true },
    });
    if (!store) return { ok: false, message: 'No such store.' };

    // The shop's own refusals, in the shop's own words. They are thrown rather
    // than returned, and `guarded` does not know them — without this a typo in
    // a price would land on `/admin/errors` as a fault of ours instead of as a
    // sentence next to the field.
    let created;
    try {
      // Through the shop's own parser, so "120", "120.50" and "₱120" are read
      // here exactly as they are read on the merchant screen.
      const priceCentavos = parsePrice(priceRaw, centavosFromPesoInput);

      created = await addMenuItem({
        storeId: store.id,
        name,
        category: category === '' ? DEFAULT_CATEGORY : category,
        priceCentavos,
        description: description === '' ? null : description,
      });
    } catch (error) {
      if (
        error instanceof ItemNameRequiredError ||
        error instanceof PriceNotUnderstoodError ||
        error instanceof PriceOutOfRangeError ||
        error instanceof DuplicateItemNameError ||
        error instanceof MenuFullError
      ) {
        return { ok: false, message: error.message };
      }
      throw error;
    }

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.STORE_MENU_ITEM_ADDED,
      subjectType: 'Store',
      subjectId: store.id,
      subjectLabel: store.name,
      reason: normaliseReason(
        `Added "${created.name}" to the menu from the console.`,
      ),
      detail: {
        itemId: created.id,
        name: created.name,
        category: created.category,
        priceCentavos: created.priceCentavos,
      },
    });

    revalidatePath('/admin/stores');
    revalidatePath(`/admin/stores/${store.id}`);
    revalidatePath(`/stores/${store.slug}`);
    revalidatePath(`/merchant/${store.id}/menu`);

    return {
      ok: true,
      message: `${created.name} added under ${created.category}, at ${formatCentavos(
        created.priceCentavos,
      )}.`,
    };
  });
}

export async function setStoreVisibilityAction(
  _previous: AdminActionResult | null,
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

  // Still through `normaliseReason`, so the column gets the same treatment
  // every other reason does — it is the SOURCE that differs, not the shape.
  const reason = normaliseReason(
    visible
      ? 'Set Active from the store console.'
      : 'Set Inactive from the store console.',
  );

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

/**
 * A shop's logo and banner.
 *
 * These two columns have existed since the first migration and until now
 * nothing in the console could write them — they were set by the seed and
 * otherwise by somebody with a psql prompt. So every shop onboarded through
 * this console had no logo and no banner, which is why the storefront grew a
 * tinted-initial fallback for both.
 *
 * BOTH FIELDS ARE SENT TOGETHER, and an empty box clears that field rather
 * than leaving it alone. A form where blank means "no change" cannot express
 * "remove the wrong banner", and removing a wrong banner is the urgent case:
 * the image is on a customer's screen right now.
 */
export async function setStoreBrandingAction(
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

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  let logoUrl: string | null;
  let coverUrl: string | null;
  try {
    logoUrl = parseImageUrl(String(formData.get('logoUrl') ?? ''));
    coverUrl = parseImageUrl(String(formData.get('coverUrl') ?? ''));
  } catch (error) {
    if (
      error instanceof ImageUrlNotUnderstoodError ||
      error instanceof ImageUrlTooLongError
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, slug: true, logoUrl: true, coverUrl: true },
  });
  if (!store) return { ok: false, message: 'No such store.' };

  if (store.logoUrl === logoUrl && store.coverUrl === coverUrl) {
    return { ok: false, message: 'Those are already the images on that shop.' };
  }

  await prisma.$transaction(async (tx) => {
    // `null` rather than `undefined`: undefined means "leave this column" to
    // Prisma, and an empty box has to be able to REMOVE an image.
    await tx.store.update({
      where: { id: store.id },
      data: { logoUrl, coverUrl },
    });
    // The other door onto the same two columns. This form can overwrite a
    // `/store-images/<id>` that an upload put there, and those bytes would
    // then be reachable from no page at all.
    await pruneOrphanStoreImages(store.id, { logoUrl, coverUrl }, tx);
    await recordAdminAction(
      {
        actorId: admin.id,
        action: AdminAction.STORE_BRANDING_CHANGED,
        subjectType: 'Store',
        subjectId: store.id,
        subjectLabel: store.name,
        reason,
        // What changed, not the addresses themselves — a data URL would put a
        // whole image into the audit row.
        detail: {
          logo: store.logoUrl === logoUrl ? 'unchanged' : logoUrl === null ? 'removed' : 'set',
          banner: store.coverUrl === coverUrl ? 'unchanged' : coverUrl === null ? 'removed' : 'set',
        },
      },
      tx,
    );
  });

  revalidatePath('/admin/stores');
  revalidatePath(`/admin/stores/${store.id}`);
  revalidatePath(`/stores/${store.slug}`);
  return { ok: true, message: `Updated the images on ${store.name}.` };
}

/**
 * Uploading a shop's logo or banner.
 *
 * THE FIX FOR THE REAL PROBLEM. The address form next to this one assumed the
 * picture was already on the internet somewhere — which it is not. What an
 * operator has is a JPEG the shop sent them, and until this existed there was
 * nowhere to put it, so shops onboarded through the console had no logo.
 *
 * The bytes are resized in the browser first (a phone photo is several
 * megabytes and a server action's body limit is one), and then validated here
 * from the bytes themselves, because the thing that resized them runs on a
 * computer somebody else controls.
 */
export async function uploadStoreImageAction(
  _previous: AdminActionResult | null,
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

  let kind;
  try {
    kind = parseStoreImageKind(formData.get('kind'));
  } catch (error) {
    if (error instanceof StoreImageKindUnknownError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
  const label = STORE_IMAGE_LABEL[kind];

  // Typed, like every other console action. It was tempting to write this one
  // from the upload itself — the reason is nearly always "the shop sent us
  // their logo" — but an action that records its own justification is not an
  // audit trail, and the rule that every one of these is explained by a person
  // is worth more than a saved keystroke. The control asks for it BEFORE it
  // opens the file picker, so nobody loses a file to this.
  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) return { ok: false, message: error.message };
    throw error;
  }

  const file = formData.get('image');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: `Pick a ${label} first.` };
  }
  // Checked before the whole thing is read into memory. The real limit is
  // enforced on the bytes; this is the cheap one.
  if (file.size > MAX_IMAGE_BYTES * 2) {
    return { ok: false, message: 'That image is too big to send. Try a smaller one.' };
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, slug: true, logoUrl: true, coverUrl: true },
  });
  if (!store) return { ok: false, message: 'No such store.' };
  const replacing = (kind === 'LOGO' ? store.logoUrl : store.coverUrl) !== null;

  let stored;
  try {
    stored = await putStoreImage({
      storeId: store.id,
      kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      uploadedByUserId: admin.id,
    });
  } catch (error) {
    if (
      error instanceof NotAnImageError ||
      error instanceof ImageTooLargeError ||
      error instanceof ImageWrongShapeError ||
      error instanceof StoreNotFoundError
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const size = `${stored.width}×${stored.height}, ${Math.round(stored.byteSize / 1024)} KB`;
  await recordAdminAction({
    actorId: admin.id,
    action: AdminAction.STORE_BRANDING_CHANGED,
    subjectType: 'Store',
    subjectId: store.id,
    subjectLabel: store.name,
    reason,
    // The facts, never the bytes and never the address — an audit row is read
    // in a list, and an image does not belong in one.
    detail: {
      kind,
      change: replacing ? 'replaced' : 'set',
      size,
      width: stored.width,
      height: stored.height,
      byteSize: stored.byteSize,
    },
  });

  revalidatePath('/admin/stores');
  revalidatePath(`/admin/stores/${store.id}`);
  revalidatePath(`/stores/${store.slug}`);
  return {
    ok: true,
    message: `Saved the ${label} — ${size}.`,
  };
}

/**
 * Taking a shop's logo or banner off.
 *
 * Clears the column whatever it held, so this also removes a hosted link that
 * somebody pasted, and deletes our bytes when that is what it pointed at.
 * The urgent case is a WRONG image, which is on a customer's screen right now.
 */
export async function removeStoreImageAction(
  _previous: AdminActionResult | null,
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

  let kind;
  try {
    kind = parseStoreImageKind(formData.get('kind'));
  } catch (error) {
    if (error instanceof StoreImageKindUnknownError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
  const label = STORE_IMAGE_LABEL[kind];

  let reason: string;
  try {
    reason = normaliseReason(formData.get('reason'));
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) return { ok: false, message: error.message };
    throw error;
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, slug: true },
  });
  if (!store) return { ok: false, message: 'No such store.' };

  let outcome;
  try {
    outcome = await removeStoreImage({ storeId: store.id, kind });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return { ok: false, message: error.message };
    throw error;
  }

  if (!outcome.removed) {
    return { ok: true, message: `${store.name} had no ${label}.` };
  }

  await recordAdminAction({
    actorId: admin.id,
    action: AdminAction.STORE_BRANDING_CHANGED,
    subjectType: 'Store',
    subjectId: store.id,
    subjectLabel: store.name,
    reason,
    detail: { kind, change: 'removed' },
  });

  revalidatePath('/admin/stores');
  revalidatePath(`/admin/stores/${store.id}`);
  revalidatePath(`/stores/${store.slug}`);
  return { ok: true, message: `Removed the ${label}.` };
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

// --- Loyalty points ----------------------------------------------------------

/**
 * Sets the points programme: the two rates, the block size and the expiry.
 *
 * The rates point in opposite directions and that is the trap — earning is
 * points per peso spent, redemption is points per peso paid back — so the
 * screen shows the effective giveback as a percentage, which is the number an
 * operator actually needs and would otherwise derive wrongly by a factor of
 * ten.
 */
export async function setLoyaltyProgrammeAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const whole = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    // Entered as points per peso, stored as basis points: a decimal like 1.5
    // has to survive, and a float column for a rate that multiplies every
    // order is how rounding drift starts.
    const perPesoRaw = Number(String(formData.get('pointsPerPeso') ?? '').trim());
    if (!Number.isFinite(perPesoRaw) || perPesoRaw < 0) {
      return { ok: false, message: 'Write the earn rate as points per peso, like 1 or 1.5.' };
    }
    const pointsPerPesoBasisPoints = Math.round(perPesoRaw * 10_000);

    const pointsPerPesoRedeemed = whole('pointsPerPesoRedeemed');
    const redemptionBlockPoints = whole('redemptionBlockPoints');
    const expiryMonths = whole('expiryMonths');
    const tierWindowMonths = whole('tierWindowMonths');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    if (
      pointsPerPesoRedeemed === null ||
      redemptionBlockPoints === null ||
      expiryMonths === null ||
      tierWindowMonths === null
    ) {
      return { ok: false, message: 'The rates and windows are whole numbers.' };
    }
    if (pointsPerPesoBasisPoints > MAX_POINTS_PER_PESO_BASIS_POINTS) {
      return {
        ok: false,
        message:
          'A hundred points per peso is a decimal point in the wrong place, and ' +
          'one that multiplies across every order at once.',
      };
    }
    if (tierWindowMonths < 1) {
      return { ok: false, message: 'The tier window has to be at least one month.' };
    }
    if (
      isActive &&
      (pointsPerPesoBasisPoints === 0 ||
        pointsPerPesoRedeemed === 0 ||
        redemptionBlockPoints === 0)
    ) {
      return {
        ok: false,
        message:
          'A live programme needs an earn rate, a redemption rate and a block ' +
          'size. Without all three it shows a balance that can never grow or ' +
          'never be spent.',
      };
    }
    if (redemptionBlockPoints > 0 && pointsPerPesoRedeemed > 0 &&
        redemptionBlockPoints % pointsPerPesoRedeemed !== 0) {
      return {
        ok: false,
        message:
          `A block of ${redemptionBlockPoints} at ${pointsPerPesoRedeemed} points ` +
          'per peso is not a whole number of pesos. Pick a block that divides evenly.',
      };
    }

    const before = await prisma.loyaltyProgramme.findUnique({
      where: { id: LOYALTY_PROGRAMME_ID },
    });

    const data = {
      isActive,
      pointsPerPesoBasisPoints,
      pointsPerPesoRedeemed,
      redemptionBlockPoints,
      expiryMonths,
      tierWindowMonths,
    };

    await prisma.$transaction(async (tx) => {
      await tx.loyaltyProgramme.upsert({
        where: { id: LOYALTY_PROGRAMME_ID },
        create: { id: LOYALTY_PROGRAMME_ID, ...data },
        update: data,
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.LOYALTY_PROGRAMME_CHANGED,
          subjectType: 'LoyaltyProgramme',
          subjectId: LOYALTY_PROGRAMME_ID,
          subjectLabel: isActive ? 'Points on' : 'Points off',
          reason,
          detail: { before, after: data },
        },
        tx,
      );
    });

    revalidatePath('/admin/loyalty');
    revalidatePath('/points');

    const giveback = effectiveGivebackBasisPoints(data);
    return {
      ok: true,
      message:
        (isActive
          ? `Points are on, giving back ${(giveback / 100).toFixed(2)}% of the food in every order.`
          : 'Points are off. Balances already earned stay put and can still be redeemed once you switch it back on.') +
        (isActive && expiryMonths === 0
          ? ' Points never expire at this setting, so the outstanding balance only ever grows.'
          : ''),
    };
  });
}

/** Adds or edits a tier. */
export async function setLoyaltyTierAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const tierId = String(formData.get('tierId') ?? '').trim();
    const name = String(formData.get('name') ?? '').trim().slice(0, 40);
    const blurb = String(formData.get('blurb') ?? '').trim().slice(0, 120);
    const thresholdPoints = Number(String(formData.get('thresholdPoints') ?? '').trim());
    const multiplierRaw = Number(String(formData.get('multiplier') ?? '').trim());

    if (name.length === 0 || blurb.length === 0) {
      return {
        ok: false,
        message:
          'A tier needs a name and a line saying what it means — "you are Suki" ' +
          'on its own tells a customer nothing.',
      };
    }
    if (!Number.isInteger(thresholdPoints) || thresholdPoints < 0) {
      return { ok: false, message: 'The threshold is a whole number of points.' };
    }
    if (!Number.isFinite(multiplierRaw) || multiplierRaw < 1 || multiplierRaw > 10) {
      return {
        ok: false,
        message:
          'The multiplier is between 1 and 10. Below 1 would earn slower than the ' +
          'base rate, which is a punishment for ordering.',
      };
    }
    const earnMultiplierBasisPoints = Math.round(multiplierRaw * 10_000);

    const data = { name, blurb, thresholdPoints, earnMultiplierBasisPoints };

    // A tier at the same threshold as another would make which one applies a
    // coin flip; the unique index refuses it, and so does this with a sentence.
    const clash = await prisma.loyaltyTier.findFirst({
      where: {
        OR: [{ thresholdPoints }, { name }],
        ...(tierId ? { id: { not: tierId } } : {}),
      },
      select: { name: true, thresholdPoints: true },
    });
    if (clash) {
      return {
        ok: false,
        message:
          `"${clash.name}" already sits at ${clash.thresholdPoints} points, or shares ` +
          'that name. Tiers need distinct thresholds and names.',
      };
    }

    await prisma.$transaction(async (tx) => {
      const tier = tierId
        ? await tx.loyaltyTier.update({ where: { id: tierId }, data })
        : await tx.loyaltyTier.create({
            data: { ...data, sortOrder: thresholdPoints },
          });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.LOYALTY_TIER_CHANGED,
          subjectType: 'LoyaltyTier',
          subjectId: tier.id,
          subjectLabel: tier.name,
          reason,
          detail: { after: data },
        },
        tx,
      );
    });

    revalidatePath('/admin/loyalty');
    revalidatePath('/points');
    return {
      ok: true,
      message:
        `"${name}" earns ${multiplierRaw}× from ${thresholdPoints} points. ` +
        'Nobody is re-scored retroactively — the tier applies to orders from now on.',
    };
  });
}

// --- Referrals ---------------------------------------------------------------

/**
 * Sets the referral programme: the two amounts, the minimum and the caps.
 *
 * The one control in this console that creates a standing liability against
 * every account at once, which is why it is audited and why the screen shows
 * the operator what a person farming their own SIM cards would net at the
 * numbers they just typed. The code does not refuse a farmable configuration —
 * it might be a deliberate launch subsidy — but it will not let one be chosen
 * by accident either.
 */
export async function setReferralProgrammeAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const pesos = (field: string): number | null =>
      centavosFromPesoInput(String(formData.get(field) ?? ''));
    const whole = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    const refereeCentavos = pesos('refereePesos');
    const referrerCentavos = pesos('referrerPesos');
    const minimumOrderCentavos = pesos('minimumPesos');
    const monthlyRewardCap = whole('monthlyCap');
    const lifetimeRewardCap = whole('lifetimeCap');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    if (
      refereeCentavos === null ||
      referrerCentavos === null ||
      minimumOrderCentavos === null
    ) {
      return { ok: false, message: 'Write the amounts in pesos, like 50 or 49.50.' };
    }
    if (monthlyRewardCap === null || lifetimeRewardCap === null) {
      return { ok: false, message: 'The caps are whole numbers of referrals.' };
    }
    if (
      refereeCentavos > MAX_REWARD_CENTAVOS ||
      referrerCentavos > MAX_REWARD_CENTAVOS
    ) {
      return {
        ok: false,
        message:
          `The most one side may be worth is ${formatCentavos(MAX_REWARD_CENTAVOS)}. ` +
          'A referral worth more than a large order is usually a decimal point ' +
          'in the wrong place.',
      };
    }
    if (isActive && (monthlyRewardCap === 0 || lifetimeRewardCap === 0)) {
      return {
        ok: false,
        message:
          'A live programme needs both caps above zero, or it advertises a code ' +
          'that can never pay.',
      };
    }
    if (lifetimeRewardCap > 0 && lifetimeRewardCap < monthlyRewardCap) {
      return {
        ok: false,
        message: 'The lifetime cap cannot be lower than the monthly one.',
      };
    }
    if (isActive && refereeCentavos === 0 && referrerCentavos === 0) {
      return {
        ok: false,
        message: 'A live programme has to pay somebody something.',
      };
    }

    const before = await prisma.referralProgramme.findUnique({
      where: { id: PROGRAMME_ID },
    });

    const data = {
      isActive,
      refereeCentavos,
      referrerCentavos,
      minimumOrderCentavos,
      monthlyRewardCap,
      lifetimeRewardCap,
    };

    await prisma.$transaction(async (tx) => {
      await tx.referralProgramme.upsert({
        where: { id: PROGRAMME_ID },
        create: { id: PROGRAMME_ID, ...data },
        update: data,
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.REFERRAL_PROGRAMME_CHANGED,
          subjectType: 'ReferralProgramme',
          subjectId: PROGRAMME_ID,
          subjectLabel: isActive ? 'Referrals on' : 'Referrals off',
          reason,
          detail: {
            before: before
              ? {
                  isActive: before.isActive,
                  refereeCentavos: before.refereeCentavos,
                  referrerCentavos: before.referrerCentavos,
                  minimumOrderCentavos: before.minimumOrderCentavos,
                  monthlyRewardCap: before.monthlyRewardCap,
                  lifetimeRewardCap: before.lifetimeRewardCap,
                }
              : null,
            after: data,
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/referrals');
    revalidatePath('/invite');

    const margin = farmerMargin(data);
    return {
      ok: true,
      message:
        (isActive
          ? 'Referrals are on. Existing referrals keep the amounts they were attributed at.'
          : 'Referrals are off. Codes already shared will stop paying.') +
        (isActive && margin.farmingPays
          ? ` Warning: at these amounts somebody referring themselves nets ${formatCentavos(margin.netCentavos)} per account.`
          : ''),
    };
  });
}

// --- Surge steps -------------------------------------------------------------

/**
 * Parses and bounds the fields of a surge step.
 *
 * The bounds are the same ones `prisma/sql/surge.sql` enforces, checked here
 * so an operator gets a sentence instead of a constraint-violation stack. The
 * database remains the enforcement: this is the error message, not the rule.
 */
function readBandFields(formData: FormData):
  | { ok: true; minOrdersPerRider: number; surgeCentavos: number; label: string }
  | { ok: false; message: string } {
  const threshold = Number(String(formData.get('minOrdersPerRider') ?? '').trim());
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return {
      ok: false,
      message:
        'Write the threshold as orders per available rider, like 1.5 — and above zero, ' +
        'or the step would apply when nothing is happening.',
    };
  }
  if (threshold > 100) {
    return { ok: false, message: 'A threshold above 100 orders per rider will never be met.' };
  }

  const surgeCentavos = centavosFromPesoInput(String(formData.get('surgePesos') ?? ''));
  if (surgeCentavos === null) {
    return { ok: false, message: 'Write the amount in pesos, like 20 or 20.50.' };
  }
  if (surgeCentavos <= 0) {
    return {
      ok: false,
      message: 'A step that adds nothing is not a step. Switch it off instead.',
    };
  }
  if (surgeCentavos > SURGE_CEILING_CENTAVOS) {
    return {
      ok: false,
      message:
        `The most one step may add is ${formatCentavos(SURGE_CEILING_CENTAVOS)}. ` +
        'A surge larger than a whole fare is usually a decimal point in the wrong place.',
    };
  }

  const label = String(formData.get('label') ?? '').trim().slice(0, 40);
  if (label.length === 0) {
    return {
      ok: false,
      message:
        'Give the step a name the customer will read next to the charge, like "Busy". ' +
        'A fee with no name reads as a mistake.',
    };
  }

  return { ok: true, minOrdersPerRider: threshold, surgeCentavos, label };
}

/** Warns when a ladder now reads backwards, without refusing the save. */
async function ladderWarning(
  serviceType: ServiceKey,
  cityId: string | null,
): Promise<string> {
  const bands = await prisma.surgeBand.findMany({
    where: { serviceType, isActive: true, OR: [{ cityId }, { cityId: null }] },
  });
  // Check the ladder as a quote would see it: for a fallback step that means
  // any city, and there is no single city to test, so the fallback rows alone
  // are the ladder.
  const ladder = cityId === null
    ? bands.filter((band) => band.cityId === null)
    : ladderFor(bands, cityId);
  const descending = firstDescendingStep(ladder);
  if (!descending) return '';
  return (
    ` Note: "${descending.label}" adds less than the step below it, so it will ` +
    'never be reached — pricing takes the largest amount the market has earned, ' +
    'never a smaller one for a busier market.'
  );
}

/**
 * Adds a surge step.
 *
 * A city step and a national step at the same threshold are both allowed, and
 * the city one wins ENTIRELY where it exists — the two ladders are never
 * merged. Which is why this refuses a duplicate within one ladder rather than
 * across both.
 */
export async function createSurgeBandAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const serviceType = String(formData.get('serviceType') ?? '') as ServiceKey;
    if (!Object.values(ServiceKey).includes(serviceType)) {
      return { ok: false, message: 'Pick a service.' };
    }
    // Empty means the fallback ladder: every city where the service is live.
    const rawCity = String(formData.get('cityId') ?? '').trim();
    const cityId = rawCity === '' ? null : rawCity;

    const fields = readBandFields(formData);
    if (!fields.ok) return fields;

    const existing = await prisma.surgeBand.findFirst({
      where: { serviceType, cityId, minOrdersPerRider: fields.minOrdersPerRider },
    });
    if (existing) {
      return {
        ok: false,
        message:
          `There is already a step at ${fields.minOrdersPerRider} orders per rider ` +
          `in this ladder ("${existing.label}"). Edit that one instead.`,
      };
    }

    const band = await prisma.$transaction(async (tx) => {
      const created = await tx.surgeBand.create({
        data: {
          serviceType,
          cityId,
          minOrdersPerRider: fields.minOrdersPerRider,
          surgeCentavos: fields.surgeCentavos,
          label: fields.label,
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SURGE_BAND_CREATED,
          subjectType: 'SurgeBand',
          subjectId: created.id,
          subjectLabel: `${serviceType} ${cityId ?? 'all cities'} @ ${fields.minOrdersPerRider}`,
          reason,
          detail: {
            minOrdersPerRider: fields.minOrdersPerRider,
            surgeCentavos: fields.surgeCentavos,
            label: fields.label,
          },
        },
        tx,
      );
      return created;
    });

    revalidatePath('/admin/surge');
    return {
      ok: true,
      message:
        `Added "${band.label}": ${formatCentavos(band.surgeCentavos)} at ` +
        `${band.minOrdersPerRider} orders per available rider. It takes effect at the ` +
        'next measurement, within a minute or two.' +
        (await ladderWarning(serviceType, cityId)),
    };
  });
}

/** Edits a step's threshold, amount or name. */
export async function updateSurgeBandAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const bandId = String(formData.get('bandId') ?? '');
    const band = await prisma.surgeBand.findUnique({ where: { id: bandId } });
    if (!band) return { ok: false, message: 'No such surge step.' };

    const fields = readBandFields(formData);
    if (!fields.ok) return fields;

    const clash = await prisma.surgeBand.findFirst({
      where: {
        serviceType: band.serviceType,
        cityId: band.cityId,
        minOrdersPerRider: fields.minOrdersPerRider,
        id: { not: band.id },
      },
    });
    if (clash) {
      return {
        ok: false,
        message: `"${clash.label}" already sits at that threshold in this ladder.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.surgeBand.update({
        where: { id: band.id },
        data: {
          minOrdersPerRider: fields.minOrdersPerRider,
          surgeCentavos: fields.surgeCentavos,
          label: fields.label,
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SURGE_BAND_CHANGED,
          subjectType: 'SurgeBand',
          subjectId: band.id,
          subjectLabel: band.label,
          reason,
          detail: {
            before: {
              minOrdersPerRider: band.minOrdersPerRider,
              surgeCentavos: band.surgeCentavos,
              label: band.label,
            },
            after: {
              minOrdersPerRider: fields.minOrdersPerRider,
              surgeCentavos: fields.surgeCentavos,
              label: fields.label,
            },
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/surge');
    return {
      ok: true,
      message:
        `Updated "${fields.label}". Orders already placed keep what they were ` +
        'charged — this changes the next measurement onwards.' +
        (await ladderWarning(band.serviceType, band.cityId)),
    };
  });
}

/**
 * Switches a step on or off.
 *
 * Kept separate from editing, and audited separately, because "was surge on in
 * Manila at 6pm?" is the question a complaint actually asks, and it should be
 * answerable without reading a diff of amounts.
 *
 * Off is how surge is turned off: a step with no rows can never charge, and
 * there is deliberately no way to configure a step that adds nothing.
 */
export async function setSurgeBandActiveAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const bandId = String(formData.get('bandId') ?? '');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    const band = await prisma.surgeBand.findUnique({ where: { id: bandId } });
    if (!band) return { ok: false, message: 'No such surge step.' };
    if (band.isActive === isActive) {
      return {
        ok: false,
        message: `"${band.label}" is already ${isActive ? 'on' : 'off'}.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.surgeBand.update({ where: { id: band.id }, data: { isActive } });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SURGE_BAND_ACTIVATION_CHANGED,
          subjectType: 'SurgeBand',
          subjectId: band.id,
          subjectLabel: band.label,
          reason,
          detail: { before: band.isActive, after: isActive },
        },
        tx,
      );
    });

    revalidatePath('/admin/surge');
    return {
      ok: true,
      message:
        `"${band.label}" is now ${isActive ? 'on' : 'off'}. ` +
        'The change reaches quotes at the next measurement.',
    };
  });
}


// =============================================================================
// Promo codes
// =============================================================================
//
// A promo code is the only thing in this console that hands a spending decision
// to the public. Everything else an administrator changes affects one account,
// one shop or one order; a code goes onto a tarpaulin and into a group chat,
// and how much it costs is decided by whoever screenshots it.
//
// So creation refuses two things and warns about a third:
//
//   1. A code with NO bound on its total cost is refused. Not because an
//      unlimited campaign is unthinkable, but because it has to be typed
//      deliberately: set a redemption limit or a budget, even a large one, and
//      the number goes into the audit row next to the reason for it. The dates
//      are not a bound — a week of unlimited free delivery is still unlimited.
//   2. A percentage with no ceiling is refused, mirroring the SQL guard. A
//      percentage is unbounded on a large order.
//   3. A code that makes food FREE is allowed and shouted about. That can be a
//      deliberate acquisition subsidy. It usually is not: it is a minimum
//      order somebody forgot to raise, and `resolvePromo` will place those
//      orders correctly all day while we pay the shop and the rider in full.
//
// Codes are never DELETED, only switched off. A used code cannot be deleted at
// all — the foreign key is RESTRICT — because deleting one would erase the
// record of what the campaign cost.

/** Reads a whole number from a form field. Null when it is not one. */
function wholeNumber(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Reads an OPTIONAL whole number: blank means "no limit", not "zero". */
function optionalWholeNumber(
  raw: FormDataEntryValue | null,
): { ok: true; value: number | null } | { ok: false } {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return { ok: true, value: null };
  const value = wholeNumber(raw);
  return value === null ? { ok: false } : { ok: true, value };
}

/** Reads a date-local input. Null when absent or unparseable. */
function localDate(raw: FormDataEntryValue | null): Date | null {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return null;
  const value = new Date(text);
  return Number.isNaN(value.getTime()) ? null : value;
}

export async function createPromoCodeAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const code = normalisePromoCode(String(formData.get('code') ?? ''));
    const label = String(formData.get('label') ?? '').trim().slice(0, 120);
    const kindRaw = String(formData.get('kind') ?? '');

    if (!codeLooksPlausible(code)) {
      return {
        ok: false,
        message:
          'A code is 3 to 40 characters of letters, digits and hyphens. It goes ' +
          'on a poster and gets read aloud, so keep it short.',
      };
    }
    if (label.length < 3) {
      return {
        ok: false,
        message:
          'Give it a name the customer will read on their bill — "₱50 off your ' +
          'first order". A discount line with no name reads as a mistake.',
      };
    }
    if (!Object.values(PromoKind).includes(kindRaw as PromoKind)) {
      return { ok: false, message: 'Choose what the code takes off.' };
    }
    const kind = kindRaw as PromoKind;

    const percentInput = String(formData.get('percent') ?? '').trim();
    const percentBasisPoints =
      percentInput.length > 0 ? Math.round(Number(percentInput) * 100) : null;
    const amountCentavos = centavosFromPesoInput(String(formData.get('amountPesos') ?? ''));
    const maxDiscountCentavos = centavosFromPesoInput(
      String(formData.get('ceilingPesos') ?? ''),
    );
    const minimumOrderCentavos = centavosFromPesoInput(
      String(formData.get('minimumPesos') ?? ''),
    );

    if (minimumOrderCentavos === null) {
      return { ok: false, message: 'Write the minimum order in pesos, like 250.' };
    }

    // --- The kind carries its own fields. Mirrors `promo_kind_carries_its_own_fields`.
    if (kind === PromoKind.PERCENTAGE) {
      if (
        percentBasisPoints === null ||
        !Number.isInteger(percentBasisPoints) ||
        percentBasisPoints <= 0 ||
        percentBasisPoints > 10_000
      ) {
        return { ok: false, message: 'A percentage is between 0 and 100, like 15 or 12.5.' };
      }
      if (maxDiscountCentavos === null || maxDiscountCentavos <= 0) {
        return {
          ok: false,
          message:
            'A percentage needs a ceiling per order. Without one it is unbounded ' +
            'on a large order, which is the usual way a campaign becomes a story.',
        };
      }
    }
    if (kind === PromoKind.FIXED_AMOUNT) {
      if (amountCentavos === null || amountCentavos <= 0) {
        return { ok: false, message: 'Write the amount off in pesos, like 50.' };
      }
      if (amountCentavos > MAX_DISCOUNT_CENTAVOS) {
        return {
          ok: false,
          message:
            `The most one order may be discounted is ${formatCentavos(MAX_DISCOUNT_CENTAVOS)}. ` +
            'More than that is usually a decimal point in the wrong place.',
        };
      }
    }
    if (maxDiscountCentavos !== null && maxDiscountCentavos > MAX_DISCOUNT_CENTAVOS) {
      return {
        ok: false,
        message: `The ceiling cannot be above ${formatCentavos(MAX_DISCOUNT_CENTAVOS)}.`,
      };
    }

    // --- The window.
    const startsAt = localDate(formData.get('startsAt'));
    const endsAt = localDate(formData.get('endsAt'));
    if (!startsAt || !endsAt) {
      return { ok: false, message: 'Set the dates the code runs between.' };
    }
    if (endsAt <= startsAt) {
      return { ok: false, message: 'The end has to come after the start.' };
    }

    // --- The caps.
    const total = optionalWholeNumber(formData.get('totalLimit'));
    const budget = String(formData.get('budgetPesos') ?? '').trim();
    const budgetCentavos = budget.length > 0 ? centavosFromPesoInput(budget) : null;
    const perCustomerLimit = wholeNumber(formData.get('perCustomerLimit'));

    if (!total.ok) {
      return { ok: false, message: 'The redemption limit is a whole number, or blank for none.' };
    }
    if (budget.length > 0 && budgetCentavos === null) {
      return { ok: false, message: 'Write the budget in pesos, like 20000.' };
    }
    if (perCustomerLimit === null || perCustomerLimit < 1) {
      return { ok: false, message: 'One account may use a code at least once.' };
    }
    if (total.value !== null && total.value < 1) {
      return {
        ok: false,
        message: 'A limit of zero redemptions is a code that cannot be used. Leave it blank, or switch the code off.',
      };
    }
    if (budgetCentavos !== null && budgetCentavos <= 0) {
      return {
        ok: false,
        message: 'A budget of nothing is a code that cannot be used. Leave it blank instead.',
      };
    }

    // The refusal this whole section exists for.
    if (total.value === null && budgetCentavos === null) {
      return {
        ok: false,
        message:
          'Set a redemption limit or a budget. A public code with neither is an ' +
          'open cheque — the dates bound how long it runs, not how much it ' +
          'costs. Put a large number in if that is what you mean; it goes in ' +
          'the log next to your reason.',
      };
    }

    // --- Scope. Empty means everywhere, which is the default.
    const serviceTypes = formData
      .getAll('serviceTypes')
      .map((value) => String(value))
      .filter((value): value is ServiceKey =>
        Object.values(ServiceKey).includes(value as ServiceKey),
      );
    const cityIds = formData
      .getAll('cityIds')
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
    const storeId = String(formData.get('storeId') ?? '').trim() || null;

    const existing = await prisma.promoCode.findUnique({ where: { code } });
    if (existing) {
      return {
        ok: false,
        message:
          `${code} already exists. Codes are never reused — a code that has been ` +
          'shared once is out there forever, so give this campaign its own.',
      };
    }

    const data = {
      code,
      label,
      kind,
      percentBasisPoints: kind === PromoKind.PERCENTAGE ? percentBasisPoints : null,
      amountCentavos: kind === PromoKind.FIXED_AMOUNT ? amountCentavos : null,
      maxDiscountCentavos: kind === PromoKind.FREE_DELIVERY ? null : maxDiscountCentavos,
      minimumOrderCentavos,
      serviceTypes,
      cityIds,
      storeId,
      firstOrderOnly: String(formData.get('firstOrderOnly') ?? '') === 'on',
      startsAt,
      endsAt,
      totalRedemptionLimit: total.value,
      perCustomerLimit,
      budgetCentavos,
      stacksWithSubscription: String(formData.get('stacksWithSubscription') ?? '') === 'on',
      isActive: true,
      createdById: admin.id,
    };

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.promoCode.create({ data });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.PROMO_CODE_CREATED,
          subjectType: 'PromoCode',
          subjectId: row.id,
          subjectLabel: `${row.code} — ${row.label}`,
          reason,
          // The caps ARE the decision, so they go in the row rather than being
          // reconstructible from a table somebody may later edit.
          detail: {
            kind: row.kind,
            percentBasisPoints: row.percentBasisPoints,
            amountCentavos: row.amountCentavos,
            maxDiscountCentavos: row.maxDiscountCentavos,
            minimumOrderCentavos: row.minimumOrderCentavos,
            totalRedemptionLimit: row.totalRedemptionLimit,
            perCustomerLimit: row.perCustomerLimit,
            budgetCentavos: row.budgetCentavos,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            serviceTypes: row.serviceTypes,
            cityIds: row.cityIds,
            storeId: row.storeId,
            firstOrderOnly: row.firstOrderOnly,
            stacksWithSubscription: row.stacksWithSubscription,
          },
        },
        tx,
      );
      return row;
    });

    revalidatePath('/admin/promo');

    // The worst case, stated back. An operator who has just typed a limit and a
    // budget should read what the two of them add up to, once, rather than
    // finding out at the end of the month.
    const exposure = exposureFor(created, { redemptions: 0, spentCentavos: 0 });
    const giveaway = giveawayFor(created);

    const worstCase =
      exposure.remainingCentavos === null
        ? 'There is no bound on what it can cost.'
        : `At most ${formatCentavos(exposure.remainingCentavos)} in total.`;

    const freeFood = giveaway.coversTheFood
      ? ' WARNING: ' +
        (minimumOrderCentavos === 0
          ? 'there is no minimum order, so ANY order is covered in full'
          : `an order of ${formatCentavos(giveaway.smallestOrderCentavos)} is covered in full`) +
        ' — somebody can eat for nothing while we pay the shop and the rider' +
        ' in full. Raise the minimum order above the discount unless that is' +
        ' the subsidy you mean to pay.'
      : '';

    return {
      ok: true,
      message: `${created.code} is live. ${worstCase}${freeFood}`,
    };
  });
}

export async function setPromoCodeActiveAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const promoCodeId = String(formData.get('promoCodeId') ?? '');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    const code = await prisma.promoCode.findUnique({ where: { id: promoCodeId } });
    if (!code) {
      return { ok: false, message: 'No such code.' };
    }
    if (code.isActive === isActive) {
      return {
        ok: false,
        message: `${code.code} is already ${isActive ? 'on' : 'off'}.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.promoCode.update({
        where: { id: promoCodeId },
        data: { isActive },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.PROMO_CODE_ACTIVATION_CHANGED,
          subjectType: 'PromoCode',
          subjectId: code.id,
          subjectLabel: `${code.code} ${isActive ? 'on' : 'off'}`,
          reason,
          detail: { before: code.isActive, after: isActive },
        },
        tx,
      );
    });

    revalidatePath('/admin/promo');

    return {
      ok: true,
      message: isActive
        ? `${code.code} works again, within its dates and caps.`
        : `${code.code} is off. Anybody typing it now is told it is not available — ` +
          'orders already placed with it keep their discount.',
    };
  });
}


// =============================================================================
// Gift cards
// =============================================================================
//
// A gift card is the only control in this console that hands SPENDABLE money
// to a bearer. Everything else grants credits to an account somebody has
// already signed into: a promo code needs an order at checkout, a referral
// needs a signup and a delivery, an adjustment needs to name whose balance it
// is correcting. A gift card needs nothing but the string.
//
// Two consequences run through both actions below.
//
// The plaintext code exists exactly ONCE, in the success message of
// `issueGiftCardAction`. It is never stored, never logged, and cannot be
// recovered — the row holds a SHA-256 of it. That is deliberate and it is the
// reason a leaked backup is not a pile of cash, but it does mean an
// administrator who closes the tab has lost the card and has to issue another
// and cancel the first.
//
// And cards are cancelled, never deleted, and only while unredeemed. After
// redemption the money is in somebody's balance and the correction is a signed
// ADJUSTMENT against that account.

export async function issueGiftCardAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const amountCentavos = centavosFromPesoInput(String(formData.get('amountPesos') ?? ''));
    if (amountCentavos === null) {
      return { ok: false, message: 'Write the amount in pesos, like 250 or 99.50.' };
    }
    if (amountCentavos <= 0) {
      return { ok: false, message: 'A gift card has to be worth something.' };
    }
    if (amountCentavos > MAX_GIFT_CARD_CENTAVOS) {
      return {
        ok: false,
        message:
          `The most one card may be worth is ${formatCentavos(MAX_GIFT_CARD_CENTAVOS)}. ` +
          'A single card worth more than that is usually a decimal point in the ' +
          'wrong place, and the recovery is finding whoever holds the paper. ' +
          'Issue several, or adjust an account you can name.',
      };
    }

    const note = String(formData.get('note') ?? '').trim();
    const expiryRaw = String(formData.get('expiresAt') ?? '').trim();
    let expiresAt: Date | null = null;
    if (expiryRaw.length > 0) {
      const parsed = new Date(expiryRaw);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, message: 'That expiry date could not be read.' };
      }
      if (parsed.getTime() <= Date.now()) {
        return {
          ok: false,
          message: 'An expiry in the past would make the card dead on arrival.',
        };
      }
      expiresAt = parsed;
    }

    const { card, code } = await prisma.$transaction(async (tx) => {
      const issued = await issueGiftCard(
        {
          amountCentavos,
          issuedById: admin.id,
          issuedReason: reason,
          note: note || undefined,
          expiresAt,
        },
        tx,
      );
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.GIFT_CARD_ISSUED,
          subjectType: 'GiftCard',
          subjectId: issued.card.id,
          // The REFERENCE, never the code. This row is permanent and readable
          // by every administrator; putting the code in it would hand the card
          // to anybody with console access, forever.
          subjectLabel: `${issued.card.reference} · ${formatCentavos(amountCentavos)}`,
          reason,
          detail: {
            reference: issued.card.reference,
            amountCentavos,
            expiresAt: expiresAt?.toISOString() ?? null,
            note: note || null,
          },
        },
        tx,
      );
      return issued;
    });

    revalidatePath('/admin/gift-cards');

    return {
      ok: true,
      message:
        `${card.reference} — ${formatCentavos(amountCentavos)}. ` +
        `The code is ${code}. ` +
        'COPY IT NOW: it is stored only as a hash, so this is the one and only ' +
        'time it can be shown. If you lose it, cancel this card and issue another.',
    };
  });
}

export async function voidGiftCardAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const cardId = String(formData.get('cardId') ?? '');

    const card = await prisma.$transaction(async (tx) => {
      // Refuses a redeemed or already-cancelled card by name, and
      // compare-and-sets so a redemption landing at this instant wins rather
      // than being cancelled out from under the person holding the card.
      const voided = await voidGiftCard(
        { cardId, voidedById: admin.id, reason },
        tx,
      );
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.GIFT_CARD_VOIDED,
          subjectType: 'GiftCard',
          subjectId: voided.id,
          subjectLabel: `${voided.reference} cancelled`,
          reason,
          detail: {
            reference: voided.reference,
            amountCentavos: voided.amountCentavos,
          },
        },
        tx,
      );
      return voided;
    });

    revalidatePath('/admin/gift-cards');

    return {
      ok: true,
      message:
        `${card.reference} is cancelled. Anybody typing it now is told so, and ` +
        `the ${formatCentavos(card.amountCentavos)} is off the outstanding total.`,
    };
  });
}

// -----------------------------------------------------------------------------
// Subscription invoices
// -----------------------------------------------------------------------------

/**
 * The three decisions somebody makes about a subscription bill.
 *
 * They are the same three the order payment queue has — confirm, refuse,
 * cancel — and they are deliberately named and worded differently, because on
 * a subscription each one also moves a TERM. Confirming an order releases a
 * meal; confirming a bill grants a month of benefits and pushes the next
 * deadline out. That is why these get their own audit actions rather than
 * reusing `PAYMENT_CONFIRMED`: "which month did we decide they had paid for"
 * is the question a dispute turns on, and it is unanswerable from an order's
 * audit row.
 */

/**
 * The transfer checked out: mark the month paid.
 *
 * The reference recorded is what the CONSOLE matched, defaulting to what the
 * customer claimed. It is settable because the useful case is a customer who
 * mistyped one digit of a number that is otherwise clearly theirs in the
 * statement — recording the real reference is what makes the row worth
 * anything to whoever reconciles it next month.
 *
 * The amount is NOT settable, unlike an order's. An invoice is a fixed monthly
 * fee, and a short transfer is not a partial month — there is no such thing as
 * 60% of free delivery. Somebody who sent too little should be refused with
 * that reason and asked to send the rest.
 */
export async function confirmSubscriptionInvoiceAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const reason = normaliseReason(formData.get('reason'));
    const typed = String(formData.get('reference') ?? '').trim();

    const invoice = await prisma.subscriptionInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        reference: true,
        amountCentavos: true,
        submittedReference: true,
        subscription: { select: { plan: { select: { name: true } } } },
      },
    });
    if (!invoice) return { ok: false, message: 'No such bill.' };

    const reference = typed || invoice.submittedReference || '';
    if (!reference) {
      // Confirming with nothing to point at is a month given away on somebody's
      // memory. The statement line is the whole evidence trail.
      return {
        ok: false,
        message:
          'Type the reference you matched this against. The customer has not ' +
          'sent one, and a confirmed month with no reference cannot be ' +
          'reconciled against a statement later.',
      };
    }

    const outcome = await settleInvoice({
      invoiceId: invoice.id,
      via: 'manual',
      reference,
      settledById: admin.id,
    });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SUBSCRIPTION_INVOICE_CONFIRMED,
      subjectType: 'SubscriptionInvoice',
      subjectId: invoice.id,
      subjectLabel: invoice.reference,
      reason,
      detail: {
        amountCentavos: invoice.amountCentavos,
        reference,
        claimedReference: invoice.submittedReference,
        renewsAt: outcome.renewsAt.toISOString(),
        startedTheSubscription: outcome.startedTheSubscription,
      },
    });

    revalidatePath('/admin/subscriptions');

    return {
      ok: true,
      message: outcome.startedTheSubscription
        ? `${formatCentavos(invoice.amountCentavos)} confirmed. Their ` +
          `${invoice.subscription.plan.name} is on and benefits apply from now.`
        : `${formatCentavos(invoice.amountCentavos)} confirmed. Their plan runs ` +
          `on, and the next bill goes out a week before it ends.`,
    };
  });
}

/**
 * The reference did not check out.
 *
 * Does NOT cancel the bill, on purpose — the same choice `refusePaymentAction`
 * makes for an order, and for the same reason. A mistyped digit is the
 * likeliest explanation, the money may well be sitting in the account, and the
 * subscription keeps its deadline so a corrected reference still saves it.
 *
 * The reason reaches the SUBSCRIBER verbatim, in a notification and on their
 * own screen. Worth knowing before writing "nope" in it.
 */
export async function refuseSubscriptionInvoiceAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const invoice = await prisma.subscriptionInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, reference: true, submittedReference: true },
    });
    if (!invoice) return { ok: false, message: 'No such bill.' };

    await refuseInvoiceClaim({ invoiceId: invoice.id, reason });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SUBSCRIPTION_INVOICE_REFUSED,
      subjectType: 'SubscriptionInvoice',
      subjectId: invoice.id,
      subjectLabel: invoice.reference,
      reason,
      detail: { refusedReference: invoice.submittedReference },
    });

    revalidatePath('/admin/subscriptions');

    return {
      ok: true,
      message:
        'Refused, and the subscriber has been told why in those words. The ' +
        'bill is still open, so a corrected reference will come back here.',
    };
  });
}

/**
 * The money is no longer owed.
 *
 * The one decision here that forgoes revenue rather than judging a reference:
 * a bill raised in error, a subscriber being comped instead, a plan withdrawn
 * mid-period. It compare-and-sets on `settledAt`, so a transfer confirmed at
 * this exact moment wins and this refuses — which is the right way round, as
 * voiding a bill somebody has already paid would leave the term paid for and
 * the money unaccounted.
 */
export async function voidSubscriptionInvoiceAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const invoice = await prisma.subscriptionInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, reference: true, amountCentavos: true },
    });
    if (!invoice) return { ok: false, message: 'No such bill.' };

    await voidInvoice({ invoiceId: invoice.id, reason });

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.SUBSCRIPTION_INVOICE_VOIDED,
      subjectType: 'SubscriptionInvoice',
      subjectId: invoice.id,
      subjectLabel: invoice.reference,
      reason,
      detail: { amountCentavos: invoice.amountCentavos },
    });

    revalidatePath('/admin/subscriptions');

    return {
      ok: true,
      message:
        `${invoice.reference} is cancelled and ` +
        `${formatCentavos(invoice.amountCentavos)} is no longer owed. Their ` +
        'plan still ends on its current date unless somebody extends it.',
    };
  });
}

/**
 * Sets the rider-invite programme.
 *
 * The same shape as `setReferralProgrammeAction` and one important difference:
 * this one commits REAL MONEY. Every rider acquired through it adds a
 * `REFERRAL_BONUS` to what TARA owes somebody, and that leaves through a
 * payout rather than reducing a future bill — so the refusals here are about
 * spending rather than about farming.
 *
 * There is no farmer's-margin warning, because there is no margin to warn
 * about: collecting a partner bonus means passing verification and completing
 * real deliveries, and somebody who does that has done the job the bonus was
 * for. The confirmation says what a rider costs instead, per delivery, which
 * is the number that can quietly be wrong for months.
 */
export async function setPartnerReferralProgrammeAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const pesos = (field: string): number | null =>
      centavosFromPesoInput(String(formData.get(field) ?? ''));
    const whole = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    const referrerCentavos = pesos('referrerPesos');
    const refereeCentavos = pesos('refereePesos');
    const qualifyingDeliveries = whole('qualifyingDeliveries');
    const monthlyRewardCap = whole('monthlyCap');
    const lifetimeRewardCap = whole('lifetimeCap');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    if (referrerCentavos === null || refereeCentavos === null) {
      return { ok: false, message: 'Write the amounts in pesos, like 500 or 250.50.' };
    }
    if (
      qualifyingDeliveries === null ||
      monthlyRewardCap === null ||
      lifetimeRewardCap === null
    ) {
      return {
        ok: false,
        message: 'The deliveries and the caps are whole numbers.',
      };
    }
    if (
      referrerCentavos > MAX_PARTNER_REWARD_CENTAVOS ||
      refereeCentavos > MAX_PARTNER_REWARD_CENTAVOS
    ) {
      return {
        ok: false,
        message:
          `The most one side may be worth is ${formatCentavos(
            MAX_PARTNER_REWARD_CENTAVOS,
          )}. More than that is usually a decimal point in the wrong place — ` +
          'and here that is a decimal point in a real payout.',
      };
    }
    if (isActive && qualifyingDeliveries < 1) {
      return {
        ok: false,
        message:
          'A live programme needs at least one qualifying delivery. Paying on ' +
          'signup would be paying for owning a SIM card rather than for the work.',
      };
    }
    if (isActive && (monthlyRewardCap === 0 || lifetimeRewardCap === 0)) {
      return {
        ok: false,
        message:
          'A live programme needs both caps above zero, or it advertises a code ' +
          'that can never pay.',
      };
    }
    if (lifetimeRewardCap > 0 && lifetimeRewardCap < monthlyRewardCap) {
      return {
        ok: false,
        message: 'The lifetime cap cannot be lower than the monthly one.',
      };
    }
    if (isActive && referrerCentavos === 0 && refereeCentavos === 0) {
      return {
        ok: false,
        message: 'A live programme has to pay somebody something.',
      };
    }

    const before = await prisma.partnerReferralProgramme.findUnique({
      where: { id: PARTNER_PROGRAMME_ID },
    });

    const data = {
      isActive,
      referrerCentavos,
      refereeCentavos,
      qualifyingDeliveries,
      monthlyRewardCap,
      lifetimeRewardCap,
    };

    await prisma.$transaction(async (tx) => {
      await tx.partnerReferralProgramme.upsert({
        where: { id: PARTNER_PROGRAMME_ID },
        create: { id: PARTNER_PROGRAMME_ID, ...data },
        update: data,
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.PARTNER_REFERRAL_PROGRAMME_CHANGED,
          subjectType: 'PartnerReferralProgramme',
          subjectId: PARTNER_PROGRAMME_ID,
          subjectLabel: isActive ? 'Rider invites on' : 'Rider invites off',
          reason,
          detail: {
            before: before
              ? {
                  isActive: before.isActive,
                  referrerCentavos: before.referrerCentavos,
                  refereeCentavos: before.refereeCentavos,
                  qualifyingDeliveries: before.qualifyingDeliveries,
                  monthlyRewardCap: before.monthlyRewardCap,
                  lifetimeRewardCap: before.lifetimeRewardCap,
                }
              : null,
            after: data,
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/referrals');
    revalidatePath('/fleet/invite');
    revalidatePath('/fleet/apply');

    const cost = acquisitionCost(data);
    return {
      ok: true,
      message: isActive
        ? `Rider invites are on. A rider acquired this way costs ` +
          `${formatCentavos(cost.bothSidesCentavos)} over ` +
          `${cost.qualifyingDeliveries} ${
            cost.qualifyingDeliveries === 1 ? 'delivery' : 'deliveries'
          } — ${formatCentavos(cost.perQualifyingDeliveryCentavos)} per delivery. ` +
          'Bonuses already earned keep the amounts they were paid at.'
        : 'Rider invites are off. Codes already shared will stop paying, and ' +
          'bonuses already earned are still owed.',
    };
  });
}

// -----------------------------------------------------------------------------
// Store referrals
// -----------------------------------------------------------------------------

/**
 * Records which shop introduced another shop.
 *
 * The only referral attribution in this app that a person makes rather than a
 * code — a shop does not sign itself up — which is why it lives here in the
 * console actions alongside the comped subscription and the recorded payout,
 * and why it is audited the same way. Nothing in the system can know this
 * fact; somebody asserts it, and the audit row is the only evidence that
 * assertion ever leaves.
 *
 * The refusal reaches the person who typed it, unlike the rider version's,
 * which the application form ignores so a bad code cannot cost somebody their
 * application. Here being wrong is the likely case worth handling: the shop
 * has already been attributed, or was trading long before anybody introduced
 * it.
 */
export async function attributeStoreReferralAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const refereeStoreId = String(formData.get('storeId') ?? '');
    const referrerStoreId = String(formData.get('referrerStoreId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    if (!referrerStoreId) {
      return { ok: false, message: 'Pick the shop that made the introduction.' };
    }

    const referee = await prisma.store.findUnique({
      where: { id: refereeStoreId },
      select: { id: true, name: true },
    });
    if (!referee) return { ok: false, message: 'No such shop.' };

    const outcome = await attributeStoreReferral({
      refereeStoreId,
      referrerStoreId,
      attributedById: admin.id,
      note: reason,
    });

    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }

    await recordAdminAction({
      actorId: admin.id,
      action: AdminAction.STORE_REFERRAL_ATTRIBUTED,
      subjectType: 'Store',
      subjectId: referee.id,
      subjectLabel: referee.name,
      reason,
      detail: { referrerStoreId, referrerName: outcome.referrerName },
    });

    revalidatePath(`/admin/stores/${refereeStoreId}`);
    revalidatePath('/admin/referrals');

    return {
      ok: true,
      message:
        `Recorded: ${outcome.referrerName} brought ${outcome.refereeName}. ` +
        'Nothing is owed yet — the bonus is earned once this shop has traded ' +
        'past the threshold, and it goes out with their next payout.',
    };
  });
}

/**
 * Sets the shop-referral programme.
 *
 * Third of three, and the same shape as the other two. What differs is the
 * threshold — what the introduced shop must have EARNED rather than how many
 * jobs it has done — and the number in the confirmation, which is the bonus
 * expressed in basis points of those earnings so it can be read straight
 * against a shop's commission rate.
 */
export async function setStoreReferralProgrammeAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const pesos = (field: string): number | null =>
      centavosFromPesoInput(String(formData.get(field) ?? ''));
    const whole = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    const referrerCentavos = pesos('referrerPesos');
    const refereeCentavos = pesos('refereePesos');
    const qualifyingEarningsCentavos = pesos('qualifyingEarningsPesos');
    const monthlyRewardCap = whole('monthlyCap');
    const lifetimeRewardCap = whole('lifetimeCap');
    const isActive = String(formData.get('isActive') ?? '') === 'true';

    if (
      referrerCentavos === null ||
      refereeCentavos === null ||
      qualifyingEarningsCentavos === null
    ) {
      return {
        ok: false,
        message: 'Write the amounts in pesos, like 500 or 20000.',
      };
    }
    if (monthlyRewardCap === null || lifetimeRewardCap === null) {
      return { ok: false, message: 'The caps are whole numbers of referrals.' };
    }
    if (
      referrerCentavos > MAX_STORE_REWARD_CENTAVOS ||
      refereeCentavos > MAX_STORE_REWARD_CENTAVOS
    ) {
      return {
        ok: false,
        message:
          `The most one side may be worth is ${formatCentavos(
            MAX_STORE_REWARD_CENTAVOS,
          )}. More than that is usually a decimal point in the wrong place — ` +
          'and here that is a decimal point in a real payout.',
      };
    }
    if (isActive && qualifyingEarningsCentavos <= 0) {
      return {
        ok: false,
        message:
          'A live programme needs an earnings threshold above zero. Zero would ' +
          'pay for a shop being added to the console, which is something you ' +
          'do by hand for a shop that may never sell anything.',
      };
    }
    if (isActive && (monthlyRewardCap === 0 || lifetimeRewardCap === 0)) {
      return {
        ok: false,
        message: 'A live programme needs both caps above zero.',
      };
    }
    if (lifetimeRewardCap > 0 && lifetimeRewardCap < monthlyRewardCap) {
      return {
        ok: false,
        message: 'The lifetime cap cannot be lower than the monthly one.',
      };
    }
    if (isActive && referrerCentavos === 0 && refereeCentavos === 0) {
      return {
        ok: false,
        message: 'A live programme has to pay somebody something.',
      };
    }

    const before = await prisma.storeReferralProgramme.findUnique({
      where: { id: STORE_PROGRAMME_ID },
    });

    const data = {
      isActive,
      referrerCentavos,
      refereeCentavos,
      qualifyingEarningsCentavos,
      monthlyRewardCap,
      lifetimeRewardCap,
    };

    await prisma.$transaction(async (tx) => {
      await tx.storeReferralProgramme.upsert({
        where: { id: STORE_PROGRAMME_ID },
        create: { id: STORE_PROGRAMME_ID, ...data },
        update: data,
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.STORE_REFERRAL_PROGRAMME_CHANGED,
          subjectType: 'StoreReferralProgramme',
          subjectId: STORE_PROGRAMME_ID,
          subjectLabel: isActive ? 'Shop referrals on' : 'Shop referrals off',
          reason,
          detail: {
            before: before
              ? {
                  isActive: before.isActive,
                  referrerCentavos: before.referrerCentavos,
                  refereeCentavos: before.refereeCentavos,
                  qualifyingEarningsCentavos: before.qualifyingEarningsCentavos,
                  monthlyRewardCap: before.monthlyRewardCap,
                  lifetimeRewardCap: before.lifetimeRewardCap,
                }
              : null,
            after: data,
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/referrals');

    const cost = storeAcquisitionCost(data);
    return {
      ok: true,
      message: isActive
        ? `Shop referrals are on. A shop acquired this way costs ` +
          `${formatCentavos(cost.bothSidesCentavos)} against a ` +
          `${formatCentavos(cost.qualifyingEarningsCentavos)} earnings ` +
          `threshold — ${(cost.costBasisPointsOfEarnings / 100).toFixed(2)}% of ` +
          'it. Read that against what you charge those shops in commission. ' +
          'Bonuses already earned keep the amounts they were paid at.'
        : 'Shop referrals are off. Attributions already recorded will stop ' +
          'paying, and bonuses already earned are still owed.',
    };
  });
}

/**
 * Adds or changes one benefit on a loyalty tier.
 *
 * The type decides which fields are read, and every other column is written
 * NULL rather than left as it was. That is the important half: editing a
 * DISPATCH_PRIORITY row into a DISCOUNT_PERCENT one and leaving the old
 * `priorityWeight` behind would leave a row whose columns contradict its type,
 * which `loyalty_tier_benefit_columns_match_type` refuses — so the guard would
 * turn a careless edit into an error the operator cannot read. Nulling first
 * means the form does the obvious thing.
 */
export async function setLoyaltyTierBenefitAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const tierId = String(formData.get('tierId') ?? '').trim();
    const rawType = String(formData.get('type') ?? '').trim();
    const displayLabel = String(formData.get('displayLabel') ?? '')
      .trim()
      .slice(0, 120);

    if (!tierId) return { ok: false, message: 'Pick the tier this belongs to.' };
    if (!(rawType in TierBenefitType)) {
      return { ok: false, message: 'Pick what the tier confers.' };
    }
    const type = rawType as TierBenefitType;

    if (displayLabel.length < 3) {
      return {
        ok: false,
        message:
          'Write the line the customer reads. The sentence under it is ' +
          'generated from the numbers, but the heading is yours.',
      };
    }

    const tier = await prisma.loyaltyTier.findUnique({
      where: { id: tierId },
      select: { id: true, name: true },
    });
    if (!tier) return { ok: false, message: 'No such tier.' };

    const optionalWhole = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      if (raw.length === 0) return null;
      const value = Number(raw);
      return Number.isInteger(value) ? value : Number.NaN;
    };
    const optionalPesos = (field: string): number | null => {
      const raw = String(formData.get(field) ?? '').trim();
      if (raw.length === 0) return null;
      return centavosFromPesoInput(raw);
    };
    const percent = (): number | null => {
      const raw = String(formData.get('percent') ?? '').trim();
      if (raw.length === 0) return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) return Number.NaN;
      return Math.round(value * 100);
    };

    // Every column NULL, then only the ones this type uses filled in.
    const data: {
      percentBasisPoints: number | null;
      minimumOrderCentavos: number | null;
      monthlyUsageCap: number | null;
      maxDiscountCentavos: number | null;
      monthlyCeilingCentavos: number | null;
      priorityWeight: number | null;
      serviceKeys: ServiceKey[];
    } = {
      percentBasisPoints: null,
      minimumOrderCentavos: null,
      monthlyUsageCap: null,
      maxDiscountCentavos: null,
      monthlyCeilingCentavos: null,
      priorityWeight: null,
      serviceKeys: [],
    };

    const badNumber = { ok: false as const, message: 'Those numbers do not read as numbers.' };

    switch (type) {
      case TierBenefitType.FREE_DELIVERY: {
        const minimum = optionalPesos('minimumPesos') ?? 0;
        const cap = optionalWhole('monthlyCap');
        if (minimum === null || Number.isNaN(minimum) || Number.isNaN(cap)) return badNumber;
        if (minimum < 0) return { ok: false, message: 'The minimum order cannot be negative.' };
        if (cap !== null && cap < 1) {
          return {
            ok: false,
            message: 'A cap of zero would be a benefit that never applies. Leave it blank for no cap.',
          };
        }
        data.minimumOrderCentavos = minimum;
        data.monthlyUsageCap = cap;
        break;
      }
      case TierBenefitType.DISCOUNT_PERCENT: {
        const basisPoints = percent();
        const cap = optionalPesos('maxDiscountPesos');
        if (basisPoints === null || Number.isNaN(basisPoints)) {
          return { ok: false, message: 'Write the percentage, like 10 or 7.5.' };
        }
        if (cap !== null && Number.isNaN(cap)) return badNumber;
        if (basisPoints <= 0 || basisPoints > MAX_TIER_PERCENT_BASIS_POINTS) {
          return {
            ok: false,
            message:
              `A tier discount is between 0 and ${MAX_TIER_PERCENT_BASIS_POINTS / 100}%. ` +
              'More than that is usually a decimal point in the wrong place.',
          };
        }
        if (cap !== null && cap < 1) {
          return { ok: false, message: 'Leave the ceiling blank for no ceiling.' };
        }
        data.percentBasisPoints = basisPoints;
        data.maxDiscountCentavos = cap;
        data.serviceKeys = formData
          .getAll('serviceKeys')
          .map((key) => String(key))
          .filter((key): key is ServiceKey => key in ServiceKey);
        break;
      }
      case TierBenefitType.CREDIT_BACK_PERCENT: {
        const basisPoints = percent();
        const ceiling = optionalPesos('monthlyCeilingPesos');
        if (basisPoints === null || Number.isNaN(basisPoints)) {
          return { ok: false, message: 'Write the percentage, like 2 or 2.5.' };
        }
        if (ceiling !== null && Number.isNaN(ceiling)) return badNumber;
        if (basisPoints <= 0 || basisPoints > MAX_TIER_PERCENT_BASIS_POINTS) {
          return {
            ok: false,
            message: `Credit-back is between 0 and ${MAX_TIER_PERCENT_BASIS_POINTS / 100}%.`,
          };
        }
        if (ceiling !== null && ceiling < 1) {
          return { ok: false, message: 'Leave the monthly ceiling blank for none.' };
        }
        data.percentBasisPoints = basisPoints;
        data.monthlyCeilingCentavos = ceiling;
        break;
      }
      case TierBenefitType.DISPATCH_PRIORITY:
      case TierBenefitType.SUPPORT_PRIORITY: {
        const minutes = optionalWhole('priorityMinutes');
        if (minutes === null || Number.isNaN(minutes)) {
          return { ok: false, message: 'Write how many minutes of a head start this is worth.' };
        }
        if (minutes < 1 || minutes > MAX_TIER_PRIORITY_WEIGHT) {
          return {
            ok: false,
            message:
              `Between 1 and ${MAX_TIER_PRIORITY_WEIGHT} minutes. It is a tie-break ` +
              'between things of similar age, not a separate queue — somebody who has ' +
              'waited longer than this still goes first, which is what stops an order ' +
              'being starved on a busy night.',
          };
        }
        data.priorityWeight = minutes;
        break;
      }
      case TierBenefitType.POINTS_NEVER_EXPIRE:
        // Nothing to read. Every column stays null.
        break;
    }

    const existing = await prisma.loyaltyTierBenefit.findFirst({
      where: { tierId, type },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.loyaltyTierBenefit.update({
            where: { id: existing.id },
            data: { ...data, displayLabel },
          })
        : await tx.loyaltyTierBenefit.create({
            data: { tierId, type, ...data, displayLabel },
          });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.LOYALTY_TIER_BENEFIT_CHANGED,
          subjectType: 'LoyaltyTierBenefit',
          subjectId: row.id,
          subjectLabel: `${tier.name} · ${TIER_BENEFIT_NAME[type]}`,
          reason,
          detail: { tierId, type, ...data, displayLabel },
        },
        tx,
      );
    });

    revalidatePath('/admin/loyalty');
    revalidatePath('/points');

    return {
      ok: true,
      message:
        `${tier.name} now gets "${TIER_BENEFIT_NAME[type]}". ` +
        (isBillBenefit(type)
          ? 'It is priced by the same engine as a Plus benefit, so a customer ' +
            'with both gets one waiver rather than two.'
          : 'It costs nothing on a bill. Orders already placed are unaffected.'),
    };
  });
}

/**
 * Removes one benefit from a tier.
 *
 * The row goes; the receipts do not. `OrderAppliedBenefit.tierBenefitId` is
 * nullable and its `source` and `displayLabel` are copies, so an order priced
 * by this benefit last week still says what it got — which is the reason those
 * columns are copies rather than a join.
 */
export async function removeLoyaltyTierBenefitAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));
    const benefitId = String(formData.get('benefitId') ?? '').trim();

    const benefit = await prisma.loyaltyTierBenefit.findUnique({
      where: { id: benefitId },
      select: { id: true, type: true, tier: { select: { name: true } } },
    });
    if (!benefit) return { ok: false, message: 'That benefit is already gone.' };

    await prisma.$transaction(async (tx) => {
      await tx.loyaltyTierBenefit.delete({ where: { id: benefit.id } });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.LOYALTY_TIER_BENEFIT_REMOVED,
          subjectType: 'LoyaltyTierBenefit',
          subjectId: benefit.id,
          subjectLabel: `${benefit.tier.name} · ${TIER_BENEFIT_NAME[benefit.type]}`,
          reason,
        },
        tx,
      );
    });

    revalidatePath('/admin/loyalty');
    revalidatePath('/points');
    return {
      ok: true,
      message:
        `${benefit.tier.name} no longer gets "${TIER_BENEFIT_NAME[benefit.type]}". ` +
        'Receipts for orders it already priced still name it.',
    };
  });
}

// -----------------------------------------------------------------------------
// The serving area
// -----------------------------------------------------------------------------

/**
 * Adds a city.
 *
 * In this file, and audited, because it is a commercial decision rather than a
 * configuration one: it decides where this deployment claims to operate. It
 * also has a trap that no other create in here has — a city with no delivery
 * fee rule reaching it is a city where CHECKOUT fails rather than one that
 * politely says it is closed. So nothing is launched here. The city is created
 * switched on but with no service in it, which `cityStanding()` reports as
 * "No service yet" and the screen explains.
 *
 * The id is derived from the name (`Arayat` becomes `city_arayat`) rather than
 * being a cuid, because these ids appear in `NEXT_PUBLIC_DEFAULT_CITY_ID`, in
 * `Service.availableCityIds` and in operators' notes — see `cityIdFor`.
 */
export async function createCityAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const reason = normaliseReason(formData.get('reason'));

    const taken = await prisma.city.findMany({ select: { id: true } });
    const read = readCityEntry(
      {
        name: formData.get('name')?.toString(),
        province: formData.get('province')?.toString(),
        region: formData.get('region')?.toString(),
        centroidLat: formData.get('latitude')?.toString(),
        centroidLng: formData.get('longitude')?.toString(),
      },
      taken.map((city) => city.id),
    );
    if (!read.ok) return { ok: false, message: CITY_ERROR_MESSAGES[read.error] };

    await prisma.$transaction(async (tx) => {
      await tx.city.create({ data: { ...read.entry, isActive: true } });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SERVICE_AREA_CREATED,
          subjectType: 'City',
          subjectId: read.entry.id,
          subjectLabel: `${read.entry.name}, ${read.entry.province}`,
          reason,
          detail: { ...read.entry },
        },
        tx,
      );
    });

    revalidatePath('/admin/areas');
    revalidatePath('/admin/stores');
    // The home screen and the address form both read the city list.
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message:
        `${read.entry.name} is on the map as ${read.entry.id}. ` +
        'Nothing is orderable there yet — launch a service in it on the Services ' +
        'screen, and give that service a delivery fee rule for it.',
    };
  });
}

/**
 * Edits a city, or switches it off.
 *
 * The NAME, province, region and centre are editable; the id is not, because
 * it is referenced by `Service.availableCityIds`, by every `Address` and
 * `Store` row in it, and possibly by an environment variable. Renaming
 * "Arayat" to "Arayat, Pampanga" is a label change and safe; changing what the
 * row IS would orphan those references silently.
 *
 * Switching a city off is the closest thing in this console to withdrawing
 * from a market. It hides the city from the address form and from service
 * availability, and it deliberately does NOT touch the addresses, stores or
 * orders already there — cancelling somebody's dinner because an operator
 * unticked a box would be a much worse answer than a shop that stops taking
 * new orders.
 */
export async function updateCityAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const cityId = String(formData.get('cityId') ?? '');
    const reason = normaliseReason(formData.get('reason'));

    const city = await prisma.city.findUnique({ where: { id: cityId } });
    if (!city) return { ok: false, message: 'No such city.' };

    /* An activation-only submit carries no name field. Kept as one action
       rather than two because both write the same audit row about the same
       subject, and a screen with two forms for one row is how they drift. */
    const isActivationOnly = formData.get('name') === null;

    if (isActivationOnly) {
      const isActive = formData.get('isActive') === 'true';
      if (isActive === city.isActive) return { ok: false, message: 'Nothing to change.' };

      const [addresses, stores] = await Promise.all([
        prisma.address.count({ where: { cityId, archivedAt: null } }),
        prisma.store.count({ where: { cityId } }),
      ]);

      await prisma.$transaction(async (tx) => {
        await tx.city.update({ where: { id: cityId }, data: { isActive } });
        await recordAdminAction(
          {
            actorId: admin.id,
            action: AdminAction.SERVICE_AREA_CHANGED,
            subjectType: 'City',
            subjectId: cityId,
            subjectLabel: `${city.name}, ${city.province}`,
            reason,
            // The counts go in the row because they are the thing somebody
            // reading this later will want and cannot reconstruct.
            detail: { isActive, addressesAffected: addresses, storesAffected: stores },
          },
          tx,
        );
      });

      revalidatePath('/admin/areas');
      revalidatePath('/', 'layout');
      return {
        ok: true,
        message: isActive
          ? `${city.name} is back on the map.`
          : `${city.name} is off the map. ` +
            `${addresses} saved address(es) and ${stores} store(s) there are ` +
            'untouched — nothing in flight was cancelled.',
      };
    }

    const others = await prisma.city.findMany({
      where: { id: { not: cityId } },
      select: { id: true },
    });
    const read = readCityEntry(
      {
        name: formData.get('name')?.toString(),
        province: formData.get('province')?.toString(),
        region: formData.get('region')?.toString(),
        centroidLat: formData.get('latitude')?.toString(),
        centroidLng: formData.get('longitude')?.toString(),
      },
      others.map((row) => row.id),
    );
    if (!read.ok) return { ok: false, message: CITY_ERROR_MESSAGES[read.error] };

    await prisma.$transaction(async (tx) => {
      /* The derived id from the new name is DISCARDED. See the note above:
         `id` is referenced from too many places to change, and a rename is a
         label change. */
      await tx.city.update({
        where: { id: cityId },
        data: {
          name: read.entry.name,
          province: read.entry.province,
          region: read.entry.region,
          centroidLat: read.entry.centroidLat,
          centroidLng: read.entry.centroidLng,
        },
      });
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.SERVICE_AREA_CHANGED,
          subjectType: 'City',
          subjectId: cityId,
          subjectLabel: `${read.entry.name}, ${read.entry.province}`,
          reason,
          detail: {
            before: {
              name: city.name,
              province: city.province,
              region: city.region,
              centroidLat: city.centroidLat,
              centroidLng: city.centroidLng,
            },
            after: { ...read.entry, id: cityId },
          },
        },
        tx,
      );
    });

    revalidatePath('/admin/areas');
    revalidatePath('/', 'layout');
    return { ok: true, message: `${read.entry.name} updated. Its id is still ${cityId}.` };
  });
}

/**
 * Sets what delivery costs for one service, in one city or everywhere.
 *
 * Audited under its own action because it decides what every future order in
 * that city pays to be delivered — the same class of decision as a store's
 * commission, and the one an operator is most likely to get wrong by a factor
 * of a hundred (centavos versus pesos). The form takes PESOS and
 * `readFeeRule` converts; it refuses three decimal places rather than
 * rounding.
 *
 * An empty `cityId` means the service's FALLBACK rule — `DeliveryFeeRule`
 * documents `cityId: null` as "every city where the service is live". That is
 * the rule worth setting first on a new deployment, because it is what stops a
 * newly added city being unpriced.
 */
export async function setDeliveryFeeRuleAction(
  formData: FormData,
): Promise<AdminActionResult> {
  return guarded(async () => {
    const admin = await requireAdmin();
    const serviceType = String(formData.get('serviceType') ?? '') as ServiceKey;
    const rawCityId = String(formData.get('cityId') ?? '').trim();
    const cityId = rawCityId === '' ? null : rawCityId;
    const reason = normaliseReason(formData.get('reason'));

    const [service, city] = await Promise.all([
      prisma.service.findUnique({ where: { key: serviceType } }),
      cityId === null
        ? Promise.resolve(null)
        : prisma.city.findUnique({ where: { id: cityId } }),
    ]);
    if (!service) return { ok: false, message: 'No such service.' };
    if (cityId !== null && !city) return { ok: false, message: 'No such city.' };

    const read = readFeeRule({
      baseFee: formData.get('baseFee')?.toString(),
      perKilometre: formData.get('perKilometre')?.toString(),
      includedMeters: formData.get('includedMeters')?.toString(),
      minimumFee: formData.get('minimumFee')?.toString(),
      maximumFee: formData.get('maximumFee')?.toString(),
      freeAboveSubtotal: formData.get('freeAboveSubtotal')?.toString(),
      smallOrderThreshold: formData.get('smallOrderThreshold')?.toString(),
      smallOrderFee: formData.get('smallOrderFee')?.toString(),
      serviceFee: formData.get('serviceFee')?.toString(),
    });
    if (!read.ok) return { ok: false, message: FEE_RULE_ERROR_MESSAGES[read.error] };

    const where = { serviceType, cityId };
    const existing = await prisma.deliveryFeeRule.findFirst({
      where,
      select: { id: true },
    });

    const label = `${service.displayName} — ${city ? city.name : 'every city (fallback)'}`;

    await prisma.$transaction(async (tx) => {
      /* Upsert by hand rather than `upsert`, because the unique key is the
         COMPOSITE [serviceType, cityId] and `cityId` is nullable — Postgres
         treats NULLs as distinct in a unique index, so the fallback row cannot
         be addressed by that key. Found by trying it. */
      if (existing) {
        await tx.deliveryFeeRule.update({
          where: { id: existing.id },
          data: { ...read.entry, isActive: true },
        });
      } else {
        await tx.deliveryFeeRule.create({
          data: { serviceType, cityId, ...read.entry, isActive: true },
        });
      }
      await recordAdminAction(
        {
          actorId: admin.id,
          action: AdminAction.DELIVERY_FEE_RULE_CHANGED,
          subjectType: 'DeliveryFeeRule',
          subjectId: existing?.id ?? `${serviceType}:${cityId ?? 'fallback'}`,
          subjectLabel: label,
          reason,
          detail: { serviceType, cityId, ...read.entry, created: existing === null },
        },
        tx,
      );
    });

    revalidatePath('/admin/areas');
    // Quotes are computed per request, but the storefront and home read cities.
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message:
        `${label}: ${existing ? 'updated' : 'created'}. ` +
        'It applies to orders placed from now on; orders already quoted keep ' +
        'the fee they were quoted.',
    };
  });
}
