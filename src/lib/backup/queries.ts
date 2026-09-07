import { prisma } from '@/lib/prisma';
import { backupPosture, backupStrategy, type BackupPosture } from '@/lib/backup/policy';

/**
 * What the console knows about backups.
 *
 * Kept apart from `policy.ts` so the policy stays pure and testable: this file
 * is the only part that touches the database, and everything it decides it
 * hands to `backupPosture`.
 */

export interface BackupState {
  posture: BackupPosture;
  lastSuccessAt: Date | null;
  lastVerifiedAt: Date | null;
  lastFailure: { startedAt: Date; error: string | null } | null;
  /** How many attempts have failed since the last success. */
  failuresSinceSuccess: number;
  encrypted: boolean | null;
  sizeBytes: number | null;
}

export async function backupState(now = new Date()): Promise<BackupState> {
  const [lastSuccess, lastVerified, lastFailure] = await Promise.all([
    prisma.backupRun.findFirst({
      where: { ok: true },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, encrypted: true, sizeBytes: true },
    }),
    prisma.backupRun.findFirst({
      where: { verifiedAt: { not: null } },
      orderBy: { verifiedAt: 'desc' },
      select: { verifiedAt: true },
    }),
    prisma.backupRun.findFirst({
      where: { ok: false, finishedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, error: true },
    }),
  ]);

  // Failures AFTER the last success are the ones that matter: a run that
  // failed last March and was fixed the same day is not news, and counting it
  // forever is how a warning becomes wallpaper.
  const failuresSinceSuccess = await prisma.backupRun.count({
    where: {
      ok: false,
      finishedAt: { not: null },
      ...(lastSuccess ? { startedAt: { gt: lastSuccess.startedAt } } : {}),
    },
  });

  return {
    posture: backupPosture({
      strategy: backupStrategy(),
      lastSuccessAt: lastSuccess?.startedAt ?? null,
      lastVerifiedAt: lastVerified?.verifiedAt ?? null,
      now,
    }),
    lastSuccessAt: lastSuccess?.startedAt ?? null,
    lastVerifiedAt: lastVerified?.verifiedAt ?? null,
    lastFailure: lastFailure ?? null,
    failuresSinceSuccess,
    encrypted: lastSuccess?.encrypted ?? null,
    sizeBytes: lastSuccess?.sizeBytes ?? null,
  };
}
