import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import { changePercent } from '@/lib/admin/series';
import { LANDED_STATUSES } from '@/lib/orders/transitions';

describe('change against yesterday', () => {
  it('is the percentage difference', () => {
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(50, 100)).toBe(-50);
    expect(changePercent(100, 100)).toBe(0);
  });

  /*
   * The one that matters. A dashboard showing "+100%" because yesterday was
   * zero is telling an operator something doubled; nothing doubled, and on a
   * new deployment every figure would wear a growth badge on its first day.
   * Null means the card renders no badge at all.
   */
  it('is nothing at all when there is no yesterday to compare with', () => {
    expect(changePercent(9, 0)).toBeNull();
    expect(changePercent(0, 0)).toBeNull();
  });

  it('rounds rather than trailing decimals into a badge', () => {
    expect(changePercent(101, 300)).toBe(-66);
    expect(changePercent(7, 3)).toBe(133);
  });
});

describe('what counts as a landed order', () => {
  /*
   * A rider sets DELIVERED; a sweep later promotes the same order to
   * COMPLETED (see `completeOrder`). Counting only DELIVERED — which the
   * console's service table did — means today's delivered count and today's
   * gross SHRINK as the sweep runs, on the screen whose job is saying what
   * happened today.
   */
  it('includes both the rider’s state and the swept one', () => {
    expect(LANDED_STATUSES).toContain(OrderStatus.DELIVERED);
    expect(LANDED_STATUSES).toContain(OrderStatus.COMPLETED);
  });

  it('includes nothing that is still moving or was cancelled', () => {
    for (const status of LANDED_STATUSES) {
      expect(status.startsWith('CANCELLED'), `${status} is a cancellation`).toBe(false);
    }
    expect(LANDED_STATUSES).not.toContain(OrderStatus.IN_TRANSIT);
    expect(LANDED_STATUSES).not.toContain(OrderStatus.FAILED_DELIVERY);
  });
});
