import {
  Prisma,
  SettlementEntryType,
  SettlementParty,
  type SettlementEntry,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  InvalidSettlementEntryError,
  arisesFromOneOrder,
  isAccrual,
  payableCentavos,
  positionFrom,
  referenceIsRequired,
  signedSettlementAmount,
  type Position,
} from '@/lib/settlement/policy';

export { InvalidSettlementEntryError } from '@/lib/settlement/policy';

/** Which partner a row belongs to. Exactly one, checked here and in SQL. */
export type PartyRef =
  | { party: 'STORE'; storeId: string }
  | { party: 'FLEET_PARTNER'; fleetPartnerId: string };

export interface RecordSettlementInput {
  ref: PartyRef;
  type: SettlementEntryType;
  /** A magnitude, except for ADJUSTMENT which is signed. */
  amountCentavos: number;
  /** Partner-visible line in their statement. */
  description: string;
  orderId?: string | null;
  /** Required for a payout, a remittance or an adjustment. */
  reference?: string | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface SettlementResult {
  entry: SettlementEntry;
  position: Position;
  replayed: boolean;
}

export class PayoutExceedsBalanceError extends Error {
  constructor(
    readonly requestedCentavos: number,
    readonly payableCentavos: number,
  ) {
    super(
      `That payout is ${requestedCentavos} centavos and only ${payableCentavos} ` +
        'is owed. Paying past the balance is an unrecorded loan the next ' +
        'accrual would silently swallow — record an ADJUSTMENT with a reason ' +
        'if that is really what happened.',
    );
    this.name = 'PayoutExceedsBalanceError';
  }
}

/**
 * THE ONLY function in this codebase that changes what a partner is owed.
 *
 * The third of its kind, and the same shape as the other two: append a row,
 * derive everything from the rows. One function so the invariants have one
 * place to live and a future payout screen cannot invent a fourth way to move
 * a balance.
 *
 * Serializable, because a payout has to read the balance and write against it
 * without a concurrent accrual landing in between — two administrators paying
 * the same rider at once is exactly how somebody gets paid twice.
 */
export async function recordSettlementEntry(
  input: RecordSettlementInput,
  client?: PrismaTransactionClient,
): Promise<SettlementResult> {
  const run = async (tx: PrismaTransactionClient): Promise<SettlementResult> => {
    const reference = input.reference?.trim() ?? '';
    if (referenceIsRequired(input.type) && reference.length < 3) {
      throw new InvalidSettlementEntryError(
        `${input.type} requires a reference: nothing in this app can move money, ` +
          'so the reference is the only thing that makes the claim checkable ' +
          'against a statement later.',
      );
    }
    if (!isAccrual(input.type) && !input.actorUserId) {
      throw new InvalidSettlementEntryError(
        `${input.type} requires an actor — an untraceable claim about money is ` +
          'how a ledger stops being evidence.',
      );
    }
    if (arisesFromOneOrder(input.type) && !input.orderId) {
      throw new InvalidSettlementEntryError(
        `${input.type} arises from an order and must name it`,
      );
    }
    if (!input.description.trim()) {
      throw new InvalidSettlementEntryError(
        'Every entry needs a description — it is the line the partner reads',
      );
    }

    // Idempotent replay: a completion that runs twice pays once.
    if (input.idempotencyKey) {
      const existing = await tx.settlementEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return {
          entry: existing,
          position: await positionOf(refOf(existing), tx),
          replayed: true,
        };
      }
    }

    const signedAmount = signedSettlementAmount(input.type, input.amountCentavos);

    // A payout may not exceed what is owed. Read inside the transaction, so a
    // concurrent accrual cannot make this stale.
    if (input.type === SettlementEntryType.PAYOUT_SENT) {
      const position = await positionOf(input.ref, tx);
      const ceiling = payableCentavos(position);
      if (-signedAmount > ceiling) {
        throw new PayoutExceedsBalanceError(-signedAmount, ceiling);
      }
    }

    const entry = await tx.settlementEntry.create({
      data: {
        party:
          input.ref.party === 'STORE'
            ? SettlementParty.STORE
            : SettlementParty.FLEET_PARTNER,
        storeId: input.ref.party === 'STORE' ? input.ref.storeId : null,
        fleetPartnerId:
          input.ref.party === 'FLEET_PARTNER' ? input.ref.fleetPartnerId : null,
        type: input.type,
        amountCentavos: signedAmount,
        orderId: input.orderId ?? null,
        description: input.description.trim(),
        reference: reference || null,
        actorUserId: input.actorUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? undefined,
      },
    });

    return { entry, position: await positionOf(input.ref, tx), replayed: false };
  };

  if (client) return run(client);
  return prisma.$transaction(run, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

/** The party a stored row belongs to. */
function refOf(entry: Pick<SettlementEntry, 'party' | 'storeId' | 'fleetPartnerId'>): PartyRef {
  if (entry.party === SettlementParty.STORE) {
    return { party: 'STORE', storeId: entry.storeId! };
  }
  return { party: 'FLEET_PARTNER', fleetPartnerId: entry.fleetPartnerId! };
}

function whereFor(ref: PartyRef): Prisma.SettlementEntryWhereInput {
  return ref.party === 'STORE'
    ? { storeId: ref.storeId }
    : { fleetPartnerId: ref.fleetPartnerId };
}

/**
 * A partner's position, summed from the ledger.
 *
 * Never cached, unlike a credits balance. `Wallet` caches because spending has
 * to check a balance atomically before allowing a debit and the check is on
 * the hot path of every checkout; this is read by a console screen and a
 * partner's own statement, where a summed query is cheaper than a column that
 * can drift out of step with the rows that define it.
 */
export async function positionOf(
  ref: PartyRef,
  client?: PrismaTransactionClient,
): Promise<Position> {
  const db = client ?? prisma;
  const entries = await db.settlementEntry.findMany({
    where: whereFor(ref),
    select: { type: true, amountCentavos: true },
  });
  return positionFrom(entries);
}

/**
 * The most recent payout to a partner, whenever it happened.
 *
 * A dedicated query rather than a scan of the statement the screen already
 * has: the statement is capped at sixty lines, and a busy shop's last payout
 * is easily older than its last sixty orders. Deriving it from the visible
 * window would have told exactly the shops with the most orders that they had
 * never been paid.
 */
export async function lastPayout(
  ref: PartyRef,
  client?: PrismaTransactionClient,
): Promise<SettlementEntry | null> {
  const db = client ?? prisma;
  return db.settlementEntry.findFirst({
    where: { ...whereFor(ref), type: SettlementEntryType.PAYOUT_SENT },
    orderBy: { createdAt: 'desc' },
  });
}

/** A partner's statement, newest first. */
export async function statementFor(
  ref: PartyRef,
  limit = 100,
): Promise<SettlementEntry[]> {
  return prisma.settlementEntry.findMany({
    where: whereFor(ref),
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
