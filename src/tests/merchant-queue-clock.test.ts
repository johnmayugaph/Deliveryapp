import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrderStatus, ServiceKey } from '@prisma/client';
import { ALL_STATUS_TIMEOUTS } from '@/lib/orders/transitions';
import {
  clockFor,
  deadlineFor,
  formatLate,
  formatRemaining,
  lateBySeconds,
  urgencyFor,
} from '@/lib/merchant/queue-clock';
import { MERCHANT_STAGES, QUEUE_STATUSES } from '@/lib/merchant/queue';

/**
 * The clock the sweeper runs, as the kitchen sees it.
 *
 * Everything here guards one property: this screen must not invent a deadline
 * or a threshold. It had one of each — a hardcoded 180-second warning against
 * a real 480-second timeout — and the order simply vanished at the end of it.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const codeOnly = (file: string) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('where the deadline comes from', () => {
  it('is the sweeper’s own figure, not a copy of it', () => {
    /**
     * `ALL_STATUS_TIMEOUTS` is the list `expireStaleOrders` iterates. Reading
     * it means a timeout changed in the lifecycle map changes this screen with
     * it, rather than leaving a countdown that quietly disagrees with the
     * cancellation.
     */
    const policy = ALL_STATUS_TIMEOUTS.find(
      (timeout) =>
        timeout.serviceType === ServiceKey.FOOD &&
        timeout.status === OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    );
    expect(policy).toBeDefined();
    expect(deadlineFor(ServiceKey.FOOD, OrderStatus.PENDING_MERCHANT_ACCEPTANCE)).toBe(
      policy!.afterSeconds,
    );
    const clock = codeOnly('src/lib/merchant/queue-clock.ts');
    expect(clock).toMatch(/ALL_STATUS_TIMEOUTS/);
    // No number of its own anywhere near the deadline.
    expect(clock).not.toMatch(/8 \* 60|480|20 \* 60|1200/);
  });

  it('is null for a status nothing is timing', () => {
    // An order being cooked can sit in PREPARING indefinitely, deliberately:
    // nothing should cancel food a shop is actually making.
    expect(deadlineFor(ServiceKey.FOOD, OrderStatus.PREPARING)).toBeNull();
    expect(deadlineFor(ServiceKey.FOOD, OrderStatus.MERCHANT_ACCEPTED)).toBeNull();
    expect(clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PREPARING,
      waitingSeconds: 9_999,
    })).toBeNull();
  });

  it('covers every queue status the sweeper is timing', () => {
    /**
     * The check that matters if a third timeout is ever added to a status the
     * merchant queue shows: the card would say nothing about it.
     */
    const timedQueueStatuses = ALL_STATUS_TIMEOUTS.filter(
      (timeout) =>
        timeout.serviceType === ServiceKey.FOOD &&
        QUEUE_STATUSES.includes(timeout.status),
    );
    expect(timedQueueStatuses.length).toBeGreaterThanOrEqual(2);
    for (const timeout of timedQueueStatuses) {
      const clock = clockFor({
        serviceType: ServiceKey.FOOD,
        status: timeout.status,
        waitingSeconds: 0,
      });
      expect(clock, timeout.status).not.toBeNull();
      expect(clock!.deadlineSeconds, timeout.status).toBe(timeout.afterSeconds);
      expect(clock!.note.trim().length, timeout.status).toBeGreaterThan(20);
    }
  });
});

describe('how long is left', () => {
  const acceptance = deadlineFor(
    ServiceKey.FOOD,
    OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
  )!;

  it('counts down from the real deadline', () => {
    const fresh = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: 0,
    })!;
    expect(fresh.remainingSeconds).toBe(acceptance);
    const half = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: acceptance / 2,
    })!;
    expect(half.remainingSeconds).toBe(acceptance / 2);
  });

  it('floors at zero rather than counting backwards', () => {
    /**
     * The sweep runs on a cron, so an order can sit past its deadline for a
     * minute or two. "−90s left" is not a thing to show a kitchen.
     */
    const over = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: acceptance + 500,
    })!;
    expect(over.remainingSeconds).toBe(0);
    expect(over.note).toMatch(/Out of time/);
  });

  it('never promises more time than the sweeper will honour', () => {
    /**
     * The load-bearing property. The card measures from the status event that
     * put the order here; the sweeper filters on `updatedAt`, which any later
     * write moves FORWARD. So elapsed-since-entry >= elapsed-since-updatedAt,
     * and the remaining figure is therefore a floor: it can understate the
     * time left, never overstate it. Understating is the safe direction — a
     * shop that hurries needlessly loses nothing; one that is told it has two
     * minutes when it has none loses the order.
     */
    for (const extraWrites of [0, 30, 120]) {
      const shown = clockFor({
        serviceType: ServiceKey.FOOD,
        status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
        waitingSeconds: 300 + extraWrites,
      })!.remainingSeconds;
      const sweepWillAllow = acceptance - 300;
      expect(shown).toBeLessThanOrEqual(sweepWillAllow);
    }
  });

  it('reads in seconds near the end and minutes before that', () => {
    expect(formatRemaining(400)).toBe('6m');
    expect(formatRemaining(59)).toBe('59s');
    expect(formatRemaining(0)).toBe('any moment now');
    expect(formatRemaining(-10)).toBe('any moment now');
  });
});

describe('how loudly it warns', () => {
  it('takes its thresholds as fractions of the real deadline', () => {
    /**
     * The old ring fired at a fixed 180 seconds. Against 480 that is
     * three-eighths of the way through, and against a shortened timeout it
     * could have fired after the order was already gone. Proportions hold for
     * an 8-minute clock and a 20-minute one alike.
     */
    expect(urgencyFor(0, 480)).toBe('CALM');
    expect(urgencyFor(239, 480)).toBe('CALM');
    expect(urgencyFor(240, 480)).toBe('SOON');
    expect(urgencyFor(384, 480)).toBe('CRITICAL');
    // Same fractions on the twenty-minute rider clock.
    expect(urgencyFor(599, 1200)).toBe('CALM');
    expect(urgencyFor(600, 1200)).toBe('SOON');
    expect(urgencyFor(960, 1200)).toBe('CRITICAL');
  });

  it('does not divide by a deadline of zero', () => {
    expect(urgencyFor(10, 0)).toBe('CALM');
  });

  it('is calm on a fresh order and critical on a nearly dead one', () => {
    const fresh = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: 10,
    })!;
    expect(fresh.urgency).toBe('CALM');
    const dying = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: 450,
    })!;
    expect(dying.urgency).toBe('CRITICAL');
  });
});

describe('whose move it is', () => {
  it('is the shop’s on the acceptance wait, and nobody’s on the rider wait', () => {
    /**
     * The distinction worth having. A deadline the shop can beat by tapping
     * Accept is a different message from one it can only watch, and telling a
     * kitchen to hurry up about finding a rider would be useless and
     * insulting — the food is already cooked.
     */
    const shops = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      waitingSeconds: 60,
    })!;
    expect(shops.owner).toBe('THE_SHOP');
    expect(shops.note).toMatch(/left to answer/);

    const nobodys = clockFor({
      serviceType: ServiceKey.FOOD,
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      waitingSeconds: 60,
    })!;
    expect(nobodys.owner).toBe('NOBODY_HERE');
    expect(nobodys.note).toMatch(/nothing for you to do/);
    // And it says what happens, because the food is already made.
    expect(nobodys.note).toMatch(/cancelled and refunded/);
  });

  it('says what happens at zero, in both cases', () => {
    for (const status of [
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    ]) {
      const clock = clockFor({
        serviceType: ServiceKey.FOOD,
        status,
        waitingSeconds: 99_999,
      })!;
      expect(clock.remainingSeconds, status).toBe(0);
      expect(clock.note, status).toMatch(/cancel/i);
    }
  });
});

// --- what the screen does with it ----------------------------------------

describe('the card renders the clock rather than its own guess', () => {
  const card = codeOnly('src/components/merchant/OrderCard.tsx');

  it('has no threshold of its own left', () => {
    expect(card).not.toMatch(/waitingSeconds > 180/);
    expect(card).not.toMatch(/\b180\b/);
    expect(card).toMatch(/order\.clock\?\.urgency/);
  });

  it('renders the promised time, which was passed in and dropped', () => {
    /**
     * `etaAt` was in the interface, set by the page, and used nowhere in the
     * markup. So the kitchen could see how long an order had been sitting but
     * not what time it had promised — and the "+10 min" button moved that time
     * on the customer's screen with nothing to show for it here.
     */
    expect(card).toMatch(/order\.etaAt/);
    expect(card).toMatch(/toLocaleTimeString/);
  });

  it('shows the countdown note the rule wrote', () => {
    expect(card).toMatch(/order\.clock\.note/);
  });
});

describe('running late against the promised time', () => {
  const now = new Date('2026-09-09T08:40:00Z');

  it('says nothing when the order is not late', () => {
    expect(lateBySeconds(new Date('2026-09-09T08:50:00Z'), now)).toBeNull();
    expect(lateBySeconds(now, now)).toBeNull();
  });

  it('says nothing when nothing was promised', () => {
    expect(lateBySeconds(null, now)).toBeNull();
  });

  it('counts the overrun once the time has passed', () => {
    /**
     * The remaining half of the same defect. A card reading "Promised 08:15"
     * at twenty to nine says nothing a shop can act on — and the "+10 min"
     * button beside it exists for exactly this situation.
     */
    expect(lateBySeconds(new Date('2026-09-09T08:15:00Z'), now)).toBe(25 * 60);
  });

  it('reads in minutes, and never in "0m late"', () => {
    expect(formatLate(25 * 60)).toBe('25m late');
    expect(formatLate(30)).toBe('1m late');
    expect(formatLate(65 * 60)).toBe('1h 5m late');
  });

  it('is resolved on the server, from one clock for the whole render', () => {
    /**
     * Two cards disagreeing about the current time would be a rendering bug
     * nobody could reproduce, and computing it in the client component would
     * risk the markup and the browser disagreeing on first paint.
     */
    const page = codeOnly('src/app/merchant/[storeId]/page.tsx');
    expect(page).toMatch(/const renderedAt = new Date\(\)/);
    expect(page).toMatch(/etaLateSeconds: lateBySeconds\(order\.etaAt \?\? null, now\)/);
    const card = codeOnly('src/components/merchant/OrderCard.tsx');
    expect(card).not.toMatch(/new Date\(\)/);
  });
});

describe('the loader actually resolves one', () => {
  const queue = codeOnly('src/lib/merchant/queue.ts');

  it('asks the rule with each order’s own status and service', () => {
    /**
     * A mutant that returned `clock: null` for every order passed every other
     * check here — the whole feature could be switched off silently, and the
     * cards would go back to saying nothing. Resolved on the server so the
     * rule runs once, which is also why this is where it has to be pinned.
     */
    expect(queue).toMatch(/clock: clockFor\(\{/);
    expect(queue).toMatch(/serviceType: order\.serviceType/);
    expect(queue).toMatch(/status: order\.status/);
    expect(queue).toMatch(/waitingSeconds,/);
    expect(queue).not.toMatch(/clock: null/);
  });

  it('measures the wait from the event that put the order in this state', () => {
    // Not from `createdAt`: an order accepted at 12:01 has been "waiting for a
    // rider" since 12:20, not since noon.
    expect(queue).toMatch(/statusEvents\[0\]\?\.createdAt \?\? order\.updatedAt/);
  });
});

describe('the stage flag that had no reader', () => {
  it('is gone, and the arrangement is checked against the timeout list', () => {
    /**
     * `MerchantStage.isUrgent` was read by the card to decide whether to warn.
     * Once the card reads the real per-order deadline it had no reader in the
     * product at all — only a test asserting its shape, which is a check that
     * cannot matter.
     */
    const queue = codeOnly('src/lib/merchant/queue.ts');
    expect(queue).not.toMatch(/isUrgent/);
    for (const stage of MERCHANT_STAGES) {
      expect(Object.keys(stage).sort()).toEqual(['blurb', 'key', 'statuses', 'title']);
    }
  });
});
