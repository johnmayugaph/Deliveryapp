'use client';

import { useActionState } from 'react';
import type { AdminActionResult } from '@/lib/admin/access';

/**
 * The shape every privileged control takes: a reason, then the button.
 *
 * There is one of these rather than a reason field copied into eight forms,
 * because the reason is the part that is easy to quietly drop and the part the
 * audit trail is worthless without. Making it the wrapper means an action
 * cannot be added to the console without one.
 *
 * `useActionState` rather than an onClick handler, so the result comes back as
 * a sentence rendered next to the control that caused it — and so the form
 * still submits if the bundle has not arrived, in which case the server action
 * runs and the page re-renders with the change applied.
 */

export interface ReasonFormProps {
  action: (formData: FormData) => Promise<AdminActionResult>;
  /** Fixed values the action needs: ids, the new state. */
  hidden: Readonly<Record<string, string>>;
  submitLabel: string;
  /** Shown above the field, when the control needs explaining. */
  children?: React.ReactNode;
  /** Extra inputs between the note and the reason — an amount, say. */
  extraFields?: React.ReactNode;
  placeholder?: string;
  tone?: 'default' | 'danger';
}

export function ReasonForm({
  action,
  hidden,
  submitLabel,
  children,
  extraFields,
  placeholder = 'Ticket number, or who asked and why',
  tone = 'default',
}: ReasonFormProps) {
  const [result, submit, pending] = useActionState<AdminActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null,
  );

  return (
    <form action={submit} className="space-y-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children ? <div className="text-xs leading-relaxed text-ink-muted">{children}</div> : null}
      {extraFields}

      <input
        name="reason"
        required
        minLength={8}
        maxLength={500}
        placeholder={placeholder}
        aria-label="Reason"
        className="w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-xs"
      />

      <button
        type="submit"
        disabled={pending}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
          tone === 'danger'
            ? 'bg-red-600 text-white'
            : 'bg-brand-700 text-white'
        }`}
      >
        {pending ? 'Working…' : submitLabel}
      </button>

      {result ? (
        <p
          role="status"
          className={`text-xs leading-relaxed ${
            result.ok ? 'text-emerald-700' : 'text-red-700'
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
