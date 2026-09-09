'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { OrderStatus } from '@prisma/client';
import {
  acceptOrderAction,
  addPrepMinutesAction,
  markReadyAction,
  rejectOrderAction,
  startPreparingAction,
  type MerchantActionResult,
} from '@/lib/actions/merchant-actions';
import { formatCentavos } from '@/lib/money';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { formatLate, type QueueClock } from '@/lib/merchant/queue-clock';
import type { FoodItemSnapshot } from '@/lib/orders/details';
import { formatTimeIn } from '@/lib/time/manila';

export interface QueueCardOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  subtotalCentavos: number;
  waitingSeconds: number;
  /**
   * When the customer was promised the food, ISO.
   *
   * This field was already loaded, already passed in, and rendered NOWHERE.
   * The customer's own tracking screen shows it; the kitchen's card did not —
   * so the shop could see how long an order had been sitting and not what
   * time it had promised, and the "+10 min" button below moved that time
   * without the shop ever seeing the result of its own tap.
   */
  etaAt: string | null;
  /** Seconds past the promised time, or null when it is not late. */
  etaLateSeconds: number | null;
  /**
   * The sweeper's deadline on this order, or null when nothing is counting.
   *
   * Computed on the server from the lifecycle map's own timeout list, so this
   * component cannot invent a threshold — which is what the ring below used
   * to do, at a hardcoded 180 seconds against a real deadline of 480.
   */
  clock: QueueClock | null;
  /** Transitions the state machine says a merchant may make from here. */
  merchantActions: OrderStatus[];
  items: FoodItemSnapshot[];
  merchantNotes: string | null;
  includeCutlery: boolean;
  dropoffArea: string | null;
  /**
   * The customer's TARA status, when they have one. Just the name — a shop has
   * no use for their points or their benefits, and those are not its business.
   *
   * It is here rather than only on the Regulars tab because this is the card
   * somebody is looking at when it matters: recognising a suki is the thing a
   * carinderia has always done from behind the counter, and the app took that
   * away by putting a stranger's order number in front of them.
   */
  customerTierName: string | null;
}

/** "3m" / "1h 12m" — a kitchen reads elapsed time, not a timestamp. */
function formatWaiting(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One order in the queue.
 *
 * The buttons come from `merchantActions`, which the state machine computed —
 * this component does not decide what is possible, so a vertical with a
 * different merchant leg gets the right controls without touching it.
 */
export function OrderCard({ order }: { order: QueueCardOrder }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<MerchantActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setRejecting(false);
        setReason('');
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  const can = (status: OrderStatus) => order.merchantActions.includes(status);
  const itemCount = order.items.reduce((total, item) => total + item.quantity, 0);

  /**
   * The ring, from the real clock.
   *
   * It was a stage flag AND `waitingSeconds > 180`, a threshold with no
   * relationship to the 480 seconds the sweeper enforces — so it warned at
   * three-eighths of the way through and then said nothing more, right up to
   * the moment the order was cancelled.
   */
  const urgency = order.clock?.urgency ?? 'CALM';
  const ring =
    urgency === 'CRITICAL'
      ? 'ring-2 ring-rose-400'
      : urgency === 'SOON'
        ? 'ring-2 ring-amber-400'
        : 'ring-black/5';
  const elapsedTone =
    urgency === 'CRITICAL'
      ? 'text-rose-700'
      : urgency === 'SOON'
        ? 'text-amber-800'
        : 'text-ink-faint';

  return (
    <li className={`rounded-xl bg-surface p-3.5 shadow-sm ring-1 ${ring}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold tabular-nums">{order.orderNumber}</span>
        <span className={`text-[11px] font-semibold tabular-nums ${elapsedTone}`}>
          {formatWaiting(order.waitingSeconds)}
        </span>
      </div>

      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
        <span>
          {statusPresentation(order.status).label}
          {order.dropoffArea ? ` · ${order.dropoffArea}` : ''}
        </span>
        {order.customerTierName ? (
          /* Quiet on purpose. It is context for whoever reads it, not an
             instruction to treat this order differently — the kitchen order is
             still whatever came in first. */
          <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 ring-1 ring-brand-200">
            {order.customerTierName}
          </span>
        ) : null}
      </p>

      {/*
        The promised time, at last. A kitchen deciding what to cook first
        needs the clock on the wall, not only how long this one has been
        sitting — and it is the only way to see that "+10 min" did anything.
      */}
      {order.etaAt ? (
        <p
          className={`mt-0.5 text-[11px] ${
            order.etaLateSeconds === null ? 'text-ink-muted' : 'text-amber-800'
          }`}
        >
          Promised{' '}
          <strong className="font-semibold tabular-nums">
            {formatTimeIn(new Date(order.etaAt))}
          </strong>
          {order.etaLateSeconds === null ? null : (
            <>
              {' · '}
              <strong className="font-semibold">
                {formatLate(order.etaLateSeconds)}
              </strong>
            </>
          )}
        </p>
      ) : null}

      {order.clock ? (
        <p
          className={`mt-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold leading-relaxed ${
            order.clock.urgency === 'CRITICAL'
              ? 'bg-rose-50 text-rose-900'
              : order.clock.urgency === 'SOON'
                ? 'bg-amber-50 text-amber-900'
                : 'bg-surface-sunken text-ink-muted'
          }`}
        >
          {order.clock.note}
        </p>
      ) : null}

      <ul className="mt-2 space-y-0.5">
        {order.items.map((item) => (
          <li key={item.menuItemId} className="flex justify-between gap-2 text-xs">
            <span className="min-w-0">
              <span className="font-bold tabular-nums">{item.quantity}×</span> {item.name}
              {item.notes ? (
                <span className="mt-0.5 block text-[11px] font-medium text-amber-800">
                  {item.notes}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums text-ink-muted">
              {formatCentavos(item.lineTotalCentavos)}
            </span>
          </li>
        ))}
      </ul>

      {order.merchantNotes || order.includeCutlery ? (
        <p className="mt-2 rounded-lg bg-surface-sunken px-2 py-1.5 text-[11px] text-ink-muted">
          {order.includeCutlery ? 'Cutlery. ' : ''}
          {order.merchantNotes ?? ''}
        </p>
      ) : null}

      <p className="mt-2 flex justify-between text-xs font-semibold">
        <span>{itemCount} item{itemCount === 1 ? '' : 's'}</span>
        <span className="tabular-nums">{formatCentavos(order.subtotalCentavos)}</span>
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-rose-700">
          {error}
        </p>
      ) : null}

      {rejecting ? (
        <div className="mt-3 rounded-lg bg-rose-50 p-2.5">
          <label className="block text-[11px] font-semibold text-rose-900">
            Bakit tinanggihan?
            <span className="block font-normal text-rose-800">The customer sees this.</span>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              autoFocus
              placeholder="For example: out of adobo"
              className="mt-1.5 w-full rounded-lg bg-white px-2 py-1.5 text-xs font-normal ring-1 ring-rose-200 focus:outline-none focus:ring-2 focus:ring-rose-400"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={isPending || reason.trim().length < 3}
              onClick={() => run(() => rejectOrderAction(order.id, reason))}
              className="flex-1 rounded-lg bg-rose-600 px-2 py-2 text-xs font-bold text-white disabled:bg-ink-faint"
            >
              {isPending ? '…' : 'Reject'}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setRejecting(false)}
              className="flex-1 rounded-lg bg-white px-2 py-2 text-xs font-semibold ring-1 ring-rose-200"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {can(OrderStatus.MERCHANT_ACCEPTED) ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => acceptOrderAction(order.id))}
              className="flex-1 rounded-lg bg-brand-700 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
            >
              {isPending ? '…' : 'Accept'}
            </button>
          ) : null}

          {can(OrderStatus.PREPARING) ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => startPreparingAction(order.id))}
              className="flex-1 rounded-lg bg-brand-700 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
            >
              {isPending ? '…' : 'Start cooking'}
            </button>
          ) : null}

          {can(OrderStatus.READY_FOR_PICKUP) ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => markReadyAction(order.id))}
              className="flex-1 rounded-lg bg-emerald-700 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-emerald-800 disabled:bg-ink-faint"
            >
              {isPending ? '…' : 'Ready'}
            </button>
          ) : null}

          {can(OrderStatus.CANCELLED_BY_MERCHANT) ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => setRejecting(true)}
              className="rounded-lg bg-surface-sunken px-3 py-2.5 text-xs font-semibold text-rose-700 ring-1 ring-black/5 transition-colors hover:bg-rose-50"
            >
              Reject
            </button>
          ) : null}

          {/* Running late is honest and visible; silently missing the ETA is not. */}
          {order.status === OrderStatus.PREPARING ||
          order.status === OrderStatus.MERCHANT_ACCEPTED ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => addPrepMinutesAction(order.id, 10))}
              className="rounded-lg bg-surface-sunken px-3 py-2.5 text-xs font-semibold ring-1 ring-black/5 transition-colors hover:bg-brand-50"
            >
              +10 min
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}
