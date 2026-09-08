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
import {
  grantStoreAccessAsAdmin,
  revokeStoreAccessAsAdmin,
} from '@/lib/merchant/staff';
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
