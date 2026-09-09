import { OrderStatus, type ServiceKey } from '@prisma/client';
import { ALL_STATUS_TIMEOUTS } from '@/lib/orders/transitions';

/**
 * The clock the sweeper is running on an order, as the kitchen should see it.
 *
 * Two deadlines apply to orders sitting in this queue, both enforced by
 * `expireStaleOrders` and neither mentioned anywhere on the screen:
 *
 *  - **8 minutes** in `PENDING_MERCHANT_ACCEPTANCE`, after which the order is
 *    cancelled with *"The store did not answer within 8 minutes."* From behind
 *    the counter an order simply vanished.
 *  - **20 minutes** in `AWAITING_RIDER_ASSIGNMENT`, after which it is
 *    cancelled with *"We could not find an available rider."* That one lands
 *    on food the shop has already cooked, and is not the shop's fault or its
 *    to fix — which is exactly why it should not be a surprise.
 *
 * The card's only nod to any of this was a ring that turned amber past a
 * hardcoded **180 seconds** — a number with no relationship to the 480 the
 * sweep enforces. It warned vaguely at three minutes, said nothing at seven
 * minutes fifty, and would have been near-useless if the timeout were ever
 * shortened.
 *
 * So the deadline is READ from `ALL_STATUS_TIMEOUTS`, which is the list the
 * sweeper itself iterates, and the thresholds are fractions of whatever that
 * says. A timeout changed in the lifecycle map changes this screen with it.
 *
 * Pure: the timeout list and the enums.
 */

/** How close an order is to being cancelled out from under the shop. */
export type Urgency = 'CALM' | 'SOON' | 'CRITICAL';

/**
 * Fractions of the real deadline rather than absolute seconds, so an 8-minute
 * clock and a 20-minute one both warn in proportion.
 */
const SOON_AT = 0.5;
const CRITICAL_AT = 0.8;

export function urgencyFor(elapsedSeconds: number, deadlineSeconds: number): Urgency {
  if (deadlineSeconds <= 0) return 'CALM';
  const through = elapsedSeconds / deadlineSeconds;
  if (through >= CRITICAL_AT) return 'CRITICAL';
  if (through >= SOON_AT) return 'SOON';
  return 'CALM';
}

/**
 * Whose move it is before the clock runs out.
 *
 * The same split the settings panel makes, for the same reason: a deadline the
 * shop can beat by tapping Accept is a different message from one it can only
 * watch, and telling a kitchen to hurry up about finding a rider would be
 * both useless and insulting.
 */
export type ClockOwner = 'THE_SHOP' | 'NOBODY_HERE';

const OWNER_BY_STATUS: Partial<Record<OrderStatus, ClockOwner>> = {
  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: 'THE_SHOP',
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: 'NOBODY_HERE',
};

export interface QueueClock {
  /** The sweeper's own figure for this status, in seconds. */
  deadlineSeconds: number;
  /**
   * Seconds left, floored at zero.
   *
   * A FLOOR, not an exact figure, and deliberately so. The card measures from
   * the status-event that put the order here; the sweeper filters on
   * `updatedAt`, which any later write moves forward. So the real deadline can
   * be slightly later than this says, never earlier — the screen can
   * understate the time left but never promise time the sweep will not
   * honour. For the acceptance wait the two agree in practice, because
   * nothing writes to an order while the shop has not touched it.
   */
  remainingSeconds: number;
  urgency: Urgency;
  owner: ClockOwner;
  /** What is at stake, in one line. */
  note: string;
}

/** "6m" / "40s" — a countdown reads in whichever unit is still meaningful. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'any moment now';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * The deadline the sweeper will apply to an order in this state, or null.
 *
 * Read from its list rather than restated. Most statuses have none: an order
 * being cooked can sit in `PREPARING` indefinitely, which is a deliberate
 * choice — nothing should cancel food that a shop is actually making.
 */
export function deadlineFor(
  serviceType: ServiceKey,
  status: OrderStatus,
): number | null {
  const policy = ALL_STATUS_TIMEOUTS.find(
    (timeout) => timeout.serviceType === serviceType && timeout.status === status,
  );
  return policy?.afterSeconds ?? null;
}

function noteFor(owner: ClockOwner, remaining: number): string {
  const left = formatRemaining(remaining);
  if (owner === 'THE_SHOP') {
    return remaining <= 0
      ? 'Out of time — accept or reject it now, or TARA cancels it.'
      : `${left} left to answer. After that TARA cancels it and refunds the customer.`;
  }
  return remaining <= 0
    ? 'Still no rider. TARA may cancel and refund this at any moment.'
    : `${left} for TARA to find a rider. If nobody is found it is cancelled and refunded — nothing for you to do.`;
}

/**
 * The clock on one queued order, or null when nothing is counting down.
 *
 * Null is the ordinary case for an order being cooked, and the screen shows
 * nothing for it: a countdown on every card would make the two that matter
 * invisible.
 */
export function clockFor(input: {
  serviceType: ServiceKey;
  status: OrderStatus;
  waitingSeconds: number;
}): QueueClock | null {
  const deadlineSeconds = deadlineFor(input.serviceType, input.status);
  if (deadlineSeconds === null) return null;

  // A status with a timeout and no owner recorded is a gap in this module
  // rather than a reason to say nothing: somebody has to be told, and "nobody
  // here can act" is the safe reading — it never tells a kitchen to hurry
  // about something it cannot affect.
  const owner = OWNER_BY_STATUS[input.status] ?? 'NOBODY_HERE';
  const remainingSeconds = Math.max(0, deadlineSeconds - input.waitingSeconds);

  return {
    deadlineSeconds,
    remainingSeconds,
    urgency: urgencyFor(input.waitingSeconds, deadlineSeconds),
    owner,
    note: noteFor(owner, remainingSeconds),
  };
}

/**
 * How late the order is against the time the customer was promised.
 *
 * Null when it is not late, or when there is no promised time at all.
 *
 * Rendering a promised time without this was the remaining half of the same
 * defect: a card reading *"Promised 08:15"* at twenty to nine says nothing a
 * shop can act on, and the "+10 min" button beside it exists for exactly this
 * situation. Resolved on the server, like the rest of the clock, so the figure
 * cannot differ between the markup and the browser's own idea of the time.
 */
/**
 * Both moved to `@/lib/orders/promised`, and re-exported here so every
 * merchant caller is unchanged.
 *
 * They were written for this card and then the customer's tracking screen
 * needed the same fact — and a customer screen importing a module named for
 * the back office is the kind of dependency that looks fine until somebody
 * puts a Prisma call in it. The rule lives with the order now, not with the
 * queue.
 */
export { formatLate, lateBySeconds } from '@/lib/orders/promised';
