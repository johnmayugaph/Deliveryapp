import Link from 'next/link';
import { OrderStatus } from '@prisma/client';
import { formatDateTimeIn } from '@/lib/time/manila';

/**
 * The console's small vocabulary of shapes.
 *
 * Extracted because seven pages want the same card, the same table and the
 * same status pill, and because a console whose tables are each slightly
 * different is a console people misread.
 */

export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-surface shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-black/5 px-4 py-3">
        <div>
          <h2 className="text-[13px] font-bold">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {note ? <p className="mt-0.5 text-[11px] text-ink-faint">{note}</p> : null}
    </div>
  );
}

/** A table that scrolls sideways rather than making the page do it. */
export function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

export function Th({
  children,
  numeric,
}: {
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-black/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted ${
        numeric ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  muted,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`border-b border-black/5 px-4 py-2 align-top ${
        numeric ? 'text-right tabular-nums' : ''
      } ${muted ? 'text-ink-muted' : ''}`}
    >
      {children}
    </td>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-xs text-ink-muted">{children}</p>;
}

/**
 * How an order status reads at a glance.
 *
 * A lookup over every member of the enum, so a new status is a compile error
 * here rather than an unstyled grey pill nobody notices. Three groups: waiting
 * on somebody, moving, and finished — which is the only distinction an operator
 * scanning a list actually needs.
 */
type StatusTone = 'waiting' | 'moving' | 'done' | 'bad';

const STATUS_TONE: Readonly<Record<OrderStatus, StatusTone>> = {
  [OrderStatus.DRAFT]: 'waiting',
  [OrderStatus.PENDING_PAYMENT]: 'waiting',
  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: 'waiting',
  [OrderStatus.MERCHANT_ACCEPTED]: 'moving',
  [OrderStatus.PREPARING]: 'moving',
  [OrderStatus.READY_FOR_PICKUP]: 'waiting',
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: 'waiting',
  [OrderStatus.RIDER_ASSIGNED]: 'moving',
  [OrderStatus.RIDER_AT_PICKUP]: 'moving',
  [OrderStatus.SHOPPING_IN_PROGRESS]: 'moving',
  [OrderStatus.AWAITING_BUDGET_APPROVAL]: 'waiting',
  [OrderStatus.PASSENGER_ONBOARD]: 'moving',
  [OrderStatus.PICKED_UP]: 'moving',
  [OrderStatus.IN_TRANSIT]: 'moving',
  [OrderStatus.ARRIVED_AT_DROPOFF]: 'moving',
  [OrderStatus.DELIVERED]: 'done',
  [OrderStatus.DROPPED_OFF]: 'done',
  [OrderStatus.COMPLETED]: 'done',
  [OrderStatus.FAILED_DELIVERY]: 'bad',
  [OrderStatus.CANCELLED_BY_CUSTOMER]: 'bad',
  [OrderStatus.CANCELLED_BY_MERCHANT]: 'bad',
  [OrderStatus.CANCELLED_BY_RIDER]: 'bad',
  [OrderStatus.CANCELLED_BY_SYSTEM]: 'bad',
};

const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  waiting: 'bg-amber-100 text-amber-900',
  moving: 'bg-brand-100 text-brand-800',
  done: 'bg-emerald-100 text-emerald-900',
  bad: 'bg-red-100 text-red-900',
};

/** Human-readable, from the enum member. No per-status copy to maintain. */
export function humaniseEnum(value: string): string {
  const words = value.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusPill({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
        TONE_CLASSES[STATUS_TONE[status]]
      }`}
    >
      {humaniseEnum(status)}
    </span>
  );
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const classes = {
    neutral: 'bg-surface-sunken text-ink-muted',
    good: 'bg-emerald-100 text-emerald-900',
    warn: 'bg-amber-100 text-amber-900',
    bad: 'bg-red-100 text-red-900',
  }[tone];
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${classes}`}
    >
      {children}
    </span>
  );
}

export function PersonLink({
  user,
}: {
  user: { id: string; fullName?: string | null; displayName?: string | null; phone: string };
}) {
  return (
    <Link href={`/admin/users/${user.id}`} className="font-medium text-brand-700 hover:underline">
      {user.fullName ?? user.displayName ?? user.phone}
    </Link>
  );
}

/** Manila time, to the minute. Every timestamp in the console reads the same. */
export function manilaTime(at: Date): string {
  return formatDateTimeIn(at);
}

/**
 * A headline figure with its trend beside it.
 *
 * The `change` is against the same figure yesterday, and it is NULL rather
 * than a percentage when yesterday was zero — "+100%" on a first order is a
 * number that means nothing and reads like growth.
 *
 * `note` is always rendered, including when it says nothing is wrong. A
 * caption that only appears when there is a problem is one nobody learns to
 * read, which is the same rule the support and fleet figures already follow.
 */
export function KpiCard({
  label,
  value,
  note,
  change,
  chart,
}: {
  label: string;
  value: string;
  note: string;
  /** Percentage change on yesterday, or null when there is nothing to compare. */
  change?: number | null;
  /** A sparkline, where the figure has a history worth a line. */
  chart?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
          {label}
        </p>
        {change !== undefined && change !== null ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
              change >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-brand-50 text-brand-700'
            }`}
          >
            {change >= 0 ? '+' : ''}
            {change}% <span className="font-medium">vs yest.</span>
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-[26px] font-bold leading-none tabular-nums">{value}</p>

      {chart ? <div className="mt-3 text-brand-500">{chart}</div> : null}

      <p className="mt-auto pt-2 text-[11px] text-ink-faint">{note}</p>
    </div>
  );
}
