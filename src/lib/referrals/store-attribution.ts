import { ReferralStatus } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { positionOf } from '@/lib/settlement/ledger';
import { getStoreProgramme } from '@/lib/referrals/store-programme';
import {
  STORE_REFUSAL_TEXT,
  refusalForStoreAttribution,
  type StoreAttributionRefusal,
} from '@/lib/referrals/store-policy';

/**
 * Recording which shop introduced which shop.
 *
 * The one referral attribution in this app that a PERSON makes. There is no
 * code and no cookie: an administrator, talking to both shops, picks the
 * referring one from a list and says why. See `store-policy.ts` for why that
 * is the only honest shape available — a shop does not sign itself up.
 *
 * Which changes what this function owes its caller. The rider version returns
 * a refusal that the application form deliberately ignores, because a bad code
 * must not cost somebody their application. Here the refusal is the WHOLE
 * point: it is shown to the person who typed it, because they are asserting
 * something and can be wrong about it.
 */

export type StoreAttributionResult =
  | { ok: true; referrerName: string; refereeName: string }
  | { ok: false; refusal: StoreAttributionRefusal; message: string };

/**
 * Attributes a shop to another shop.
 *
 * `earnedCentavos` for the new shop is read from the SETTLEMENT LEDGER rather
 * than from an order count, which is what `ALREADY_TRADING` needs to be true
 * about: a shop that has earned anything through TARA was trading before this
 * introduction was recorded, whatever the order table says about cancelled or
 * pending orders.
 */
export async function attributeStoreReferral(
  input: {
    refereeStoreId: string;
    referrerStoreId: string;
    attributedById: string;
    note: string;
  },
  client?: PrismaTransactionClient,
): Promise<StoreAttributionResult> {
  const db = client ?? prisma;
  const programme = await getStoreProgramme(db);

  const [referrer, referee, existing] = await Promise.all([
    db.store.findUnique({
      where: { id: input.referrerStoreId },
      select: { id: true, name: true, isVisible: true },
    }),
    db.store.findUniqueOrThrow({
      where: { id: input.refereeStoreId },
      select: { id: true, name: true },
    }),
    db.storeReferral.findUnique({
      where: { refereeStoreId: input.refereeStoreId },
      select: { id: true },
    }),
  ]);

  const position = await positionOf(
    { party: 'STORE', storeId: input.refereeStoreId },
    db,
  );

  const refusal = refusalForStoreAttribution({
    programme,
    referrer: referrer
      ? { storeId: referrer.id, isVisible: referrer.isVisible }
      : null,
    referee: {
      storeId: referee.id,
      alreadyAttributed: existing !== null,
      earnedCentavos: position.earnedCentavos,
    },
  });

  if (refusal !== null || !referrer) {
    const named = refusal ?? 'SAME_STORE';
    return { ok: false, refusal: named, message: STORE_REFUSAL_TEXT[named] };
  }

  await db.storeReferral.create({
    data: {
      referrerStoreId: referrer.id,
      refereeStoreId: referee.id,
      attributedById: input.attributedById,
      attributionNote: input.note.trim().slice(0, 500),
      status: ReferralStatus.ATTRIBUTED,
    },
  });

  return { ok: true, referrerName: referrer.name, refereeName: referee.name };
}
