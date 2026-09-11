'use client';

import { useActionState, useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminActionResult } from '@/lib/admin/access';
import {
  addStoreMenuItemAction,
  uploadStoreMenuItemImageAction,
} from '@/lib/actions/admin-actions';
import { downscalePhoto } from '@/lib/media/downscale';
import { formatCentavos } from '@/lib/money';

const FIELD =
  'mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-[13px]';

export interface ConsoleMenuItem {
  id: string;
  name: string;
  category: string;
  description: string | null;
  priceCentavos: number;
  compareAtPriceCentavos: number | null;
  isAvailable: boolean;
  imageHref: string | null;
}

/**
 * A shop's menu, on the console's own store page.
 *
 * WHY THIS IS HERE. A store cannot be made Active without a menu — a customer
 * would find it, open it and see nothing — and until now the only way to get a
 * first dish onto one was for the owner to sign in and do it. An operator
 * onboarding a shop on a Friday afternoon could see "No menu" on their own
 * screen and had nothing to do about it but ring somebody.
 *
 * ADDING ONLY. Editing a dish, its photo, its option groups and its stock all
 * live in the shop's own back office, which is where they belong and where
 * they already work. Rebuilding that here would be a second menu screen to
 * keep in step with the first — and the gap this closes is the empty menu, not
 * the everyday running of one.
 */
export function StoreMenuPanel({
  storeId,
  items,
  categories,
}: {
  storeId: string;
  items: ConsoleMenuItem[];
  /** Existing category names, so a new dish joins a section rather than
   *  starting a near-duplicate of one ("Drinks" beside "drinks"). */
  categories: string[];
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);

  /*
   * CONTROLLED, and the browser is why.
   *
   * A form submitted to a server action is RESET when the action returns —
   * so the first draft of this lost every field the moment the server
   * refused one of them. Somebody who typed a dish, a description and a
   * price, and got "the was price has to be higher", was handed an empty
   * form and had to type all of it again to fix one number.
   *
   * Holding the values here means a refusal costs the one field it is
   * about. They are cleared on success, where an empty form is what the
   * next dish wants.
   */
  const [draft, setDraft] = useState({
    name: '',
    price: '',
    comparePrice: '',
    category: '',
    description: '',
    isAvailable: '1',
  });
  const set = (field: keyof typeof draft) => (value: string) =>
    setDraft((was) => ({ ...was, [field]: value }));

  const [result, submit, pending] = useActionState<AdminActionResult | null, FormData>(
    addStoreMenuItemAction,
    null,
  );

  // The page was rendered before the dish existed; nothing else tells it.
  useEffect(() => {
    if (result?.ok) {
      router.refresh();
      setOpen(false);
      setDraft({
        name: '',
        price: '',
        comparePrice: '',
        category: '',
        description: '',
        isAvailable: '1',
      });
    }
  }, [result, router]);

  const unavailable = items.filter((item) => !item.isAvailable).length;

  return (
    <section className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/5 px-4 py-3">
        <div>
          <h2 className="text-[13px] font-bold">Menu</h2>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            {items.length === 0
              ? 'Nothing on it yet — a shop with no menu cannot be made Active.'
              : `${items.length} ${items.length === 1 ? 'dish' : 'dishes'}` +
                (unavailable > 0 ? `, ${unavailable} out of stock` : '') +
                '. Prices, photos and stock are the shop’s own, from its back office.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-controls={formId}
          className="shrink-0 rounded-lg bg-brand-600 px-3.5 py-2 text-[13px] font-bold text-white hover:bg-brand-700"
        >
          {open ? 'Cancel' : '+ Add item'}
        </button>
      </div>

      {open ? (
        <form id={formId} action={submit} className="border-b border-black/5 bg-surface-sunken px-4 py-3">
          <input type="hidden" name="storeId" value={storeId} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block lg:col-span-2">
              <span className="text-[11px] font-semibold text-ink-muted">Dish</span>
              <input
                name="name"
                required
                maxLength={80}
                autoFocus
                value={draft.name}
                onChange={(event) => set('name')(event.target.value)}
                className={FIELD}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-muted">Price</span>
              <input
                name="price"
                required
                inputMode="decimal"
                placeholder="120"
                value={draft.price}
                onChange={(event) => set('price')(event.target.value)}
                className={`${FIELD} tabular-nums`}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-muted">
                Was <span className="font-normal text-ink-faint">(optional)</span>
              </span>
              <input
                name="comparePrice"
                inputMode="decimal"
                placeholder="150"
                value={draft.comparePrice}
                onChange={(event) => set('comparePrice')(event.target.value)}
                className={`${FIELD} tabular-nums`}
              />
              {/* Refused unless it is ABOVE the price. A "was" price at or
                  below what is charged is not a discount, it is a lie on a
                  price tag — and checkout prices every line from the real one
                  regardless, so a wrong number here can only mislead. */}
              <span className="mt-1 block text-[11px] text-ink-faint">
                Shown struck through. Must be higher than the price.
              </span>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-muted">Section</span>
              {/* A free text box with the shop's existing sections offered.
                  A plain input alone is how "Drinks" and "drinks" become two
                  sections; a select alone would refuse the first one ever. */}
              <input
                name="category"
                list={`${formId}-categories`}
                maxLength={40}
                placeholder="Main"
                value={draft.category}
                onChange={(event) => set('category')(event.target.value)}
                className={FIELD}
              />
              <datalist id={`${formId}-categories`}>
                {categories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </label>
            <label className="block sm:col-span-2 lg:col-span-3">
              <span className="text-[11px] font-semibold text-ink-muted">
                Description <span className="font-normal text-ink-faint">(optional)</span>
              </span>
              <input
                name="description"
                maxLength={280}
                value={draft.description}
                onChange={(event) => set('description')(event.target.value)}
                className={FIELD}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-muted">Status</span>
              <select
                name="isAvailable"
                value={draft.isAvailable}
                onChange={(event) => set('isAvailable')(event.target.value)}
                className={FIELD}
              >
                <option value="1">In stock</option>
                <option value="0">Out of stock</option>
              </select>
              <span className="mt-1 block text-[11px] text-ink-faint">
                Out of stock is how a menu is entered before opening day.
              </span>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-brand-700 disabled:bg-ink-faint"
            >
              {pending ? 'Adding…' : 'Add to the menu'}
            </button>
            <p className="text-[11px] text-ink-faint">
              Add the photo from the row below once it is on the list.
            </p>
          </div>
        </form>
      ) : null}

      {result && !result.ok ? (
        <p role="alert" className="border-b border-black/5 px-4 py-2 text-[12px] text-rose-700">
          {result.message}
        </p>
      ) : null}
      {result?.ok ? (
        <p role="status" className="border-b border-black/5 px-4 py-2 text-[12px] text-emerald-800">
          {result.message}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-ink-muted">
          No dishes yet.
        </p>
      ) : (
        <ul className="divide-y divide-black/5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
              {item.imageHref ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageHref}
                  alt=""
                  width={80}
                  height={80}
                  className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-black/5"
                />
              ) : (
                <span
                  aria-hidden
                  className="h-10 w-10 shrink-0 rounded-lg bg-surface-sunken ring-1 ring-black/5"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{item.name}</span>
                <span className="block truncate text-[11px] text-ink-faint">
                  {item.category}
                  {item.description ? ` · ${item.description}` : ''}
                </span>
              </span>
              {!item.isAvailable ? (
                <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                  Out of stock
                </span>
              ) : null}
              <span className="shrink-0 text-right text-[13px] font-bold tabular-nums">
                {formatCentavos(item.priceCentavos)}
                {item.compareAtPriceCentavos !== null ? (
                  <span className="ml-1.5 font-normal text-ink-faint line-through">
                    {formatCentavos(item.compareAtPriceCentavos)}
                  </span>
                ) : null}
              </span>
              <MenuItemPhotoButton
                storeId={storeId}
                itemId={item.id}
                itemName={item.name}
                hasPhoto={item.imageHref !== null}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One dish's photograph, from the console.
 *
 * Its own control on the row rather than a file input in the create form,
 * because the dish has to exist before a photo can hang off it — and because
 * the common case is adding a picture to a dish somebody entered last week,
 * not to the one being typed right now.
 *
 * The resize happens here, in the browser: a camera photo is several
 * megabytes and a server action's body limit is one.
 */
function MenuItemPhotoButton({
  storeId,
  itemId,
  itemName,
  hasPhoto,
}: {
  storeId: string;
  itemId: string;
  itemName: string;
  hasPhoto: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [stage, setStage] = useState<'IDLE' | 'RESIZING' | 'SENDING'>('IDLE');
  const [note, setNote] = useState<string | null>(null);

  async function onPicked(file: File): Promise<void> {
    setNote(null);
    setStage('RESIZING');
    let resized: File;
    try {
      resized = await downscalePhoto(file);
    } catch (error) {
      setStage('IDLE');
      setNote(error instanceof Error ? error.message : 'That photo could not be used.');
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('itemId', itemId);
      formData.set('photo', resized);
      setStage('SENDING');
      const result = await uploadStoreMenuItemImageAction(null, formData);
      setStage('IDLE');
      if (result.ok) router.refresh();
      else setNote(result.message);
    });
  }

  const busy = pending || stage !== 'IDLE';

  return (
    <span className="flex shrink-0 flex-col items-end">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`Photo for ${itemName}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so picking the same file twice still fires a change.
          event.target.value = '';
          if (file) void onPicked(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="text-[11px] font-semibold text-brand-700 disabled:text-ink-faint"
      >
        {stage === 'RESIZING'
          ? 'Resizing…'
          : stage === 'SENDING'
            ? 'Saving…'
            : hasPhoto
              ? 'Replace photo'
              : 'Add photo'}
      </button>
      {note ? (
        <span role="alert" className="max-w-[14rem] text-right text-[10px] text-rose-700">
          {note}
        </span>
      ) : null}
    </span>
  );
}
