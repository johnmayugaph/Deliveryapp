import { PrismaClient } from '@prisma/client';

/**
 * A single PrismaClient across hot reloads. Next.js dev recreates modules on
 * every edit; without this the process accumulates connection pools until
 * Postgres refuses new ones.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * The subset of PrismaClient that also exists on a transaction client. Backend
 * functions accept this so they can be composed inside a caller's transaction
 * — which is how the wallet ledger and the state machine stay atomic.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
