import { SettlementEntryType, SettlementParty } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { positionFrom, type Position } from '@/lib/settlement/policy';

/**
 * The console's view of what TARA owes and is owed.
 *
 * One query over the whole ledger, grouped in the database, then netted per
 * partner. Reads only — every decision lives behind a console action that
 * demands a reason and writes an audit row.
 */

export interface PartnerPosition {
  party: SettlementParty;
  /** The store id or the fleet partner id, whichever this row is. */
  partyId: string;
  name: string;
  phone: string | null;
  position: Position;
  /** When something last moved on this balance. */
  lastMovedAt: Date | null;
}

/**
 * Everybody with a non-zero balance, netted.
 *
 * Grouped by (party, type) in the database rather than by pulling every row
 * into memory: this table grows with completed orders forever, and a console
 * screen that reads all of it stops loading at some point in year one.
 */
export async function partnerPositions(): Promise<PartnerPosition[]> {
  const [storeGroups, riderGroups, lastMoves] = await Promise.all([
    prisma.settlementEntry.groupBy({
      by: ['storeId', 'type'],
      where: { party: SettlementParty.STORE },
      _sum: { amountCentavos: true },
    }),
    prisma.settlementEntry.groupBy({
      by: ['fleetPartnerId', 'type'],
      where: { party: SettlementParty.FLEET_PARTNER },
      _sum: { amountCentavos: true },
    }),
    prisma.settlementEntry.groupBy({
      by: ['storeId', 'fleetPartnerId'],
      _max: { createdAt: true },
    }),
  ]);

  /** Rebuild each party's rows so `positionFrom` stays the one summing rule. */
  const byParty = new Map<
    string,
    { type: SettlementEntryType; amountCentavos: number }[]
  >();
  const add = (key: string, type: SettlementEntryType, amount: number) => {
    const rows = byParty.get(key) ?? [];
    rows.push({ type, amountCentavos: amount });
    byParty.set(key, rows);
  };

  for (const row of storeGroups) {
    if (row.storeId) add(`STORE:${row.storeId}`, row.type, row._sum.amountCentavos ?? 0);
  }
  for (const row of riderGroups) {
    if (row.fleetPartnerId) {
      add(`FLEET_PARTNER:${row.fleetPartnerId}`, row.type, row._sum.amountCentavos ?? 0);
    }
  }

  const lastMovedAt = new Map<string, Date>();
  for (const row of lastMoves) {
    const key = row.storeId
      ? `STORE:${row.storeId}`
      : row.fleetPartnerId
        ? `FLEET_PARTNER:${row.fleetPartnerId}`
        : null;
    if (key && row._max.createdAt) lastMovedAt.set(key, row._max.createdAt);
  }

  const storeIds = [...byParty.keys()]
    .filter((key) => key.startsWith('STORE:'))
    .map((key) => key.slice('STORE:'.length));
  const riderIds = [...byParty.keys()]
    .filter((key) => key.startsWith('FLEET_PARTNER:'))
    .map((key) => key.slice('FLEET_PARTNER:'.length));

  const [stores, riders] = await Promise.all([
    storeIds.length
      ? prisma.store.findMany({
          where: { id: { in: storeIds } },
          select: { id: true, name: true, contactPhone: true },
        })
      : [],
    riderIds.length
      ? prisma.fleetPartner.findMany({
          where: { id: { in: riderIds } },
          select: {
            id: true,
            user: { select: { fullName: true, displayName: true, phone: true } },
          },
        })
      : [],
  ]);

  const rows: PartnerPosition[] = [];

  for (const store of stores) {
    const key = `STORE:${store.id}`;
    rows.push({
      party: SettlementParty.STORE,
      partyId: store.id,
      name: store.name,
      phone: store.contactPhone,
      position: positionFrom(byParty.get(key) ?? []),
      lastMovedAt: lastMovedAt.get(key) ?? null,
    });
  }

  for (const rider of riders) {
    const key = `FLEET_PARTNER:${rider.id}`;
    rows.push({
      party: SettlementParty.FLEET_PARTNER,
      partyId: rider.id,
      name: rider.user.displayName ?? rider.user.fullName ?? 'Rider',
      phone: rider.user.phone,
      position: positionFrom(byParty.get(key) ?? []),
      lastMovedAt: lastMovedAt.get(key) ?? null,
    });
  }

  return rows;
}

export interface SettlementOverview {
  /** Partners TARA owes, largest first: the payout run. */
  weOwe: PartnerPosition[];
  /**
   * Partners holding TARA's money, largest first. Almost always riders on
   * cash orders, and the number the cash-handling problem is about.
   */
  theyOwe: PartnerPosition[];
  /** Settled to zero. Kept out of both lists but counted. */
  squareCount: number;
  totalOwedCentavos: number;
  totalHeldCentavos: number;
}

export async function settlementOverview(): Promise<SettlementOverview> {
  const rows = await partnerPositions();

  const weOwe = rows
    .filter((row) => row.position.balanceCentavos > 0)
    .sort((a, b) => b.position.balanceCentavos - a.position.balanceCentavos);
  const theyOwe = rows
    .filter((row) => row.position.balanceCentavos < 0)
    .sort((a, b) => a.position.balanceCentavos - b.position.balanceCentavos);

  return {
    weOwe,
    theyOwe,
    squareCount: rows.length - weOwe.length - theyOwe.length,
    totalOwedCentavos: weOwe.reduce(
      (sum, row) => sum + row.position.balanceCentavos,
      0,
    ),
    totalHeldCentavos: theyOwe.reduce(
      (sum, row) => sum - row.position.balanceCentavos,
      0,
    ),
  };
}

/** Every store, for the commission screen. */
export async function storeCommissions(): Promise<
  { id: string; name: string; commissionBasisPoints: number; isVisible: boolean }[]
> {
  return prisma.store.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, commissionBasisPoints: true, isVisible: true },
  });
}
