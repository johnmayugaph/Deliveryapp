import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { PROGRAMME_OFF, type ProgrammeFacts } from '@/lib/referrals/policy';

/**
 * The one programme row.
 *
 * Absent means OFF, which is the shipped state: the amounts decide whether the
 * feature is farmable, so the code has no opinion about them and there is no
 * row until somebody sets one. Same posture as commission at zero and surge
 * with no bands.
 */
export const PROGRAMME_ID = 'default';

export async function getProgramme(
  client?: PrismaTransactionClient,
): Promise<ProgrammeFacts> {
  const db = client ?? prisma;
  const row = await db.referralProgramme.findUnique({
    where: { id: PROGRAMME_ID },
  });
  if (!row) return PROGRAMME_OFF;
  return {
    isActive: row.isActive,
    refereeCentavos: row.refereeCentavos,
    referrerCentavos: row.referrerCentavos,
    minimumOrderCentavos: row.minimumOrderCentavos,
    monthlyRewardCap: row.monthlyRewardCap,
    lifetimeRewardCap: row.lifetimeRewardCap,
  };
}
