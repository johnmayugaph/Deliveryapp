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

/*
 * WHY EVERY BUTTON IN HERE IS `relative`.
 *
 * Each carries an `sr-only` label, and `sr-only` is `position: absolute`. With
 * no positioned ancestor its containing block is the document, so dropped into
 * a horizontally scrolling rail it anchors itself wherever the card has been
 * scrolled to and drags the PAGE's scroll width out with it — the whole screen
 * becomes swipeable sideways because of a one-pixel span nobody can see.
 *
 * It is fixed HERE rather than at each call site because this component is
 * designed to be put anywhere, and a caller dropping it into a rail has no way
 * to know it needs to be made a containing block first. It has already
 * happened twice.
 */
/**
 * The round +. Nine millimetres of target at 36px, which is the smallest a
 * thumb should be asked to hit, and a shadow because in the grid it sits on a
 * photograph whose colours nobody here has seen.
 */
const ROUND_BUTTON =
  'relative flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-xl font-bold leading-none text-white shadow-lifted transition-colors hover:bg-brand-700';

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
  variant = 'pill',
}: {
  store: { id: string; name: string; slug: string };
  menuItemId: string;
  itemName: string;
  basePriceCentavos: number;
  groups: GroupLike[];
  /**
   * `pill` is the labelled button this has always had. `round` is the circular
   * + the menu uses, where the dish name and price are already beside it and a
   * word saying "Add" is the third thing in a row that only needed two.
   *
   * It is a LOOK, not a second behaviour: both shapes add the same way, both
   * open the same chooser, and both turn into the same stepper.
   */
  variant?: 'pill' | 'round';
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
          /*
           * Full width rather than a panel in the price column: on a 360px
           * phone a 16rem panel beside the dish name leaves the name wrapping
           * to three lines while somebody is trying to read the choices.
           *
           * In `round` it is a bottom sheet instead, and that is a layout
           * necessity rather than a flourish: the round + floats on the
           * photograph in a two-column grid, so a panel rendered in its place
           * would be positioned over the picture in a column half the screen
           * wide. A sheet is also where a phone user expects a set of choices
           * to appear.
           */
          <>
            {variant === 'round' ? (
              /* The scrim. A sheet without one leaves the page scrolling
                 behind it and gives no way out but the Cancel button, which
                 is not where anybody's thumb goes first. */
              <button
                type="button"
                aria-label="Close"
                onClick={() => {
                  setChoosing(false);
                  setChosen([]);
                }}
                className="fixed inset-0 z-40 bg-ink/40"
              />
            ) : null}
          <div
            className={
              variant === 'round'
                ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] space-y-3 overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-left shadow-lifted'
                : 'mt-1 w-full space-y-3 rounded-xl bg-surface-sunken p-3 text-left'
            }
          >
            {variant === 'round' ? (
              <p className="text-[15px] font-extrabold leading-tight">{itemName}</p>
            ) : null}
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
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setChoosing(true)}
              className={
                variant === 'round'
                  ? ROUND_BUTTON
                  : 'relative rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700'
              }
            >
              {variant === 'round' ? <span aria-hidden>+</span> : 'Choose'}
              {/* The round button has no visible word, so the whole sentence
                  has to be here. With only the tail of it the button
                  announced itself as "options for Chicken adobo", which is
                  not something a person can act on. */}
              <span className="sr-only">
                {variant === 'round' ? 'Choose options for ' : ' options for '}
                {itemName}
              </span>
            </button>
            {inCart > 0 && variant === 'pill' ? (
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
          className={
            variant === 'round'
              ? ROUND_BUTTON
              : 'relative rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500'
          }
        >
          {variant === 'round' ? <span aria-hidden>+</span> : 'Add'}
          <span className="sr-only">
            {variant === 'round' ? 'Add ' : ' '}
            {itemName} to cart
          </span>
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
    <div
      className={`flex items-center gap-1.5 ${
        // On a photograph the stepper needs its own ground, or a minus sign
        // lands on a picture of rice.
        variant === 'round' ? 'rounded-full bg-surface/95 p-1 shadow-tile backdrop-blur' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => setQuantity(plainLineId, quantity - 1)}
        className="relative flex h-7 w-7 items-center justify-center rounded-full bg-surface-sunken text-sm font-semibold ring-1 ring-black/10 transition-colors hover:bg-brand-50"
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
        className="relative flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      >
        <span aria-hidden>+</span>
        <span className="sr-only">Add one {itemName}</span>
      </button>
    </div>
  );
}
