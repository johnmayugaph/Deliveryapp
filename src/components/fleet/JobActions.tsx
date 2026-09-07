'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { OrderStatus } from '@prisma/client';
import { abandonJobAction, advanceJobAction } from '@/lib/actions/fleet-actions';
import { statusPresentation } from '@/lib/orders/status-presentation';

/**
 * The buttons on the active job.
 *
 * `nextActions` came from the lifecycle map, so a parcel or a ride shows its
 * own steps — "Nakasakay na" for a passenger rather than "Nakuha na" — without
 * this component knowing either vertical exists. The labels below are keyed by
 * status for the same reason.
 */
const ACTION_LABELS: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.RIDER_AT_PICKUP]: 'I am at the pickup',
  [OrderStatus.SHOPPING_IN_PROGRESS]: 'Shopping now',
  [OrderStatus.AWAITING_BUDGET_APPROVAL]: 'Send the budget for approval',
  [OrderStatus.PASSENGER_ONBOARD]: 'Passenger on board',
  [OrderStatus.PICKED_UP]: 'I have the order',
  [OrderStatus.IN_TRANSIT]: 'On my way',
  [OrderStatus.ARRIVED_AT_DROPOFF]: 'I am at the dropoff',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.DROPPED_OFF]: 'Dropped off',
  [OrderStatus.FAILED_DELIVERY]: 'Could not deliver',
};

/** The step that moves the job forward, as opposed to ending it badly. */
const PROGRESS_ORDER: readonly OrderStatus[] = [
  OrderStatus.RIDER_AT_PICKUP,
  OrderStatus.SHOPPING_IN_PROGRESS,
  OrderStatus.AWAITING_BUDGET_APPROVAL,
  OrderStatus.PASSENGER_ONBOARD,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
  OrderStatus.ARRIVED_AT_DROPOFF,
  OrderStatus.DELIVERED,
  OrderStatus.DROPPED_OFF,
];

export function JobActions({
  orderId,
  nextActions,
}: {
  orderId: string;
  nextActions: OrderStatus[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  // The single forward step, and everything else offered.
  const forward = PROGRESS_ORDER.find((status) => nextActions.includes(status));
  const failure = nextActions.find((status) => status === OrderStatus.FAILED_DELIVERY);
  const canCancel = nextActions.some((status) => status.startsWith('CANCELLED'));

  function advance(to: OrderStatus) {
    setError(null);
    startTransition(async () => {
      const result = await advanceJobAction(orderId, to);
      if (result.ok) router.refresh();
      else setError(result.message);
    });
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-rose-700">
          {error}
        </p>
      ) : null}

      {forward ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => advance(forward)}
          className="w-full rounded-xl bg-brand-700 px-4 py-4 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
        >
          {isPending ? '…' : (ACTION_LABELS[forward] ?? statusPresentation(forward).label)}
        </button>
      ) : (
        <p className="rounded-xl bg-surface px-3 py-3 text-center text-xs text-ink-muted shadow-sm ring-1 ring-black/5">
          No next step. Refresh, or contact support.
        </p>
      )}

      {failure ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => advance(failure)}
          className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs font-semibold text-amber-800 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-amber-50"
        >
          {ACTION_LABELS[failure]}
        </button>
      ) : null}

      {canCancel ? (
        abandoning ? (
          <div className="rounded-xl bg-rose-50 p-3">
            <label className="block text-[11px] font-semibold text-rose-900">
              Bakit ibinabalik?
              <span className="block font-normal text-rose-800">
                Susubukan naming humanap ng ibang rider.
              </span>
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                autoFocus
                placeholder="For example: my motorcycle broke down"
                className="mt-1.5 w-full rounded-lg bg-white px-2 py-1.5 text-xs font-normal ring-1 ring-rose-200 focus:outline-none focus:ring-2 focus:ring-rose-400"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={isPending || reason.trim().length < 3}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const result = await abandonJobAction(orderId, reason);
                    if (result.ok) {
                      setAbandoning(false);
                      router.push('/fleet');
                    } else {
                      setError(result.message);
                    }
                  })
                }
                className="flex-1 rounded-lg bg-rose-600 px-2 py-2 text-xs font-bold text-white disabled:bg-ink-faint"
              >
                {isPending ? '…' : 'Ibalik ang order'}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setAbandoning(false)}
                className="flex-1 rounded-lg bg-white px-2 py-2 text-xs font-semibold ring-1 ring-rose-200"
              >
                Keep going
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={isPending}
            onClick={() => setAbandoning(true)}
            className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs font-semibold text-rose-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-rose-50"
          >
            I cannot finish this
          </button>
        )
      ) : null}
    </div>
  );
}
