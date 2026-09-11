import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeOpeningHours,
  formatMinuteOfDay,
  isAcceptingOrders,
  manilaMinuteOfDay,
  parseMinuteOfDay,
  withinOpeningHours,
  withinWindow,
} from '@/lib/merchant/opening-hours';

/**
 * Posted opening hours.
 *
 * The whole rule is a pure function of the clock and four integers, which is
 * the point: a scheduled close is otherwise the kind of thing you can only
 * test by waiting for five o'clock, and the version that flips a column from
 * a cron is only as correct as its last run.
 */

/** A Manila wall-clock time, as an instant. Manila is UTC+8, always. */
function manila(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 11, hour - 8, minute));
}

const NO_SCHEDULE = {
  opensAtMinute: null,
  closesAtMinute: null,
  breakStartMinute: null,
  breakEndMinute: null,
};
/** 08:00–17:00, the example in the request. */
const NINE_TO_FIVE = { ...NO_SCHEDULE, opensAtMinute: 8 * 60, closesAtMinute: 17 * 60 };

describe('the minute of the Manila day', () => {
  it('reads a wall-clock time back', () => {
    expect(manilaMinuteOfDay(manila(0, 0))).toBe(0);
    expect(manilaMinuteOfDay(manila(8, 0))).toBe(480);
    expect(manilaMinuteOfDay(manila(23, 59))).toBe(1439);
  });

  it('stays inside the day for an instant before the epoch', () => {
    // A negative remainder here would make every comparison below meaningless.
    expect(manilaMinuteOfDay(new Date(Date.UTC(1960, 0, 1, 3, 0)))).toBe(11 * 60);
  });
});

describe('a window of the day', () => {
  it('includes its start and excludes its end', () => {
    // The sign on the door says "closes at five". At 17:00 it is shut.
    expect(withinWindow(8 * 60, 8 * 60, 17 * 60)).toBe(true);
    expect(withinWindow(17 * 60 - 1, 8 * 60, 17 * 60)).toBe(true);
    expect(withinWindow(17 * 60, 8 * 60, 17 * 60)).toBe(false);
  });

  /*
   * 18:00 to 02:00 is an ordinary carinderia, not a typo, so it is handled
   * rather than refused. Without this the shop is treated as open for the
   * twenty-two hours it is shut and closed for the eight it is trading.
   */
  it('handles a window that runs past midnight', () => {
    const from = 18 * 60;
    const to = 2 * 60;
    expect(withinWindow(20 * 60, from, to)).toBe(true);
    expect(withinWindow(1 * 60, from, to)).toBe(true);
    expect(withinWindow(2 * 60, from, to)).toBe(false);
    expect(withinWindow(12 * 60, from, to)).toBe(false);
  });

  it('is never open when the window has no length', () => {
    expect(withinWindow(9 * 60, 9 * 60, 9 * 60)).toBe(false);
  });
});

describe('posted opening hours', () => {
  it('has no opinion when no hours are posted', () => {
    // Which is how every store behaved before this existed, and is still
    // right for a shop with irregular hours.
    expect(withinOpeningHours(NO_SCHEDULE, manila(3))).toBe(true);
  });

  it('opens and closes on the posted times', () => {
    expect(withinOpeningHours(NINE_TO_FIVE, manila(7, 59))).toBe(false);
    expect(withinOpeningHours(NINE_TO_FIVE, manila(8, 0))).toBe(true);
    expect(withinOpeningHours(NINE_TO_FIVE, manila(16, 59))).toBe(true);
    expect(withinOpeningHours(NINE_TO_FIVE, manila(17, 0))).toBe(false);
  });

  it('reopens by itself the next morning', () => {
    // The behaviour a manual switch can never give: nobody has to remember.
    const nextMorning = new Date(manila(8, 0).getTime() + 24 * 60 * 60 * 1000);
    expect(withinOpeningHours(NINE_TO_FIVE, nextMorning)).toBe(true);
  });

  it('shuts for the posted break and comes back after it', () => {
    const withBreak = { ...NINE_TO_FIVE, breakStartMinute: 14 * 60, breakEndMinute: 15 * 60 };
    expect(withinOpeningHours(withBreak, manila(13, 59))).toBe(true);
    expect(withinOpeningHours(withBreak, manila(14, 30))).toBe(false);
    expect(withinOpeningHours(withBreak, manila(15, 0))).toBe(true);
  });
});

describe('whether a customer can order', () => {
  it('needs the switch AND the clock', () => {
    expect(isAcceptingOrders({ ...NINE_TO_FIVE, isOpen: true }, manila(10))).toBe(true);
    expect(isAcceptingOrders({ ...NINE_TO_FIVE, isOpen: true }, manila(20))).toBe(false);
  });

  /*
   * The reason the two are kept apart rather than collapsed into one column:
   * a shop closing early on a dead Tuesday should not have to edit the hours
   * it posts, and should still reopen on its own in the morning.
   */
  it('lets the shop close early without touching its posted hours', () => {
    expect(isAcceptingOrders({ ...NINE_TO_FIVE, isOpen: false }, manila(10))).toBe(false);
  });

  it('leaves a shop with no schedule entirely on its own switch', () => {
    expect(isAcceptingOrders({ ...NO_SCHEDULE, isOpen: true }, manila(3))).toBe(true);
    expect(isAcceptingOrders({ ...NO_SCHEDULE, isOpen: false }, manila(12))).toBe(false);
  });
});

describe('reading and writing the times', () => {
  it('round-trips a time of day', () => {
    for (const text of ['00:00', '08:00', '17:30', '23:59']) {
      expect(formatMinuteOfDay(parseMinuteOfDay(text)!)).toBe(text);
    }
  });

  it('refuses what is not a time, rather than guessing', () => {
    for (const text of ['', '8', '8:00pm', '24:00', '12:60', 'noon', '--:--']) {
      expect(parseMinuteOfDay(text), text).toBeNull();
    }
  });

  it('describes the hours, including the break', () => {
    expect(describeOpeningHours(NO_SCHEDULE)).toBeNull();
    expect(describeOpeningHours(NINE_TO_FIVE)).toBe('08:00–17:00');
    expect(
      describeOpeningHours({ ...NINE_TO_FIVE, breakStartMinute: 840, breakEndMinute: 900 }),
    ).toBe('08:00–17:00, closed 14:00–15:00');
  });
});

describe('every gate that refuses a closed shop also applies the clock', () => {
  function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  }

  /*
   * The failure this prevents is specific and quiet: a shop greyed out on the
   * listing that still takes an order at checkout. The two answers come from
   * different files, and only one of them costs anything to get wrong.
   */
  it('checkout refuses an order outside the posted hours', () => {
    const code = source('src/lib/orders/place-order.ts');
    expect(code).toContain('withinOpeningHours');
    // Next to the switch it already checks, not somewhere a later edit could
    // reorder it behind a return.
    const openGate = code.indexOf('!store.isOpen');
    const hoursGate = code.indexOf('withinOpeningHours(store');
    expect(openGate).toBeGreaterThan(-1);
    expect(hoursGate).toBeGreaterThan(openGate);
    expect(hoursGate - openGate).toBeLessThan(600);
  });

  it("the shop's own app can say why it is shut", () => {
    // Without this the merchant sees an emerald Bukas, an open kitchen and no
    // orders — the exact gap storefront-policy.ts was written to close.
    const policy = source('src/lib/merchant/storefront-policy.ts');
    expect(policy).toContain('OUTSIDE_OPENING_HOURS');
    const gather = source('src/lib/merchant/storefront.ts');
    expect(gather).toContain('withinOpeningHours');
  });

  it('the customer listings and the store page apply it too', () => {
    expect(source('src/lib/services/service-page-data.ts')).toContain('isAcceptingOrders');
    expect(source('src/app/stores/[slug]/page.tsx')).toContain('isAcceptingOrders');
  });

  /*
   * No cron, on purpose. A swept column is only as correct as the last job
   * run: a missed sweep leaves a shop taking orders at 3am, and nothing in the
   * row says which writer touched it last.
   */
  it('is derived rather than swept into a column by a job', () => {
    const maintenance = source('scripts/run-order-maintenance.ts');
    expect(maintenance).not.toContain('opensAtMinute');
    expect(maintenance).not.toContain('isOpen:');
  });
});
