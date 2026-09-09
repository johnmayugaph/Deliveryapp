'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PaymentMethod } from '@prisma/client';
import { useCart } from '@/components/cart/CartProvider';
import {
  placeOrderAction,
  quoteCheckoutAction,
  type CheckoutFormInput,
} from '@/lib/actions/checkout-actions';
import type { CheckoutQuote } from '@/lib/orders/place-order';
import { formatCentavos } from '@/lib/money';
import { describeChoices } from '@/lib/merchant/option-policy';
import { PromoField } from '@/components/cart/PromoField';
import { promoDisplay } from '@/lib/promo/policy';
import { describeWithheld } from '@/lib/pricing/benefits';
import {
  describeHold,
  shortHoldNote,
  spendableFrom,
  type CreditsState,
} from '@/lib/wallet/held';

export interface CheckoutAddressOption {
  id: string;
  label: string;
  line1: string;
  barangay: string | null;
  cityName: string | null;
  isDefault: boolean;
}

/**
 * Keyed by every method, so a new instrument is a compile error here rather
 * than a radio button labelled `MANUAL_TRANSFER`. (It fired the moment the
 * transfer rail was added, which is the entire point of writing it this way.)
 *
 * The transfer's label is generic on purpose: which wallet it is comes from
 * configuration and is filled in by `transferLabel` below, so the same build
 * serves a GCash deployment and a Maya one.
 */
const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.CASH_ON_DELIVERY]: 'Cash on delivery',
  [PaymentMethod.WALLET_CREDIT]: 'Credits',
  [PaymentMethod.MANUAL_TRANSFER]: 'Pay now by transfer',
};

const TIP_OPTIONS = [0, 2_000, 5_000, 10_000];

/**
 * The checkout form.
 *
 * It never computes money. Every amount rendered comes from the server quote,
 * which is re-requested whenever an input that affects price changes. That
 * costs a round trip per change and buys the guarantee that the displayed
 * breakdown is the one placement will charge.
 */
export function CheckoutForm({
  addresses,
  credits: creditsAtLoad,
  paymentMethods,
  transferLabel,
}: {
  addresses: CheckoutAddressOption[];
  /**
   * The customer's credits as of page load, used ONLY until the first quote
   * lands. Every quote carries the live state and it wins — see `credits`
   * below. Passing a snapshot and rendering it as current was the defect:
   * the figure was fixed at page load while the money was not.
   */
  credits: CreditsState;
  paymentMethods: PaymentMethod[];
  /**
   * The configured wallet's name — "GCash", "Maya" — or null when no prepaid
   * rail is set up. Passed in from the server because the account details are
   * server configuration, and a client component that could read them would be
   * a client component that ships them to everybody.
   */
  transferLabel: string | null;
}) {
  const router = useRouter();
  const { cart, isLoaded, clear } = useCart();

  const [dropoffAddressId, setDropoffAddressId] = useState(
    () => addresses.find((address) => address.isDefault)?.id ?? addresses[0]?.id ?? '',
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    PaymentMethod.CASH_ON_DELIVERY,
  );
  const [useCredits, setUseCredits] = useState(false);
  const [tipCentavos, setTipCentavos] = useState(0);
  const [includeCutlery, setIncludeCutlery] = useState(false);
  const [merchantNotes, setMerchantNotes] = useState('');
  // The code being QUOTED WITH, not the code being typed — the typing lives in
  // `PromoField`. Empty means none.
  const [promoCode, setPromoCode] = useState('');

  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [isPlacing, startPlacing] = useTransition();
  // Bumped when placement is refused because the market got busier. It is in
  // the re-quote key, so the refusal is immediately followed by the screen
  // showing the NEW total — a refusal that left the old price on screen would
  // just be a button that stopped working.
  const [requoteNonce, setRequoteNonce] = useState(0);

  /**
   * The sentences explaining a benefit the customer has that this bill did
   * not use.
   *
   * `describeWithheld` decides which reasons are worth saying and what the
   * words are; this only decides the tone. `UNDER_MINIMUM` is the actionable
   * one — "add ₱40 more and delivery is free" — so it gets the accent colour
   * a customer can act on, and the rest are muted.
   *
   * The ALREADY_COVERED note is shown only to a SUBSCRIBER, because "your
   * plan's free delivery was not needed" is reassurance for somebody paying
   * every month and clutter for anybody else.
   */
  const withheldNotes = (quote?.price.withheldBenefits ?? [])
    .map((line) => {
      const text = describeWithheld(line, formatCentavos, {
        subscriberSeesCoveredNote: quote?.price.subscriptionId !== null,
        sourceLabel:
          line.source === 'LOYALTY_TIER'
            ? quote?.price.loyaltyTierName ?? null
            : 'TARA Plus',
      });
      return text === null
        ? null
        : {
            key: `${line.benefitId}:${line.reason}`,
            text,
            actionable: line.reason === 'UNDER_MINIMUM',
          };
    })
    .filter((note): note is NonNullable<typeof note> => note !== null);

  const formInput: CheckoutFormInput | null =
    cart.storeId && dropoffAddressId
      ? {
          storeId: cart.storeId,
          lines: cart.lines.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            optionIds: line.optionIds,
            ...(line.notes ? { notes: line.notes } : {}),
          })),
          dropoffAddressId,
          paymentMethod,
          // Paying with credits implies spending them.
          useCredits: useCredits || paymentMethod === PaymentMethod.WALLET_CREDIT,
          tipCentavos,
          includeCutlery,
          merchantNotes,
          promoCode,
        }
      : null;

  // Re-quote whenever anything price-bearing changes. `merchantNotes` and
  // `includeCutlery` deliberately are not in the dependency list — they do not
  // affect price, and re-quoting on every keystroke would be wasteful.
  const quoteKey = JSON.stringify({
    storeId: cart.storeId,
    // The line id already carries the dish and its choices, so a customer
    // switching Regular for Large re-quotes.
    lines: cart.lines.map((line) => [line.lineId, line.quantity]),
    dropoffAddressId,
    paymentMethod,
    useCredits,
    tipCentavos,
    promoCode,
    requoteNonce,
  });

  useEffect(() => {
    if (!isLoaded || !formInput) {
      setQuote(null);
      return;
    }

    let cancelled = false;
    setIsQuoting(true);

    quoteCheckoutAction(formInput)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setQuote(result.quote);
          setQuoteError(null);
        } else {
          setQuote(null);
          setQuoteError(result.message);
        }
      })
      .finally(() => {
        if (!cancelled) setIsQuoting(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, isLoaded]);

  if (!isLoaded) {
    return <p className="px-4 py-8 text-sm text-ink-muted">Loading…</p>;
  }

  if (cart.lines.length === 0) {
    return (
      <p className="px-4 py-8 text-sm text-ink-muted">
        Your cart is empty.{' '}
        <Link href="/" className="font-semibold text-brand-700 underline">
          Find something to eat
        </Link>
        .
      </p>
    );
  }

  /* THE LIVE FIGURE. `price.credits` is recomputed on every quote and was
     already being returned and thrown away, while the screen rendered the
     page-load prop beside it. That is the whole defect: credits arriving
     mid-checkout — a gift card redeemed in another tab, points turned into
     credits, a refund landing — could not be spent because the checkbox was
     gated on the stale number; and credits that went to zero, including a
     wallet frozen while the customer sat here, left a checkbox that ticked
     and silently applied nothing.

     The prop is the fallback for the moment before the first quote. */
  const credits = quote?.price.credits ?? creditsAtLoad;
  const spendableCreditsCentavos = spendableFrom(credits);
  const holdNote = describeHold(credits, formatCentavos, (date) =>
    date.toLocaleDateString('en-PH', {
      day: 'numeric',
      month: 'long',
    }),
  );

  const creditsShort = (quote?.creditShortfallCentavos ?? 0) > 0;
  const canPlace = quote !== null && !isQuoting && !creditsShort && !isPlacing;

  function onPlace() {
    if (!formInput) return;
    setPlaceError(null);

    startPlacing(async () => {
      const result = await placeOrderAction({
        ...formInput,
        // The surge on the screen the customer is looking at, as a ceiling.
        // Placement re-quotes and refuses rather than charging more than this.
        acceptedSurgeCentavos: quote?.surge.surgeCentavos ?? 0,
        // And the discount on that same screen, as a floor. Without it a code
        // that ran out while they were choosing would place the order at full
        // price with nothing said — the same surprise as a higher surge,
        // arriving from the other side of the total.
        acceptedPromoDiscountCentavos: quote?.price.promoDiscountCentavos ?? 0,
      });
      if (result.ok) {
        clear();
        router.push(`/orders/${result.orderId}?placed=1`);
      } else {
        setPlaceError(result.message);
        // Both of these are refusals the screen answers by showing the NEW
        // total: the market moved, or the campaign ran out while they were
        // choosing. Leaving the old price up would just be a button that
        // stopped working.
        if (result.code === 'SURGE_CHANGED' || result.code === 'PROMO_INVALID') {
          setRequoteNonce((nonce) => nonce + 1);
        }
      }
    });
  }

  return (
    <div className="space-y-4 px-4 py-4 pb-8">
      {/* --- Items ------------------------------------------------------ */}
      <section
        aria-labelledby="items-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <div className="flex items-baseline justify-between">
          <h2 id="items-heading" className="text-[13px] font-semibold">
            {cart.storeName}
          </h2>
          {cart.storeSlug ? (
            <Link
              href={`/stores/${cart.storeSlug}`}
              className="text-xs font-semibold text-brand-700"
            >
              Edit
            </Link>
          ) : null}
        </div>

        <ul className="mt-2 space-y-1.5">
          {(quote?.items ?? []).map((item, index) => (
            // Keyed by position: the same dish can appear twice with
            // different choices, so its id is not unique in this list.
            <li key={`${item.menuItemId}:${index}`} className="flex justify-between gap-3 text-xs">
              <span className="min-w-0">
                <span className="font-medium tabular-nums">{item.quantity}×</span>{' '}
                <span className="text-ink-muted">{item.name}</span>
                {/* The choices, by name. What each one added is already in the
                    line total; repeating the arithmetic here is how a receipt
                    becomes homework. */}
                {item.options.length > 0 ? (
                  <span className="mt-0.5 block text-[11px] text-ink-faint">
                    {describeChoices(item.options)}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatCentavos(item.lineTotalCentavos)}
              </span>
            </li>
          ))}
          {!quote
            ? cart.lines.map((line) => (
                <li key={line.lineId} className="text-xs text-ink-faint">
                  {line.quantity}× …
                </li>
              ))
            : null}
        </ul>
      </section>

      {/* --- Address ---------------------------------------------------- */}
      <section
        aria-labelledby="address-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="address-heading" className="text-[13px] font-semibold">
          Deliver to
        </h2>
        <div className="mt-2 space-y-1.5">
          {addresses.map((address) => (
            <label
              key={address.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg p-2 transition-colors hover:bg-surface-sunken"
            >
              <input
                type="radio"
                name="dropoffAddressId"
                value={address.id}
                checked={dropoffAddressId === address.id}
                onChange={() => setDropoffAddressId(address.id)}
                className="mt-0.5 accent-brand-600"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold">{address.label}</span>
                <span className="block text-[11px] text-ink-muted">
                  {[address.line1, address.barangay, address.cityName]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* --- Tip -------------------------------------------------------- */}
      <section
        aria-labelledby="tip-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="tip-heading" className="text-[13px] font-semibold">
          Tip for the rider
        </h2>
        <div className="mt-2 flex gap-2">
          {TIP_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTipCentavos(option)}
              aria-pressed={tipCentavos === option}
              className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
                tipCentavos === option
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-sunken text-ink-muted hover:bg-brand-50'
              }`}
            >
              {option === 0 ? 'None' : formatCentavos(option)}
            </button>
          ))}
        </div>
      </section>

      {/* --- Promo code -------------------------------------------------- */}
      <PromoField
        appliedCode={promoCode}
        // Derived from the SERVER quote every render, never remembered here.
        // `promo.discountCentavos` is what the code offered;
        // `price.promoDiscountCentavos` is what came off — they differ when a
        // non-stacking code lost to the customer's own plan.
        display={
          quote
            ? promoDisplay({
                code: promoCode,
                refusal: quote.promo.refusal,
                offeredCentavos: quote.promo.discountCentavos,
                appliedCentavos: quote.price.promoDiscountCentavos,
              })
            : null
        }
        isQuoting={isQuoting}
        onApply={setPromoCode}
        onRemove={() => setPromoCode('')}
      />

      {/* --- Payment ---------------------------------------------------- */}
      <section
        aria-labelledby="payment-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="payment-heading" className="text-[13px] font-semibold">
          Payment
        </h2>
        <div className="mt-2 space-y-1.5">
          {paymentMethods.map((method) => (
            <label
              key={method}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-surface-sunken"
            >
              <input
                type="radio"
                name="paymentMethod"
                value={method}
                checked={paymentMethod === method}
                onChange={() => setPaymentMethod(method)}
                className="accent-brand-600"
              />
              <span className="text-xs font-medium">
                {method === PaymentMethod.MANUAL_TRANSFER && transferLabel
                  ? `Pay now with ${transferLabel}`
                  : PAYMENT_LABELS[method]}
              </span>
              {method === PaymentMethod.WALLET_CREDIT ? (
                /* "held" rather than "₱0.00 available", which was the
                   specific falsehood: the money is there and the screen
                   said it was not. */
                <span className="ml-auto text-[11px] text-ink-muted tabular-nums">
                  {shortHoldNote(credits, formatCentavos)}
                </span>
              ) : null}
            </label>
          ))}
        </div>

        {/* What choosing this actually commits them to, before they commit.
            A prepaid order does not reach the shop until the money is
            confirmed, and somebody expecting lunch needs to know that is the
            deal rather than discovering it while watching a spinner. */}
        {paymentMethod === PaymentMethod.MANUAL_TRANSFER ? (
          <p className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-[11px] leading-relaxed text-brand-900">
            You will get the account details on the next screen. Send the exact
            total, then enter the reference number. The store starts cooking once
            we have confirmed it — usually a few minutes — and the rider collects
            nothing at your door.
          </p>
        ) : null}

        {/* Offer credits as a partial offset only when cash is the rail —
            choosing Credits already means spending them. */}
        {paymentMethod === PaymentMethod.CASH_ON_DELIVERY && spendableCreditsCentavos > 0 ? (
          <label className="mt-2 flex cursor-pointer items-center gap-2.5 border-t border-black/5 pt-2.5">
            <input
              type="checkbox"
              checked={useCredits}
              onChange={(event) => setUseCredits(event.target.checked)}
              className="accent-brand-600"
            />
            <span className="text-xs">
              Use my credits
              <span className="ml-1 text-ink-muted tabular-nums">
                ({formatCentavos(spendableCreditsCentavos)})
              </span>
            </span>
          </label>
        ) : null}

        {/* Why the credits they know they have are not on offer. Said here,
            beside the option it disables, rather than only on the Credits
            screen — this is where somebody is counting on them. */}
        {holdNote ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
            {holdNote}
          </p>
        ) : null}

        {creditsShort ? (
          <p role="alert" className="mt-2 text-[11px] leading-relaxed text-rose-700">
            You are {formatCentavos(quote!.creditShortfallCentavos)} short of credits, and
            you cannot load money — choose cash on delivery.
          </p>
        ) : null}
      </section>

      {/* --- Notes ------------------------------------------------------ */}
      <section
        aria-labelledby="notes-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="notes-heading" className="text-[13px] font-semibold">
          For the store
        </h2>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={includeCutlery}
            onChange={(event) => setIncludeCutlery(event.target.checked)}
            className="accent-brand-600"
          />
          <span className="text-xs">Include cutlery</span>
        </label>
        <label className="mt-2 block">
          <span className="sr-only">Note for the store</span>
          <textarea
            value={merchantNotes}
            onChange={(event) => setMerchantNotes(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="For example: no onions"
            className="mt-1 w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-xs ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
      </section>

      {/* --- Breakdown -------------------------------------------------- */}
      <section
        aria-labelledby="total-heading"
        aria-busy={isQuoting}
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="total-heading" className="text-[13px] font-semibold">
          Total
        </h2>

        {quoteError ? (
          <p role="alert" className="mt-2 text-xs leading-relaxed text-rose-700">
            {quoteError}
          </p>
        ) : quote ? (
          <dl className="mt-2 space-y-1">
            <Line label="Subtotal" centavos={quote.price.subtotalCentavos} />
            <Line
              label={`Delivery (${(quote.delivery.distanceMeters / 1000).toFixed(1)} km)`}
              centavos={quote.price.deliveryFeeCentavos}
              free={quote.delivery.freeDeliveryFromThreshold}
            />
            {quote.price.serviceFeeCentavos > 0 ? (
              <Line label="Service fee" centavos={quote.price.serviceFeeCentavos} />
            ) : null}
            {quote.price.smallOrderFeeCentavos > 0 ? (
              <Line label="Small order fee" centavos={quote.price.smallOrderFeeCentavos} />
            ) : null}
            {quote.price.surgeCentavos > 0 ? (
              // Its own line with the band's own name — "Busy", "Very busy" —
              // rather than folded into the delivery fee. A fee that appears
              // without a name reads as a mistake, and a customer comparing
              // today's total against last week's needs to be able to see
              // which line moved.
              <Line
                label={quote.surge.label ?? 'Busy right now'}
                centavos={quote.price.surgeCentavos}
              />
            ) : null}
            {quote.price.tipCentavos > 0 ? (
              <Line label="Tip" centavos={quote.price.tipCentavos} />
            ) : null}
            {quote.price.promoDiscountCentavos > 0 ? (
              // Named with the code's own label — "₱50 off your first order" —
              // and not folded into the subtotal, for the same reason surge
              // gets its own line: a customer comparing this total against
              // last week's needs to see which line moved.
              <Line
                label={quote.promo.label ?? promoCode}
                centavos={-quote.price.promoDiscountCentavos}
              />
            ) : null}
            {/* Named by WHOSE benefit it is, not just by the label an
                operator typed. Two things confer benefits now and they
                rendered identically: a customer with a plan and a tier could
                not tell which had applied, and somebody who has never paid
                for Plus saw a bare label with no explanation of where their
                discount came from. */}
            {quote.price.appliedBenefits
              .filter((benefit) => benefit.amountCentavos > 0)
              .map((benefit) => (
                <Line
                  key={benefit.benefitId}
                  label={benefit.displayLabel}
                  note={
                    benefit.source === 'LOYALTY_TIER'
                      ? quote.price.loyaltyTierName ?? 'Your tier'
                      : 'TARA Plus'
                  }
                  centavos={-benefit.amountCentavos}
                />
              ))}
            {quote.price.walletCreditAppliedCentavos > 0 ? (
              <Line
                label="Credits"
                centavos={-quote.price.walletCreditAppliedCentavos}
              />
            ) : null}

            <div className="mt-2 flex justify-between border-t border-black/5 pt-2 text-sm font-bold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatCentavos(quote.price.totalCentavos)}</dd>
            </div>

            {quote.price.surgeCentavos > 0 ? (
              <p className="mt-1.5 text-[11px] text-ink-muted">
                {quote.surge.label} — more orders than riders right now. The
                extra {formatCentavos(quote.price.surgeCentavos)} goes to your
                rider.
              </p>
            ) : null}

            {quote.price.subscriptionBenefitsDropped ? (
              // The other half of the non-stacking rule. When the code wins,
              // the benefits are gone from this bill, and somebody whose free
              // delivery silently vanished would reasonably think their plan
              // had lapsed.
              //
              // It says "your benefits" rather than "your plan's", because
              // this flag also fires for a customer who has a TIER and no
              // plan — telling them their plan was set aside would be naming
              // something they have never had.
              <p className="mt-1.5 text-[11px] text-ink-muted">
                This code cannot be combined with your benefits, and it saves
                you more here — so they are set aside for this order only.
              </p>
            ) : null}

            {/* Why something the customer HAS is not on this bill. The
                screen showed only what applied, so a tier's free delivery on
                a fifth order of the month just was not there — and an absence
                with no explanation is what people ask support about. */}
            {withheldNotes.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {withheldNotes.map((note) => (
                  <p
                    key={note.key}
                    className={
                      note.actionable
                        ? 'text-[11px] leading-relaxed text-brand-700'
                        : 'text-[11px] leading-relaxed text-ink-muted'
                    }
                  >
                    {note.text}
                  </p>
                ))}
              </div>
            ) : null}

            {quote.price.creditBackCentavos > 0 ? (
              <p className="mt-1.5 text-[11px] text-emerald-700">
                You will get {formatCentavos(quote.price.creditBackCentavos)} in credits
                after this order.
              </p>
            ) : null}
          </dl>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">Kinakalkula…</p>
        )}
      </section>

      {placeError ? (
        <p role="alert" className="text-xs leading-relaxed text-rose-700">
          {placeError}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onPlace}
        disabled={!canPlace}
        className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {isPlacing
          ? 'Placing…'
          : quote
            ? `Place order · ${formatCentavos(quote.price.totalCentavos)}`
            : 'Place order'}
      </button>
    </div>
  );
}

function Line({
  label,
  centavos,
  free,
  note,
}: {
  label: string;
  centavos: number;
  free?: boolean;
  /** Where this line came from — the tier's name, or the plan's. */
  note?: string;
}) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <dt className="min-w-0 text-ink-muted">
        {label}
        {note ? (
          <span className="ml-1.5 rounded bg-surface-sunken px-1 py-0.5 text-[10px] font-medium text-ink-faint">
            {note}
          </span>
        ) : null}
      </dt>
      <dd className="shrink-0 tabular-nums">
        {free && centavos === 0 ? (
          <span className="text-emerald-700">Libre</span>
        ) : (
          <>
            {centavos < 0 ? '−' : ''}
            {formatCentavos(Math.abs(centavos))}
          </>
        )}
      </dd>
    </div>
  );
}
