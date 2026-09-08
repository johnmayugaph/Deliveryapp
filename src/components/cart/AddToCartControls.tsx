'use client';

import { useMemo, useState } from 'react';
import { useCart } from '@/components/cart/CartProvider';
import { cartLineId, countOfItem } from '@/lib/cart/types';
import { formatCentavos } from '@/lib/money';
import {
  describeGroupRule,
  resolveChoices,
  unitPriceWithChoices,
  type GroupLike,
} from '@/lib/merchant/option-policy';

/**
 * Adding one dish to the cart — with its choices, when it has any.
 *
 * Two shapes, and which one appears is decided by the dish rather than by a
 * setting. A dish that asks nothing keeps the one-tap Add and the stepper it
 * has always had: that is most of a carinderia menu and it should not get
 * slower because some other dish has sizes. A dish that asks something opens
 * a panel, because "Add" cannot know whether you wanted regular or large.
 *
 * The prices here are for READING. Every one of them is recomputed by
 * `quoteCheckout` from the database before anybody is charged — this component
 * sends ids and nothing else, which is why a customer editing it can change
 * what they see and not what they pay.
 */
export function AddToCartControls({
  store,
  menuItemId,
  itemName,
  basePriceCentavos,
  groups,
}: {
  store: { id: string; name: string; slug: string };
  menuItemId: string;
  itemName: string;
  basePriceCentavos: number;
  groups: GroupLike[];
}) {
  const { cart, isLoaded, addItem, setQuantity } = useCart();
  const [replacedStore, setReplacedStore] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);

  const plainLineId = cartLineId(menuItemId, []);
  const plainLine = cart.lines.find((line) => line.lineId === plainLineId);
  const isThisStore = cart.storeId === store.id;
  const quantity = isThisStore ? (plainLine?.quantity ?? 0) : 0;
  const inCart = isThisStore ? countOfItem(cart, menuItemId) : 0;

  // What the choices currently add up to, and whether they are answerable.
  const { total, problem } = useMemo(() => {
    try {
      const choices = resolveChoices(groups, chosen);
      return {
        total: unitPriceWithChoices(basePriceCentavos, choices),
        problem: null as string | null,
      };
    } catch (error) {
      return {
        total: basePriceCentavos,
        problem: error instanceof Error ? error.message : 'Choose your options.',
      };
    }
  }, [groups, chosen, basePriceCentavos]);

  // Until the stored cart is read, render the neutral state so the server and
  // client markup agree.
  if (!isLoaded) {
    return <div className="h-8 w-16" aria-hidden />;
  }

  function toggle(group: GroupLike, optionId: string): void {
    setChosen((current) => {
      const inGroup = group.options.map((option) => option.id);
      const already = current.includes(optionId);
      if (already) return current.filter((id) => id !== optionId);
      // One answer per group means picking replaces rather than adds, which is
      // what a radio does and what "choose one" says.
      const kept =
        group.maxChoices === 1 ? current.filter((id) => !inGroup.includes(id)) : current;
      return [...kept, optionId];
    });
  }

  if (groups.length > 0) {
    return (
      <div className="text-right">
        {choosing ? (
          // Full width rather than a panel in the price column: on a 360px
          // phone a 16rem panel beside the dish name leaves the name wrapping
          // to three lines while somebody is trying to read the choices.
          <div className="mt-1 w-full space-y-3 rounded-xl bg-surface-sunken p-3 text-left">
            {groups.map((group) => (
              <fieldset key={group.id}>
                <legend className="text-[11px] font-semibold">
                  {group.name}
                  <span className="ml-1.5 font-normal text-ink-faint">
                    {describeGroupRule(group)}
                  </span>
                </legend>
                <div className="mt-1 space-y-1">
                  {group.options.map((option) => (
                    <label
                      key={option.id}
                      className={`flex items-center gap-2 text-[12px] ${
                        option.isAvailable ? '' : 'text-ink-faint'
                      }`}
                    >
                      <input
                        type={group.maxChoices === 1 ? 'radio' : 'checkbox'}
                        name={group.id}
                        checked={chosen.includes(option.id)}
                        disabled={!option.isAvailable}
                        onChange={() => toggle(group, option.id)}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0 flex-1">
                        {option.name}
                        {option.isAvailable ? '' : ' · wala ngayon'}
                      </span>
                      {option.priceDeltaCentavos > 0 ? (
                        <span className="tabular-nums text-ink-muted">
                          +{formatCentavos(option.priceDeltaCentavos)}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}

            <div className="flex items-center justify-between gap-2 border-t border-black/5 pt-2">
              <span className="text-[13px] font-semibold tabular-nums">
                {formatCentavos(total)}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setChoosing(false);
                    setChosen([]);
                  }}
                  className="text-[11px] font-semibold text-ink-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={problem !== null}
                  onClick={() => {
                    const { replacedStore: replaced } = addItem({
                      store,
                      menuItemId,
                      optionIds: chosen,
                    });
                    setReplacedStore(replaced);
                    setChoosing(false);
                    setChosen([]);
                  }}
                  className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
                >
                  Add
                </button>
              </span>
            </div>

            {problem ? (
              <p role="status" className="text-[11px] text-amber-700">
                {problem}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setChoosing(true)}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Choose
              <span className="sr-only"> options for {itemName}</span>
            </button>
            {inCart > 0 ? (
              <p className="mt-1 text-[10px] text-ink-faint">{inCart} in cart</p>
            ) : null}
          </>
        )}

        {replacedStore ? (
          <p role="status" className="mt-1 max-w-[9rem] text-[10px] leading-tight text-amber-700">
            Your cart from {replacedStore} was replaced.
          </p>
        ) : null}
      </div>
    );
  }

  if (quantity === 0) {
    return (
      <div className="text-right">
        <button
          type="button"
          onClick={() => {
            const { replacedStore: replaced } = addItem({ store, menuItemId });
            setReplacedStore(replaced);
          }}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          Add
          <span className="sr-only"> {itemName} to cart</span>
        </button>
        {replacedStore ? (
          <p role="status" className="mt-1 max-w-[9rem] text-[10px] leading-tight text-amber-700">
            Your cart from {replacedStore} was replaced.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setQuantity(plainLineId, quantity - 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-sunken text-sm font-semibold ring-1 ring-black/10 transition-colors hover:bg-brand-50"
      >
        <span aria-hidden>−</span>
        <span className="sr-only">Remove one {itemName}</span>
      </button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        onClick={() => setQuantity(plainLineId, quantity + 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      >
        <span aria-hidden>+</span>
        <span className="sr-only">Add one {itemName}</span>
      </button>
    </div>
  );
}
