'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
 * a sentence rendered next to the control that caused it.
 *
 * **And a refresh on success, which is not optional.** The action calls
 * `revalidatePath`, but that invalidates the SERVER's copy — the page the
 * operator is looking at was rendered before the change and nothing tells it
 * otherwise, because a server action invoked from inside a client function is
 * a plain call and not a navigation. Without this, the console reads back the
 * state it had before the click: a fleet application approved a moment ago
 * still says "Pending", which is how somebody clicks the button twice and gets
 * told the decision was "already in that state".
 *
 * Found in a browser, against the production build, on the fleet screen — and
 * it applied to every control in the console, since they all come through
 * here.
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
  const router = useRouter();
  const [result, submit, pending] = useActionState<AdminActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null,
  );

  // Only on success: a refusal changed nothing, and re-rendering the page
  // under a message that explains why would scroll it out from under whoever
  // is reading it.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

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
