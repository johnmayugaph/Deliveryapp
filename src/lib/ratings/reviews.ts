import {
  OrderStatus,
  type OrderReview,
  type PrismaClient,
  type Prisma,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { getService } from '@/lib/services/registry';
import { storeIdFromDetails } from '@/lib/merchant/access';
import { displayNameFor } from '@/lib/auth/session';
import {
  averageStars,
  canReviewOrder,
  normaliseComment,
  parseStars,
  REVIEW_REFUSAL_MESSAGE,
  type ReviewEligibility,
} from './policy';

/**
 * Ratings, written at last.
 *
 * `Store.ratingAvg` and `FleetPartner.ratingAvg` have been read in six places
 * since the first commit — the storefront, the service listing, search, the
 * home rail, the fleet profile, and dispatch ranking — and written by nothing
 * except the seed. Every one of those was showing or scoring a zero.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: the reviews are the truth and the
 * aggregate is derived. Exactly the rule the credits ledger follows, and for a
 * related reason — `FleetPartner.ratingAvg` is what dispatch scores on, so an
 * aggregate that has drifted does not fail, it quietly offers work to the
 * wrong people and nobody can reconcile it afterwards. So the aggregate is
 * never incremented. It is recomputed from the rows, inside the same
 * transaction as the review that changed them.
 *
 * WHO CAN SEE WHAT. Two rules, enforced by which functions return what rather
 * than by remembering to redact at the call site:
 *
 *   - `storeReviews` and `partnerReviews` never return the author. A rider who
 *     can see who gave them one star also knows that person's address.
 *   - Nothing but `adminReviewFeed` returns a comment together with an
 *     identity, and nothing at all shows a comment on a public page. A
 *     free-text review on a shop page is a moderation burden and a defamation
 *     risk; the same sentence is worth a great deal to the operator and the
 *     merchant, who are the ones who can act on it.
 */

export class OrderNotReviewableError extends Error {
  constructor(readonly reason: Exclude<ReviewEligibility, { allowed: true }>['reason']) {
    super(REVIEW_REFUSAL_MESSAGE[reason]);
    this.name = 'OrderNotReviewableError';
  }
}

export class NothingRatedError extends Error {
  constructor() {
    super('Pick a rating first.');
    this.name = 'NothingRatedError';
  }
}

export class OrderNotFoundError extends Error {
  constructor() {
    super('That order could not be found.');
    this.name = 'OrderNotFoundError';
  }
}

// --- What is there to rate ---------------------------------------------------

export interface ReviewSubject {
  id: string;
  /** What the customer reads: the shop's name, or the partner's first name. */
  name: string;
}

export interface ReviewableOrder {
  orderId: string;
  orderNumber: string;
  /** Absent for a vertical with no merchant leg, or an order with no store. */
  store: ReviewSubject | null;
  /** Absent when nobody was ever dispatched. */
  partner: ReviewSubject | null;
  eligibility: ReviewEligibility;
  /** The review already left, if any. Editable while the window is open. */
  existing: OrderReview | null;
}

/**
 * What this person may rate on this order.
 *
 * `userId` is in the WHERE rather than checked afterwards, like every other
 * customer-facing read in this codebase. Whether there is a store to rate
 * comes from the REGISTRY — `requiresMerchant` — so a vertical that never
 * involves a shop offers no shop to rate without anything here knowing which
 * services exist.
 */
export async function reviewableOrder(input: {
  orderId: string;
  userId: string;
  now?: Date;
}): Promise<ReviewableOrder> {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, customerId: input.userId },
    select: {
      id: true,
      orderNumber: true,
      serviceType: true,
      status: true,
      completedAt: true,
      details: true,
      assignedRiderId: true,
      assignedRider: {
        select: { id: true, user: { select: { fullName: true, displayName: true, phone: true } } },
      },
      review: true,
    },
  });
  if (!order) throw new OrderNotFoundError();

  const service = await getService(order.serviceType);

  let store: ReviewSubject | null = null;
  if (service.requiresMerchant) {
    const storeId = storeIdFromDetails(order.details);
    if (storeId !== null) {
      const found = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, name: true },
      });
      if (found) store = { id: found.id, name: found.name };
    }
  }

  const partner: ReviewSubject | null = order.assignedRider
    ? {
        id: order.assignedRider.id,
        // First name only. The customer is rating the delivery, not filing a
        // report on a named person, and the rider's full name is not theirs to
        // hand out either.
        name: firstNameOf(displayNameFor(order.assignedRider.user)),
      }
    : null;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    store,
    partner,
    eligibility: canReviewOrder({
      status: order.status,
      completedAt: order.completedAt,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    existing: order.review,
  };
}

function firstNameOf(name: string): string {
  return name.split(' ')[0] ?? name;
}

// --- Leaving one -------------------------------------------------------------

export interface SubmitReviewInput {
  orderId: string;
  userId: string;
  /** Raw form values; parsed here. */
  storeStars?: unknown;
  partnerStars?: unknown;
  comment?: unknown;
  now?: Date;
}

/**
 * Writes the review and recomputes what it affects.
 *
 * An UPSERT on the order, so a second submission edits rather than duplicates
 * — which is what somebody who mis-tapped a star expects, and which costs
 * nothing here because the aggregate is recomputed from scratch either way.
 * The window is what stops that being an indefinite right to revise.
 *
 * A score is only stored alongside the id of what it is about. The pair is
 * always set together, which is the invariant the SQL guards deliberately do
 * NOT enforce — see `prisma/sql/order_reviews.sql` for why a check constraint
 * there made a shop with reviews undeletable.
 */
export async function submitReview(input: SubmitReviewInput): Promise<OrderReview> {
  const subjects = await reviewableOrder({
    orderId: input.orderId,
    userId: input.userId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  if (!subjects.eligibility.allowed) {
    throw new OrderNotReviewableError(subjects.eligibility.reason);
  }

  // A score for something that is not there is dropped rather than rejected:
  // the form only renders the controls that apply, so a stray value means a
  // stale page rather than a person to correct.
  const storeStars = subjects.store === null ? null : parseStars(input.storeStars);
  const partnerStars = subjects.partner === null ? null : parseStars(input.partnerStars);
  if (storeStars === null && partnerStars === null) throw new NothingRatedError();

  const comment = normaliseComment(input.comment);
  const storeId = storeStars === null ? null : subjects.store!.id;
  const fleetPartnerId = partnerStars === null ? null : subjects.partner!.id;

  return prisma.$transaction(async (tx) => {
    const review = await tx.orderReview.upsert({
      where: { orderId: input.orderId },
      create: {
        orderId: input.orderId,
        authorId: input.userId,
        storeId,
        storeStars,
        fleetPartnerId,
        partnerStars,
        comment,
      },
      update: { storeId, storeStars, fleetPartnerId, partnerStars, comment },
    });

    // Both, and both every time. An edit that moved a score from the shop to
    // the rider changes two aggregates, and recomputing only the one that was
    // just set would leave the other carrying a score it no longer has.
    const affectedStore = storeId ?? subjects.existing?.storeId ?? null;
    const affectedPartner =
      fleetPartnerId ?? subjects.existing?.fleetPartnerId ?? null;
    if (affectedStore !== null) await recomputeStoreRating(affectedStore, tx);
    if (affectedPartner !== null) await recomputePartnerRating(affectedPartner, tx);

    return review;
  });
}

// --- The aggregates ----------------------------------------------------------

/**
 * Recomputes a shop's rating from its reviews.
 *
 * Reads the scores and averages them in TypeScript rather than asking Postgres
 * for `AVG`, on purpose: it means there is exactly ONE definition of what the
 * average is — `averageStars` — and the tests cover it directly rather than
 * covering a rounding rule in SQL that happens to agree with it. The cost is a
 * column of small integers per recompute, which is nothing at a few thousand
 * reviews a shop and is the point to revisit if that ever stops being true.
 */
export async function recomputeStoreRating(
  storeId: string,
  client: PrismaTransactionClient | PrismaClient = prisma,
): Promise<{ ratingAvg: number; ratingCount: number }> {
  const rows = await client.orderReview.findMany({
    where: { storeId, storeStars: { not: null } },
    select: { storeStars: true },
  });
  const scores = rows.map((row) => row.storeStars!);
  const next = { ratingAvg: averageStars(scores), ratingCount: scores.length };
  await client.store.update({ where: { id: storeId }, data: next });
  return next;
}

export async function recomputePartnerRating(
  fleetPartnerId: string,
  client: PrismaTransactionClient | PrismaClient = prisma,
): Promise<{ ratingAvg: number; ratingCount: number }> {
  const rows = await client.orderReview.findMany({
    where: { fleetPartnerId, partnerStars: { not: null } },
    select: { partnerStars: true },
  });
  const scores = rows.map((row) => row.partnerStars!);
  const next = { ratingAvg: averageStars(scores), ratingCount: scores.length };
  await client.fleetPartner.update({ where: { id: fleetPartnerId }, data: next });
  return next;
}

/**
 * Recomputes everything.
 *
 * Not called on a request path. It exists because the seed writes aggregates
 * directly for the demo fleet partner, and because an aggregate derived from
 * rows should always be reproducible from those rows — if it ever is not, that
 * is a bug and this is how it is proved.
 */
export async function recomputeAllRatings(): Promise<{
  stores: number;
  partners: number;
}> {
  const [stores, partners] = await Promise.all([
    prisma.store.findMany({ select: { id: true } }),
    prisma.fleetPartner.findMany({ select: { id: true } }),
  ]);
  for (const store of stores) await recomputeStoreRating(store.id);
  for (const partner of partners) await recomputePartnerRating(partner.id);
  return { stores: stores.length, partners: partners.length };
}

// --- Reading them back -------------------------------------------------------

export interface AnonymousReview {
  id: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
  /** The order it was about, so a merchant can look it up. */
  orderNumber: string;
}

/** How the counts break down, for a bar chart on the merchant screen. */
export type StarBreakdown = Readonly<Record<number, number>>;

export interface ReviewSummary {
  ratingAvg: number;
  ratingCount: number;
  breakdown: StarBreakdown;
  recent: AnonymousReview[];
}

const REVIEW_SELECT = {
  id: true,
  comment: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
} satisfies Prisma.OrderReviewSelect;

/**
 * A shop's own reviews. NO AUTHOR — see the note at the top of this file.
 *
 * The order number is there instead, which is what a merchant actually needs:
 * it identifies the transaction they are being told about without identifying
 * the person, and they can look it up in their own history.
 */
export async function storeReviews(
  storeId: string,
  limit = 20,
): Promise<ReviewSummary> {
  const rows = await prisma.orderReview.findMany({
    where: { storeId, storeStars: { not: null } },
    select: { ...REVIEW_SELECT, storeStars: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const all = await prisma.orderReview.findMany({
    where: { storeId, storeStars: { not: null } },
    select: { storeStars: true },
  });
  const scores = all.map((row) => row.storeStars!);
  return {
    ratingAvg: averageStars(scores),
    ratingCount: scores.length,
    breakdown: countByStar(scores),
    recent: rows.map((row) => ({
      id: row.id,
      stars: row.storeStars!,
      comment: row.comment,
      createdAt: row.createdAt,
      orderNumber: row.order.orderNumber,
    })),
  };
}

/** A partner's own reviews. NO AUTHOR, for the same reason and more of it. */
export async function partnerReviews(
  fleetPartnerId: string,
  limit = 20,
): Promise<ReviewSummary> {
  const rows = await prisma.orderReview.findMany({
    where: { fleetPartnerId, partnerStars: { not: null } },
    select: { ...REVIEW_SELECT, partnerStars: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const all = await prisma.orderReview.findMany({
    where: { fleetPartnerId, partnerStars: { not: null } },
    select: { partnerStars: true },
  });
  const scores = all.map((row) => row.partnerStars!);
  return {
    ratingAvg: averageStars(scores),
    ratingCount: scores.length,
    breakdown: countByStar(scores),
    recent: rows.map((row) => ({
      id: row.id,
      stars: row.partnerStars!,
      comment: row.comment,
      createdAt: row.createdAt,
      orderNumber: row.order.orderNumber,
    })),
  };
}

export function countByStar(scores: readonly number[]): StarBreakdown {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const score of scores) {
    if (counts[score] !== undefined) counts[score] += 1;
  }
  return counts;
}

/**
 * Completed orders this person could still rate and has not.
 *
 * Drives the prompt on the order list. Bounded by the window rather than by a
 * count, so it empties itself: an order nobody rated stops being asked about
 * rather than accumulating into a screen of nagging.
 */
export async function unratedOrders(
  userId: string,
  now: Date = new Date(),
): Promise<{ id: string; orderNumber: string; completedAt: Date }[]> {
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const rows = await prisma.order.findMany({
    where: {
      customerId: userId,
      status: OrderStatus.COMPLETED,
      completedAt: { gte: since },
      review: null,
    },
    select: { id: true, orderNumber: true, completedAt: true },
    orderBy: { completedAt: 'desc' },
    take: 10,
  });
  return rows.flatMap((row) =>
    row.completedAt === null
      ? []
      : [{ id: row.id, orderNumber: row.orderNumber, completedAt: row.completedAt }],
  );
}

/**
 * The console's feed, and the ONE place an identity and a comment appear
 * together.
 *
 * Ordered worst first. An operator opening this needs the complaints, not a
 * chronological wall — and a one-star review with a sentence attached is the
 * most actionable thing in the whole application.
 */
export async function adminReviewFeed(limit = 40) {
  return prisma.orderReview.findMany({
    where: { OR: [{ storeStars: { lte: 3 } }, { partnerStars: { lte: 3 } }] },
    include: {
      author: { select: { id: true, fullName: true, displayName: true, phone: true } },
      store: { select: { id: true, name: true } },
      fleetPartner: {
        select: {
          id: true,
          user: { select: { id: true, fullName: true, displayName: true, phone: true } },
        },
      },
      order: { select: { orderNumber: true, serviceType: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** The numbers for the console overview. */
export async function ratingSummary(now: Date = new Date()): Promise<{
  reviews: number;
  reviewsThisWeek: number;
  lowRatings: number;
  storeAvg: number | null;
  partnerAvg: number | null;
}> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [total, thisWeek, low, storeScores, partnerScores] = await Promise.all([
    prisma.orderReview.count(),
    prisma.orderReview.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.orderReview.count({
      where: { OR: [{ storeStars: { lte: 2 } }, { partnerStars: { lte: 2 } }] },
    }),
    prisma.orderReview.findMany({
      where: { storeStars: { not: null } },
      select: { storeStars: true },
    }),
    prisma.orderReview.findMany({
      where: { partnerStars: { not: null } },
      select: { partnerStars: true },
    }),
  ]);

  return {
    reviews: total,
    reviewsThisWeek: thisWeek,
    lowRatings: low,
    storeAvg:
      storeScores.length === 0
        ? null
        : averageStars(storeScores.map((row) => row.storeStars!)),
    partnerAvg:
      partnerScores.length === 0
        ? null
        : averageStars(partnerScores.map((row) => row.partnerStars!)),
  };
}
