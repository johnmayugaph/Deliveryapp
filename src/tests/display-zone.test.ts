import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_OFFSET_MS,
  DISPLAY_ZONE,
  dayKeyIn,
  formatDayIn,
  formatFullDayIn,
  formatTimeIn,
  sameDayIn,
  startOfDayIn,
} from '@/lib/time/manila';
import { startOfManilaDay } from '@/lib/admin/queries';
import { monthStart } from '@/lib/referrals/rewards';

/**
 * The zone every date is rendered in.
 *
 * These tests exist because a unit test written for the tracking screen caught
 * the app rendering every time in the HOST's zone. `toLocaleTimeString('en-PH',
 * …)` picks the locale, not the zone; with `TZ` unset a container runs in UTC,
 * and 7:30pm in Manila renders as 11:30am. The whole suite would have passed.
 */

describe('the formatters pin the zone', () => {
  it('renders a moment in Manila, not in the host zone', () => {
    /**
     * THE test. 15:50 UTC is 11:50 PM in Manila. Before this module the
     * screen said 03:50 PM, because the process was in UTC — and it would
     * have said something else again on a laptop in Lisbon.
     */
    const at = new Date('2026-09-08T15:50:00Z');
    expect(formatTimeIn(at)).toBe('11:50 PM');
    expect(formatTimeIn(at)).not.toBe('03:50 PM');
  });

  it('does not drift when the host zone changes', () => {
    // Pinned by construction: the option is passed, so there is nothing for a
    // host zone to influence. Asserted rather than assumed, because the
    // failure mode is silent.
    const at = new Date('2026-01-15T20:00:00Z'); // 04:00 next day in Manila
    const before = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'Europe/Lisbon']) {
        process.env.TZ = zone;
        expect(formatTimeIn(at)).toBe('04:00 AM');
        expect(dayKeyIn(at)).toBe('2026-01-16');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('names the zone and the offset explicitly', () => {
    expect(DISPLAY_ZONE).toBe('Asia/Manila');
    expect(DISPLAY_OFFSET_MS).toBe(8 * 60 * 60 * 1000);
  });

  it('formats a day and a full day', () => {
    const at = new Date('2026-09-08T16:20:00Z'); // 00:20 on the 9th, Manila
    /* The load-bearing part is the DAY NUMBER: 9, not the 8th it would be in
       UTC. The word order is whatever en-PH does ("Sep 9"), and asserting my
       guess at it rather than its actual output is how this expectation was
       wrong the first time. */
    expect(formatDayIn(at)).toBe('Sep 9');
    expect(formatDayIn(at)).toContain('9');
    expect(formatFullDayIn(at)).toBe('Sep 9, 2026');
  });
});

describe('the Manila day boundary', () => {
  it('rolls at 16:00 UTC', () => {
    // The whole reason a UTC-day comparison was wrong.
    expect(dayKeyIn(new Date('2026-09-08T15:59:59Z'))).toBe('2026-09-08');
    expect(dayKeyIn(new Date('2026-09-08T16:00:00Z'))).toBe('2026-09-09');
  });

  it('puts an order placed 23:50 and delivered 00:20 on two days', () => {
    expect(
      sameDayIn(
        new Date('2026-09-08T15:50:00Z'),
        new Date('2026-09-08T16:20:00Z'),
      ),
    ).toBe(false);
  });

  it('puts a whole Manila working day on one', () => {
    expect(
      sameDayIn(
        new Date('2026-09-08T16:30:00Z'), // 00:30
        new Date('2026-09-09T15:30:00Z'), // 23:30 the same day
      ),
    ).toBe(true);
  });

  it('gives midnight in Manila, which is 16:00 UTC the day before', () => {
    const start = startOfDayIn(new Date('2026-09-09T06:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-08T16:00:00.000Z');
  });
});

describe('agreeing with the three places that already got this right', () => {
  /**
   * `startOfManilaDay` and `monthStart` were written independently before this
   * module existed. Consolidating means agreeing with them, not replacing
   * them with something subtly different — so this pins the agreement across
   * a spread of moments including both sides of the boundary.
   */
  const moments = [
    '2026-01-01T00:00:00Z',
    '2026-09-08T15:59:59Z',
    '2026-09-08T16:00:00Z',
    '2026-09-09T06:00:00Z',
    '2026-12-31T23:59:59Z',
  ].map((iso) => new Date(iso));

  it.each(moments.map((m) => [m.toISOString(), m] as const))(
    'startOfDayIn matches startOfManilaDay at %s',
    (_iso, at) => {
      expect(startOfDayIn(at).getTime()).toBe(startOfManilaDay(at).getTime());
    },
  );

  it('the month boundary sits on a Manila day boundary', () => {
    for (const at of moments) {
      const start = monthStart(at);
      expect(startOfDayIn(start).getTime()).toBe(start.getTime());
      expect(dayKeyIn(start).endsWith('-01')).toBe(true);
    }
  });
});

describe('the tracking screen renders through it', () => {
  const page = readFileSync('src/app/orders/[orderId]/page.tsx', 'utf8');

  it('reaches every date through the pinned formatters', () => {
    expect(page).toMatch(/formatTimeIn/);
    expect(page).toMatch(/formatDayIn/);
    // No bare locale call left to render in the host's zone.
    expect(page).not.toMatch(/toLocaleTimeString/);
    expect(page).not.toMatch(/toLocaleDateString/);
  });

  it('compares days in Manila', () => {
    expect(page).toMatch(/dayKeyIn/);
  });
});

describe('the module stays pure', () => {
  it('imports nothing at all', () => {
    const source = readFileSync('src/lib/time/manila.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
