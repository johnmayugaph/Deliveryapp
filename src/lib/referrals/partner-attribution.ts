import { ReferralStatus } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { findReferrerByCode } from '@/lib/referrals/codes';
import { getPartnerProgramme } from '@/lib/referrals/partner-programme';
import { normaliseCode } from '@/lib/referrals/policy';
import {
  PARTNER_REFUSAL_TEXT,
  refusalForPartnerAttribution,
  type PartnerAttributionRefusal,
} from '@/lib/referrals/partner-policy';

/**
 * Recording which rider brought which rider.
 *
 * Simpler than the customer side in one way and stricter in another.
 *
 * **Simpler:** there is no cookie to survive. A rider types a code into the
 * application form, and the application is the moment the `FleetPartner` row
 * comes into existence — so there is always an account to attach to and no
 * thirty-day window to reason about. `REFERRAL_COOKIE` exists because a
 * customer follows a link before they have an account; a rider fills in a form
 * they are already signed in for.
 *
 * **Stricter:** attribution here decides who gets REAL MONEY later, so it is
 * written once inside the same transaction as the application and then frozen
 * by `partner_referral_no_reattribution`. An attribution that could be edited
 * would let a second rider claim somebody after their twentieth delivery,
 * which is the whole game.
 *
 * Nothing here pays anybody. Both sides are paid when the invited rider
 * reaches the qualifying delivery count — see `payPartnerReferralForDelivery`.
 * That is the asymmetry with the customer programme, where the invited side is
 * granted credits at attribution so they can spend them on the order that
 * qualifies it. There is no equivalent here: a bonus at signup would be a
 * bonus for owning a SIM card.
 */

export type PartnerAttributionResult =
  | { ok: true; referrerName: string | null; codeUsed: string }
  | { ok: false; refusal: PartnerAttributionRefusal; message: string };

/**
 * Attributes a new rider to a code.
 *
 * Takes a transaction client and is meant to be given one: the caller creates
 * the `FleetPartner` row in the same transaction, so an attributed referral
 * whose partner does not exist is not a state this can produce.
 *
 * Returns a refusal rather than throwing. A bad code must never cost somebody
 * their application — see the call site, which ignores the result for exactly
 * that reason.
 */
export async function attributePartnerReferral(
  input: { refereePartnerId: string; refereeUserId: string; code: string },
  client?: PrismaTransactionClient,
): Promise<PartnerAttributionResult> {
  const db = client ?? prisma;
  const programme = await getPartnerProgramme(db);

  const codeOwner = await findReferrerByCode(input.code, db);

  // The code belongs to a USER; the referral belongs to their FLEET PARTNER
  // record. A customer's code resolves here and then finds no partner, which
  // is the `NOT_A_RIDER_CODE` case: there would be no settlement account to
  // accrue a bonus to.
  const referrerPartner = codeOwner
    ? await db.fleetPartner.findUnique({
        where: { userId: codeOwner.id },
        select: { id: true, userId: true, isSuspended: true },
      })
    : null;

  const [existing, completedDeliveryCount] = await Promise.all([
    db.partnerReferral.findUnique({
      where: { refereeId: input.refereePartnerId },
      select: { id: true },
    }),
    // Deliveries this applicant has already completed. Normally zero — they
    // are applying — but not always: somebody whose partner record was deleted
    // and recreated, or a code typed into a second application, has to be
    // refused rather than paid for arriving twice.
    db.order.count({
      where: { assignedRiderId: input.refereePartnerId, status: 'COMPLETED' },
    }),
  ]);

  const refusal = refusalForPartnerAttribution({
    programme,
    referrer:
      codeOwner && referrerPartner
        ? {
            fleetPartnerId: referrerPartner.id,
            userId: codeOwner.id,
            isBlocked: codeOwner.isBlocked,
            isSuspended: referrerPartner.isSuspended,
          }
        : null,
    codeOwnerExists: codeOwner !== null,
    referee: {
      userId: input.refereeUserId,
      alreadyReferred: existing !== null,
      completedDeliveryCount,
    },
  });

  if (refusal !== null || !referrerPartner) {
    const named = refusal ?? 'UNKNOWN_CODE';
    return { ok: false, refusal: named, message: PARTNER_REFUSAL_TEXT[named] };
  }

  await db.partnerReferral.create({
    data: {
      referrerId: referrerPartner.id,
      refereeId: input.refereePartnerId,
      // Verbatim as normalised, so "I used Ana's code" stays answerable after
      // Ana's code is reissued.
      codeUsed: normaliseCode(input.code),
      status: ReferralStatus.ATTRIBUTED,
    },
  });

  return {
    ok: true,
    referrerName: codeOwner?.displayName ?? null,
    codeUsed: normaliseCode(input.code),
  };
}
