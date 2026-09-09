'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  editMenuItemAction,
  moveMenuItemAction,
  removeMenuItemAction,
  type MenuActionResult,
} from '@/lib/actions/menu-actions';
import { setItemAvailabilityAction } from '@/lib/actions/merchant-actions';
import { formatCentavos } from '@/lib/money';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_ITEM_NAME_LENGTH,
} from '@/lib/merchant/menu-policy';
import { UNSELLABLE_REASONS, type ItemStock } from '@/lib/merchant/menu-stock';
import { menuImageHref } from '@/lib/media/image-bytes';
import { MenuPhotoControls } from '@/components/merchant/MenuPhotoControls';

export interface MenuRowItem {
  id: string;
  name: string;
  description: string | null;
  category: string;
  priceCentavos: number;
  isAvailable: boolean;
  isFirstInSection: boolean;
  isLastInSection: boolean;
  /** The id of its photograph, if it has one. Never the bytes. */
  imageId: string | null;
  /** How many questions this dish asks a customer. */
  optionGroupCount: number;
  /**
   * Whether a customer could order this right now, and if not why.
   *
   * Passed in rather than derived from `isAvailable` here, because the answer
   * is not on the row: a dish in stock whose required choice has run out is
   * refused at checkout, and only the option groups know that.
   */
  stock: ItemStock;
}

/**
 * One dish, and everything a shop can do to it.
 *
 * Two levels of control on the same row, because they are two different jobs.
 * **Availability is one tap and open to staff** — the pork runs out at lunch
 * and whoever is on the counter has to be able to say so. **Editing, moving
 * and deleting are behind a manager's access and an explicit step**, because
 * they change what the business sells rather than what is left today.
 *
 * Every control is a button with a click handler rather than a form that posts
 * on its own, which means none of them work before the page hydrates. That is
 * the same trade the rest of this application makes and it is deliberate: a
 * form posted before hydration runs with no request scope, so the session
 * cookie cannot be read and the action fails in a way nobody can act on. The
 * page carries a note saying so where it matters.
 */
export function MenuRow({
  storeId,
  item,
  canEdit,
  categories,
}: {
  storeId: string;
  item: MenuRowItem;
  canEdit: boolean;
  categories: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<MenuActionResult | null>(null);
  const [mode, setMode] = useState<'READ' | 'EDIT' | 'CONFIRM_DELETE'>('READ');

  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category);
  const [price, setPrice] = useState((item.priceCentavos / 100).toFixed(2));
  const [description, setDescription] = useState(item.description ?? '');

  function run(
    action: (previous: MenuActionResult | null, formData: FormData) => Promise<MenuActionResult>,
    fields: Record<string, string>,
    onDone?: () => void,
  ): void {
    startTransition(async () => {
      setNote(null);
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('itemId', item.id);
      for (const [key, value] of Object.entries(fields)) formData.set(key, value);

      const result = await action(null, formData);
      // A refusal stays on screen with the form still filled in; a success
      // closes the form and lets the server-rendered list speak for itself.
      if (result.ok) {
        onDone?.();
        router.refresh();
        if (!result.message.startsWith('Moved')) setNote(result);
      } else {
        setNote(result);
      }
    });
  }

  function resetForm(): void {
    setName(item.name);
    setCategory(item.category);
    setPrice((item.priceCentavos / 100).toFixed(2));
    setDescription(item.description ?? '');
  }

  return (
    <li className="bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        {/* No placeholder box where there is no photo. Most menus start with
            none, and a column of grey squares makes a text-only menu look
            broken rather than plain. */}
        {item.imageId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={menuImageHref(item.imageId)}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            className={`h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-black/5 ${
              item.isAvailable ? '' : 'opacity-50'
            }`}
          />
        ) : null}

        <span className={`min-w-0 flex-1 ${item.isAvailable ? '' : 'opacity-50'}`}>
          <span className="block text-sm font-medium">{item.name}</span>
          {item.description ? (
            <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
              {item.description}
            </span>
          ) : null}
          {/* No section name on the row: it is the heading this row sits
              under, and repeating it on every dish was noise the flat list
              needed and the grouped one does not. */}
          {/*
            The state, with how long. This said "Wala ngayon" — *not now* —
            with nothing after it, so a dish somebody marked out six weeks ago
            read exactly like one marked out at eight this evening. And a dish
            that was in stock and unorderable said nothing at all.
          */}
          {item.stock.reason === null ? null : (
            <span
              className={`mt-0.5 block text-[11px] font-semibold ${
                UNSELLABLE_REASONS[item.stock.reason].isTheShopsChoice
                  ? 'text-ink-faint'
                  : 'text-rose-700'
              }`}
            >
              {UNSELLABLE_REASONS[item.stock.reason].badge}
              {item.stock.phrase ? ` · ${item.stock.phrase}` : ''}
              {item.stock.blockedByGroups.length > 0 ? (
                <>
                  {` · ${item.stock.blockedByGroups.join(', ')} ${
                    item.stock.blockedByGroups.length === 1 ? 'has' : 'have'
                  } run out · `}
                  {/*
                    The route to the fix, stated beside the problem and NOT
                    behind `canEdit`. Found in a browser: a staff member saw
                    "Cannot be ordered · Size has run out", is allowed to put
                    an option back — `setOptionAvailabilityAction` takes STAFF,
                    like the switch on this row — and had no way to reach the
                    screen, because the only link to it sat inside the
                    manager-only block below. The obvious thing to tap instead
                    was the green "In stock" button, which would have marked
                    the whole dish out.
                  */}
                  <Link
                    href={`/merchant/${storeId}/menu/${item.id}/options`}
                    className="underline"
                  >
                    fix the choices
                  </Link>
                </>
              ) : null}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-semibold tabular-nums">
            {formatCentavos(item.priceCentavos)}
          </span>

          <button
            type="button"
            disabled={pending}
            aria-pressed={item.isAvailable}
            onClick={() =>
              startTransition(async () => {
                setNote(null);
                const result = await setItemAvailabilityAction(
                  storeId,
                  item.id,
                  !item.isAvailable,
                );
                if (result.ok) router.refresh();
                else setNote({ ok: false, message: result.message });
              })
            }
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-60 ${
              item.isAvailable
                ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                : 'bg-surface-sunken text-ink-faint hover:bg-brand-50'
            }`}
          >
            {item.isAvailable ? 'In stock' : 'Out'}
          </button>
        </span>
      </div>

      {canEdit && mode === 'READ' ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => setMode('EDIT')}
            className="text-[11px] font-semibold text-brand-700"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={pending || item.isFirstInSection}
            aria-label={`Move ${item.name} up`}
            onClick={() => run(moveMenuItemAction, { direction: 'UP' })}
            className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
          >
            ↑ Up
          </button>
          <button
            type="button"
            disabled={pending || item.isLastInSection}
            aria-label={`Move ${item.name} down`}
            onClick={() => run(moveMenuItemAction, { direction: 'DOWN' })}
            className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
          >
            ↓ Down
          </button>
          <Link
            href={`/merchant/${storeId}/menu/${item.id}/options`}
            className="text-[11px] font-semibold text-brand-700"
          >
            {item.optionGroupCount === 0
              ? 'Choices'
              : `Choices (${item.optionGroupCount})`}
          </Link>
          <button
            type="button"
            onClick={() => setMode('CONFIRM_DELETE')}
            className="ml-auto text-[11px] font-semibold text-rose-700"
          >
            Remove
          </button>
        </div>
      ) : null}

      {canEdit && mode === 'READ' ? (
        <MenuPhotoControls
          storeId={storeId}
          itemId={item.id}
          itemName={item.name}
          hasPhoto={item.imageId !== null}
        />
      ) : null}

      {canEdit && mode === 'CONFIRM_DELETE' ? (
        <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-rose-900">
            Remove <strong>{item.name}</strong> from the menu? Orders that already
            included it keep their own copy, so no receipt changes.
          </p>
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(removeMenuItemAction, { name: item.name }, () => setMode('READ'))
              }
              className="rounded-lg bg-rose-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
            >
              {pending ? 'Removing…' : 'Remove it'}
            </button>
            <button
              type="button"
              onClick={() => setMode('READ')}
              className="text-[11px] font-semibold text-ink-muted"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {canEdit && mode === 'EDIT' ? (
        <div className="mt-2 space-y-2 rounded-lg bg-surface-sunken px-3 py-2.5">
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Name</span>
            <input
              value={name}
              maxLength={MAX_ITEM_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>

          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              <span className="text-[11px] font-semibold text-ink-muted">Section</span>
              <input
                value={category}
                list={`sections-${storeId}`}
                onChange={(event) => setCategory(event.target.value)}
                className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </label>
            <label className="w-28 shrink-0">
              <span className="text-[11px] font-semibold text-ink-muted">Price</span>
              <span className="mt-0.5 flex items-center gap-1 rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-brand-500">
                <span className="text-[13px] text-ink-faint">₱</span>
                <input
                  value={price}
                  inputMode="decimal"
                  onChange={(event) => setPrice(event.target.value)}
                  className="w-full bg-transparent text-right text-[13px] tabular-nums focus:outline-none"
                />
              </span>
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">
              Description <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <textarea
              value={description}
              rows={2}
              maxLength={MAX_DESCRIPTION_LENGTH}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] leading-snug ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(editMenuItemAction, { name, category, price, description }, () =>
                  setMode('READ'),
                )
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('READ');
                resetForm();
                setNote(null);
              }}
              className="text-[11px] font-semibold text-ink-muted"
            >
              Cancel
            </button>
          </div>

          <datalist id={`sections-${storeId}`}>
            {categories.map((known) => (
              <option key={known} value={known} />
            ))}
          </datalist>
        </div>
      ) : null}

      {note ? (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`mt-1.5 text-[11px] ${note.ok ? 'text-emerald-800' : 'text-rose-700'}`}
        >
          {note.message}
        </p>
      ) : null}
    </li>
  );
}
