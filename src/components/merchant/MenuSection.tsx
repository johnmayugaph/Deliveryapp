'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  moveCategoryAction,
  renameCategoryAction,
  type MenuActionResult,
} from '@/lib/actions/menu-actions';
import { MAX_CATEGORY_LENGTH } from '@/lib/merchant/menu-policy';

/**
 * A section heading, and the two things a shop wants to do to one.
 *
 * Moving a section is the whole reason this component exists. Sections used to
 * render alphabetically, which put "Add-ons" above "Rice meals" on every menu
 * in the country — and no shop wants their extra rice listed first. The order
 * is now the shop's own, and this is where they set it.
 *
 * Renaming is here rather than on each row because a section's name lives on
 * every item in it: typing a new name on one dish would move that dish to a
 * new section instead of renaming the one it is in, which is a different
 * thing and a confusing way to discover it.
 */
export function MenuSection({
  storeId,
  category,
  count,
  isFirst,
  isLast,
  canEdit,
  children,
}: {
  storeId: string;
  category: string;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  canEdit: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<MenuActionResult | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(category);

  const headingId = `section-${category.replace(/\W+/g, '-').toLowerCase()}`;

  function run(
    action: (previous: MenuActionResult | null, formData: FormData) => Promise<MenuActionResult>,
    fields: Record<string, string>,
    onDone?: () => void,
  ): void {
    startTransition(async () => {
      setNote(null);
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('category', category);
      for (const [key, value] of Object.entries(fields)) formData.set(key, value);

      const result = await action(null, formData);
      if (result.ok) {
        onDone?.();
        router.refresh();
        if (!result.message.startsWith('Moved')) setNote(result);
      } else {
        setNote(result);
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="mt-3">
      <div className="flex items-baseline justify-between gap-2 px-4 pb-1">
        <h2
          id={headingId}
          className="min-w-0 truncate text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          {category}
          <span className="ml-1.5 font-normal normal-case tracking-normal text-ink-faint">
            {count}
          </span>
        </h2>

        {canEdit && !renaming ? (
          <span className="flex shrink-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="text-[11px] font-semibold text-brand-700"
            >
              Rename
            </button>
            <button
              type="button"
              disabled={pending || isFirst}
              aria-label={`Move the ${category} section up`}
              onClick={() => run(moveCategoryAction, { direction: 'UP' })}
              className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
            >
              ↑
            </button>
            <button
              type="button"
              disabled={pending || isLast}
              aria-label={`Move the ${category} section down`}
              onClick={() => run(moveCategoryAction, { direction: 'DOWN' })}
              className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
            >
              ↓
            </button>
          </span>
        ) : null}
      </div>

      {canEdit && renaming ? (
        <div className="mx-4 mb-1.5 flex items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-2">
          <input
            value={name}
            aria-label={`New name for the ${category} section`}
            maxLength={MAX_CATEGORY_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => run(renameCategoryAction, { name }, () => setRenaming(false))}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setRenaming(false);
              setName(category);
              setNote(null);
            }}
            className="text-[11px] font-semibold text-ink-muted"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {note ? (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`px-4 pb-1 text-[11px] ${note.ok ? 'text-emerald-800' : 'text-rose-700'}`}
        >
          {note.message}
        </p>
      ) : null}

      <ul className="divide-y divide-black/5">{children}</ul>
    </section>
  );
}
