import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  STORE_PROGRAMME_OFF,
  type StoreProgrammeFacts,
} from '@/lib/referrals/store-policy';

/**
 * The one store-programme row.
 *
 * Absent means OFF, which is the shipped state — the third table in this
 * codebase to take that posture, after the customer and rider programmes, and
 * for the same reason: the amounts decide what a shop costs to acquire, and
 * that is not a decision code should make on somebody's behalf.
 */
export const STORE_PROGRAMME_ID = 'default';

export async function getStoreProgramme(
  client?: PrismaTransactionClient,
): Promise<StoreProgrammeFacts> {
  const db = client ?? prisma;
  const row = await db.storeReferralProgramme.findUnique({
    where: { id: STORE_PROGRAMME_ID },
  });
  if (!row) return STORE_PROGRAMME_OFF;
  return {
    isActive: row.isActive,
    referrerCentavos: row.referrerCentavos,
    refereeCentavos: row.refereeCentavos,
    qualifyingEarningsCentavos: row.qualifyingEarningsCentavos,
    monthlyRewardCap: row.monthlyRewardCap,
    lifetimeRewardCap: row.lifetimeRewardCap,
  };
}
