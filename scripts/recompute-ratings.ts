/**
 * Rebuilds every rating aggregate from the reviews.
 *
 * `Store.ratingAvg` and `FleetPartner.ratingAvg` are DERIVED — the reviews are
 * the truth — and the write path recomputes them inside the transaction that
 * changes a review, so this should never be needed. It exists for two honest
 * reasons:
 *
 *   1. `prisma/seed.ts` writes an aggregate directly for the demo fleet
 *      partner, so a seeded database starts out with numbers no review
 *      supports. Running this after a seed makes the two agree.
 *   2. An aggregate derived from rows should always be reproducible from those
 *      rows. If running this changes anything on a real database, that is a
 *      bug in the write path and this is how it gets found.
 *
 *     npm run db:ratings-recompute
 */
import { prisma } from '../src/lib/prisma';
import { recomputeAllRatings } from '../src/lib/ratings/reviews';
import { describeDatabaseHost } from '../src/lib/demo/policy';

async function main() {
  console.log('');
  console.log(`  Database: ${describeDatabaseHost(process.env.DATABASE_URL)}`);

  // Read the current values first, so this can report what it CHANGED rather
  // than only what it wrote. A recompute that says "done" tells you nothing
  // about whether anything had drifted.
  const before = await Promise.all([
    prisma.store.findMany({ select: { id: true, name: true, ratingAvg: true, ratingCount: true } }),
    prisma.fleetPartner.findMany({
      select: {
        id: true,
        ratingAvg: true,
        ratingCount: true,
        user: { select: { fullName: true, displayName: true, phone: true } },
      },
    }),
  ]);

  const totals = await recomputeAllRatings();

  const [stores, partners] = await Promise.all([
    prisma.store.findMany({ select: { id: true, ratingAvg: true, ratingCount: true } }),
    prisma.fleetPartner.findMany({ select: { id: true, ratingAvg: true, ratingCount: true } }),
  ]);
  const storeNow = new Map(stores.map((row) => [row.id, row]));
  const partnerNow = new Map(partners.map((row) => [row.id, row]));

  let drifted = 0;
  console.log('');
  for (const was of before[0]) {
    const now = storeNow.get(was.id)!;
    if (was.ratingAvg !== now.ratingAvg || was.ratingCount !== now.ratingCount) {
      drifted += 1;
      console.log(
        `  ${was.name}: ${was.ratingAvg} (${was.ratingCount})` +
          ` -> ${now.ratingAvg} (${now.ratingCount})`,
      );
    }
  }
  for (const was of before[1]) {
    const now = partnerNow.get(was.id)!;
    if (was.ratingAvg !== now.ratingAvg || was.ratingCount !== now.ratingCount) {
      drifted += 1;
      const name = was.user.displayName ?? was.user.fullName ?? was.user.phone;
      console.log(
        `  ${name} (rider): ${was.ratingAvg} (${was.ratingCount})` +
          ` -> ${now.ratingAvg} (${now.ratingCount})`,
      );
    }
  }

  console.log('');
  console.log(
    `  Recomputed ${totals.stores} store(s) and ${totals.partners} partner(s).` +
      (drifted === 0
        ? ' Nothing had drifted.'
        : ` ${drifted} were WRONG and are listed above — the write path has a bug,` +
          ' or the seed wrote them.'),
  );
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
