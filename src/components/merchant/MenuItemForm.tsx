'use client';

import { useActionState, useEffect, useState } from 'react';
import { addMenuItemAction } from '@/lib/actions/menu-actions';
import {
  MAX_CATEGORY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ITEM_NAME_LENGTH,
} from '@/lib/merchant/menu-policy';

/**
 * Adding a dish — the form this application did not have.
 *
 * Until now nothing could create a `MenuItem`: the only INSERT was in the seed
 * file, so a real shop's menu meant somebody with database access typing SQL,
 * and the console's own refusal to publish a shop without a menu was advice
 * its owner could not act on.
 *
 * Four fields, and the order is the order somebody says them out loud: what it
 * is, what it costs, where it belongs, and anything else. Section is a free
 * text box with the shop's existing sections offered as suggestions, rather
 * than a dropdown — a shop inventing "Merienda" should not have to ask
 * anybody, and matching an existing name is handled server-side so "add-ons"
 * joins "Add-ons" instead of starting a second section beside it.
 *
 * Submission is gated on hydration, like every other form here. A form posted
 * before the page hydrates runs with no request scope, so the session cookie
 * cannot be read and the action fails for a reason nobody could guess from the
 * screen. The `<noscript>` note says what to do instead.
 */
export function MenuItemForm({
  storeId,
  sections,
}: {
  storeId: string;
  sections: string[];
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [result, add, adding] = useActionState(addMenuItemAction, null);

  // Cleared on a successful add so the next dish starts from an empty form,
  // and kept on a refusal so a mistyped price is not retyped from scratch.
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState(sections[0] ?? '');
  const [description, setDescription] = useState('');
  const [lastCleared, setLastCleared] = useState<string | null>(null);

  useEffect(() => {
    if (result?.ok && result.message !== lastCleared) {
      setName('');
      setPrice('');
      setDescription('');
      setLastCleared(result.message);
    }
  }, [result, lastCleared]);

  return (
    <section
      aria-labelledby="add-item-heading"
      className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="add-item-heading" className="text-[13px] font-semibold">
        Add an item
      </h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
        It goes to the bottom of its section, in stock and orderable straight
        away.
      </p>

      <form action={add} className="mt-3 space-y-2">
        <input type="hidden" name="storeId" value={storeId} />

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">Name</span>
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={MAX_ITEM_NAME_LENGTH}
            placeholder="Adobong Manok with Rice"
            className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>

        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold text-ink-muted">Section</span>
            <input
              name="category"
              value={category}
              list="existing-sections"
              onChange={(event) => setCategory(event.target.value)}
              maxLength={MAX_CATEGORY_LENGTH}
              placeholder="Rice meals"
              className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="w-28 shrink-0">
            <span className="text-[11px] font-semibold text-ink-muted">Price</span>
            <span className="mt-0.5 flex items-center gap-1 rounded-lg bg-surface-sunken px-3 py-2 ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-brand-500">
              <span className="text-[13px] text-ink-faint">₱</span>
              <input
                name="price"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
                inputMode="decimal"
                placeholder="125"
                className="w-full bg-transparent text-right text-[13px] tabular-nums focus:outline-none"
              />
            </span>
          </label>
        </div>

        <datalist id="existing-sections">
          {sections.map((section) => (
            <option key={section} value={section} />
          ))}
        </datalist>

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Description <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <textarea
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            maxLength={MAX_DESCRIPTION_LENGTH}
            placeholder="Sa mangkok, may kanin at itlog"
            className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] leading-snug ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>

        <button
          type="submit"
          disabled={adding || !hydrated}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
        >
          {adding ? 'Adding…' : 'Add to the menu'}
        </button>

        <noscript>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
            Adding an item needs JavaScript. Turn it on, or use another browser.
          </p>
        </noscript>

        {result ? (
          <p
            role={result.ok ? 'status' : 'alert'}
            className={`text-[11px] ${result.ok ? 'text-emerald-800' : 'text-rose-700'}`}
          >
            {result.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
