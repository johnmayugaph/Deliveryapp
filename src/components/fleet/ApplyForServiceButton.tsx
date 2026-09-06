'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ServiceKey } from '@prisma/client';
import { applyForServiceAction } from '@/lib/actions/fleet-actions';

/** Applies for one more service on an existing fleet record. */
export function ApplyForServiceButton({
  serviceKey,
  label,
}: {
  serviceKey: ServiceKey;
  label: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <span>
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await applyForServiceAction(serviceKey);
            if (result.ok) router.refresh();
            else setError(result.message);
          })
        }
        className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-800 transition-colors hover:bg-brand-100 disabled:opacity-60"
      >
        {isPending ? '…' : `+ ${label}`}
      </button>
      {error ? (
        <span role="alert" className="ml-1 text-[10px] text-rose-700">
          {error}
        </span>
      ) : null}
    </span>
  );
}
