import { ReferralStatus } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { grantCredit } from '@/lib/wallet/ledger';
import { findReferrerByCode } from '@/lib/referrals/codes';
import { getProgramme } from '@/lib/referrals/programme';
import {
  REFUSAL_TEXT,
  normaliseCode,
  refusalForAttribution,
  type AttributionRefusal,
} from '@/lib/referrals/policy';

/**
 * Recording who invited whom, and paying the invited side.
 *
 * The hard part is not the row, it is the timing. A referral link is opened by
 * somebody who has no account yet, so the code has to survive a login and an
 * onboarding step before there is a user to attach it to — see
 * `REFERRAL_COOKIE` and where it is claimed.
 *
 * Attribution happens exactly once and is then immutable, enforced in the
 * database by `referral_no_reattribution`. That is not tidiness: an attribution
 * that could be rewritten would let a second referrer claim an account after
 * its first order completed, which is the whole game.
 */

/** Where a code waits between the link being opened and the account existing. */
export const REFERRAL_COOKIE = 'tara_ref';

/**
 * Thirty days.
 *
 * Long enough that somebody who is sent a link at work and orders at the
 * weekend still counts, and short enough that a code cannot sit in a browser
 * for a year and then attribute an account to a programme that has changed
 * twice since.
 */
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type AttributionResult =
  | {
      ok: true;
      referrerName: string | null;
      refereeGrantedCentavos: number;
    }
  | { ok: false; refusal: AttributionRefusal; message: string };

/**
 * Attributes an account to a code and grants the invited side's credits.
 *
 * Called once, when the account finishes onboarding — not when the link is
 * opened. Onboarding is the first moment there is an account to attach to, and
 * a name to greet the referrer with.
 *
 * The referee's credits land HERE rather than on completion of their first
 * order, because the whole incentive is that they can put them towards it. The
 * referrer's do not: that is the asymmetry which makes farming cost a real
 * order. See `payReferrerForOrder`.
 *
 * Everything in one transaction: an attributed referral with no credits granted
 * would leave somebody looking at a welcome message and an empty balance, and
 * credits with no referral row would be untraceable money.
 */
export async function attributeReferral(
  input: { refereeId: string; code: string },
  client?: PrismaTransactionClient,
): Promise<AttributionResult> {
  const db = client ?? prisma;
  const programme = await getProgramme(db);

  const [referrer, referee, existing] = await Promise.all([
    findReferrerByCode(input.code, db),
    db.user.findUniqueOrThrow({
      where: { id: input.refereeId },
      select: { id: true },
    }),
    db.referral.findUnique({
      where: { refereeId: input.refereeId },
      select: { id: true },
    }),
  ]);

  // A completed order is the test of "not a new customer", rather than any
  // order: somebody with a cancelled order has never actually been served.
  const completedOrderCount = await db.order.count({
    where: { customerId: referee.id, status: 'COMPLETED' },
  });

  const refusal = refusalForAttribution({
    programme,
    referrer,
    referee: {
      id: referee.id,
      alreadyReferred: existing !== null,
      completedOrderCount,
    },
  });
  if (refusal !== null || referrer === null) {
    return {
      ok: false,
      refusal: refusal ?? 'UNKNOWN_CODE',
      message: REFUSAL_TEXT[refusal ?? 'UNKNOWN_CODE'],
    };
  }

  const grantCentavos = programme.refereeCentavos;

  const run = async (tx: PrismaTransactionClient): Promise<AttributionResult> => {
    const referral = await tx.referral.create({
      data: {
        referrerId: referrer.id,
        refereeId: referee.id,
        // Verbatim as normalised, so "I used Ana's code" stays answerable even
        // after Ana's code is reissued.
        codeUsed: normaliseCode(input.code),
        status: ReferralStatus.ATTRIBUTED,
        ...(grantCentavos > 0
          ? {
              refereeGrantedCentavos: grantCentavos,
              refereeGrantedAt: new Date(),
            }
          : {}),
      },
    });

    if (grantCentavos > 0) {
      await grantCredit(
        {
          userId: referee.id,
          type: 'REFERRAL_BONUS',
          amountCentavos: grantCentavos,
          description: 'Welcome credits from an invite',
          // One grant per referral, ever, whatever retries happen above it.
          idempotencyKey: `referral-referee:${referral.id}`,
          metadata: { referralId: referral.id, referrerId: referrer.id },
        },
        tx,
      );
    }

    return {
      ok: true,
      referrerName: referrer.displayName,
      refereeGrantedCentavos: grantCentavos,
    };
  };

  if (client) return run(client);
  return prisma.$transaction(run);
}

/**
 * Reads the waiting code out of the cookie and attributes the account, then
 * clears the cookie either way.
 *
 * Cleared even on refusal, and that is deliberate: a code that cannot be used
 * will not become usable later, and leaving it in place means every future
 * onboarding on that browser retries a dead code. The one exception would be a
 * programme that is temporarily off — but "temporarily" is not knowable from
 * here, and a stale cookie attributing somebody to a campaign that ended two
 * months ago is worse than losing one attribution.
 *
 * Never throws. Signing up must not fail because somebody else's invite link
 * was stale.
 */
export async function claimReferralCookie(refereeId: string): Promise<void> {
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    const code = store.get(REFERRAL_COOKIE)?.value;
    if (!code) return;

    store.delete(REFERRAL_COOKIE);
    await attributeReferral({ refereeId, code });
  } catch {
    // No request scope, no cookie, a dead code, a refused attribution — none
    // of them is a reason somebody cannot finish signing up.
  }
}
