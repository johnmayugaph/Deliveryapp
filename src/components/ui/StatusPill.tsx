import type { OrderStatus } from '@prisma/client';
import { statusPresentation } from '@/lib/orders/status-presentation';

const TONE_CLASSES = {
  pending: 'bg-amber-50 text-amber-800',
  active: 'bg-brand-50 text-brand-800',
  done: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-rose-50 text-rose-800',
} as const;

/** Status label for any vertical. Keyed by status, never by service. */
export function StatusPill({ status }: { status: OrderStatus }) {
  const { label, tone } = statusPresentation(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
