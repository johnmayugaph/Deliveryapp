import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  PARTNER_PROGRAMME_OFF,
  type PartnerProgrammeFacts,
} from '@/lib/referrals/partner-policy';

/**
 * The one partner-programme row.
 *
 * Absent means OFF, which is the shipped state — the same posture as the
 * customer programme, commission at zero and surge with no bands. The amounts
 * decide what a rider costs to acquire, and that is not a decision code should
 * make on somebody's behalf.
 *
 * A separate id from `ReferralProgramme`'s because they are separate tables;
 * the string is the same because both are singletons and "default" is what a
 * one-row table's key says.
 */
export const PARTNER_PROGRAMME_ID = 'default';

export async function getPartnerProgramme(
  client?: PrismaTransactionClient,
): Promise<PartnerProgrammeFacts> {
  const db = client ?? prisma;
  const row = await db.partnerReferralProgramme.findUnique({
    where: { id: PARTNER_PROGRAMME_ID },
  });
  if (!row) return PARTNER_PROGRAMME_OFF;
  return {
    isActive: row.isActive,
    referrerCentavos: row.referrerCentavos,
    refereeCentavos: row.refereeCentavos,
    qualifyingDeliveries: row.qualifyingDeliveries,
    monthlyRewardCap: row.monthlyRewardCap,
    lifetimeRewardCap: row.lifetimeRewardCap,
  };
}
