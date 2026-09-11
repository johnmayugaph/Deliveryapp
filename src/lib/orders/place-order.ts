import {
  FulfilmentAddressRole,
  OrderActor,
  PaymentEventType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServiceKey,
  type Order,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { assertServiceOrderable } from '@/lib/services/registry';
import { parseOrderDetails, type FoodItemSnapshot } from '@/lib/orders/details';
import { submitOrder } from '@/lib/orders/state-machine';
import { recordPaymentEvent } from '@/lib/payments/events';
import { isPrepaid } from '@/lib/payments/policy';
import { getLifecycle } from '@/lib/orders/transitions';
import { commitBenefitUsage, quoteOrderPrice, type PriceQuote } from '@/lib/pricing/checkout';
import { quoteDeliveryFee, type DeliveryQuote } from '@/lib/pricing/delivery-fee';
import { currentSurge } from '@/lib/pricing/surge';
import { PromoNoLongerValidError, consumePromoCode } from '@/lib/promo/consume';
import { withSerializationRetry } from '@/lib/db/serializable';
import { resolvePromoForOrder, type ResolvedPromo } from '@/lib/promo/resolve';
import type { PromoOrderFacts } from '@/lib/promo/policy';
import type { SurgeCharge } from '@/lib/pricing/surge-policy';
import { spendOnOrder } from '@/lib/wallet/ledger';
import { bumpAddressUsage } from '@/lib/addresses/usage';
import { generateOrderNumber } from '@/lib/reference-numbers';
import { resolveChoices, unitPriceWithChoices } from '@/lib/merchant/option-policy';
import { withinOpeningHours } from '@/lib/merchant/opening-hours';

/**
 * Order placement for the FOOD vertical.
 *
 * The one rule that matters here: **prices are re-read from the database, never
 * taken from the client.** A request says "two of menu item X"; it does not get
 * to say what X costs. Everything the client sends is an identifier or a
 * quantity, and every peso is computed server-side. `quoteCheckout` and
 * `placeOrder` share that computation, so the price displayed at checkout is by
 * construction the price charged.
 */

export class EmptyCartError extends Error {
  constructor() {
    super('An order needs at least one item');
    this.name = 'EmptyCartError';
  }
}

export class StoreUnavailableError extends Error {
  constructor(readonly storeId: string, reason: string) {
    super(`Store "${storeId}" cannot take this order: ${reason}`);
    this.name = 'StoreUnavailableError';
  }
}

export class UnavailableItemsError extends Error {
  constructor(readonly menuItemIds: readonly string[]) {
    super(
      `These items are no longer available: ${menuItemIds.join(', ')}. ` +
        'The cart was priced against a stale menu.',
    );
    this.name = 'UnavailableItemsError';
  }
}

export class AddressNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressNotUsableError';
  }
}

/**
 * The market got busier between rendering the price and placing the order.
 *
 * The alternative was charging the higher figure, which is the one thing this
 * whole feature is arranged to prevent: a customer reads ₱49, taps once, and
 * is billed ₱69. So placement refuses, the screen re-quotes, and the customer
 * agrees to the new number or does not. Never charging more than was shown is
 * worth an occasional retry.
 *
 * Only fires upward. A surge that FELL between render and placement charges
 * the lower amount without comment.
 */
export class SurgeChangedError extends Error {
  constructor(
    readonly shownCentavos: number,
    readonly nowCentavos: number,
  ) {
    super(
      'It got busier while you were ordering, so the fee went up. ' +
        'Check the new total and place the order again.',
    );
    this.name = 'SurgeChangedError';
  }
}

export class InsufficientCreditsForPaymentError extends Error {
  constructor(readonly shortfallCentavos: number) {
    super(
      `Paying with credits requires the balance to cover the whole order; ` +
        `short by ${shortfallCentavos} centavos. Choose cash on delivery instead.`,
    );
    this.name = 'InsufficientCreditsForPaymentError';
  }
}

/** What the client is allowed to tell us: identifiers and quantities only. */
export interface CartLineInput {
  menuItemId: string;
  quantity: number;
  /**
   * Chosen `MenuItemOption` ids. Ids, not prices: what each one adds is read
   * from the database here, so a customer who edits their own cart changes
   * what they see and not what they pay.
   */
  optionIds?: readonly string[];
  /** "No onions". Passed to the kitchen verbatim. */
  notes?: string;
}

export interface CheckoutInput {
  customerId: string;
  storeId: string;
  lines: readonly CartLineInput[];
  /** An entry in the customer's own address book. */
  dropoffAddressId: string;
  paymentMethod: PaymentMethod;
  /** Spend available credits against this order. */
  useCredits?: boolean;
  tipCentavos?: number;
  includeCutlery?: boolean;
  merchantNotes?: string;
  /**
   * The surge the customer was SHOWN, as a ceiling on what placement may
   * charge. Set by the checkout screen from the quote it rendered.
   *
   * This is a client-supplied number and is treated accordingly: it is never
   * used as a price, only compared against the surge placement independently
   * looked up. So the only thing a tampered value can do is make placement
   * REFUSE — sending a lower figure than the real one does not buy a cheaper
   * order, it buys an error. Absent means "charge whatever is current", which
   * is right for a caller with no screen (a script, a test) and wrong for a
   * customer, which is why the form always sends it.
   */
  acceptedSurgeCentavos?: number;
  /**
   * A promo code the customer typed, verbatim.
   *
   * Unlike `acceptedSurgeCentavos` this is not a number and never becomes one
   * here: the client sends the STRING and the discount is resolved
   * server-side from the code's own rules. A client that could send a
   * discount could send its own price.
   *
   * Resolving is free and consuming is not — see `promo/resolve.ts`. This is
   * read on every quote and spent exactly once, inside the placement
   * transaction.
   */
  promoCode?: string;
  /**
   * The promo discount the customer was SHOWN, as a FLOOR on what placement
   * may give.
   *
   * The mirror image of `acceptedSurgeCentavos`, for the same reason and with
   * the same safety: a client-supplied number that is never used as a price,
   * only compared against the discount placement independently resolved. So
   * the only thing a tampered value can do is make placement REFUSE — sending
   * a bigger figure than the code allows does not buy a bigger discount, it
   * buys an error.
   *
   * Without it, a code that ran out between the render and the tap would be
   * quoted at zero by placement's own re-quote, and the order would go through
   * at full price with nothing said. The customer read ₱50 off, tapped once,
   * and paid ₱50 more. That is the exact failure the surge ceiling exists to
   * prevent, arriving from the other direction.
   */
  acceptedPromoDiscountCentavos?: number;
}

export interface CheckoutQuote {
  serviceType: ServiceKey;
  storeId: string;
  storeName: string;
  items: FoodItemSnapshot[];
  merchantPreparationMinutes: number;
  delivery: DeliveryQuote;
  /** What the market added, and why — for the line on the customer's bill. */
  surge: SurgeCharge;
  /**
   * The code, what it takes off, and why it does not — for the checkout
   * screen's own line. `price.promoDiscountCentavos` is what was ACTUALLY
   * applied, which is zero when a non-stacking code lost to the customer's
   * plan; this is what the code itself offered.
   */
  promo: ResolvedPromo;
  /**
   * The order facts the promo was resolved against, so placement re-resolves
   * against the same ones rather than rebuilding them and drifting.
   */
  promoBasis: PromoOrderFacts;
  price: PriceQuote;
  /** Set when `paymentMethod` is WALLET_CREDIT but the balance falls short. */
  creditShortfallCentavos: number;
}

const MAX_QUANTITY_PER_LINE = 50;

/**
 * Resolves a cart against the live catalogue and prices it.
 *
 * Reads only. Safe to call on every checkout render — and it must be, because
 * `placeOrder` calls it again to get the number it actually charges.
 */
export async function quoteCheckout(input: CheckoutInput): Promise<CheckoutQuote> {
  if (input.lines.length === 0) {
    throw new EmptyCartError();
  }

  const store = await prisma.store.findUnique({
    where: { id: input.storeId },
    include: { city: true },
  });
  if (!store) {
    throw new StoreUnavailableError(input.storeId, 'no such store');
  }
  if (!store.isVisible) {
    throw new StoreUnavailableError(input.storeId, 'not visible');
  }
  if (!store.isOpen) {
    throw new StoreUnavailableError(input.storeId, 'closed');
  }
  // The posted hours, checked HERE and not only on the listing. A shop greyed
  // out on the list but still orderable at checkout is the failure this gate
  // exists to prevent — and the schedule is derived from the clock, so there
  // is no job whose last run this depends on.
  if (!withinOpeningHours(store, new Date())) {
    throw new StoreUnavailableError(input.storeId, 'outside opening hours');
  }
  if (!store.serviceKeys.includes(ServiceKey.FOOD)) {
    throw new StoreUnavailableError(input.storeId, 'does not serve FOOD');
  }

  // The service must be live in the store's city before we quote anything.
  await assertServiceOrderable(ServiceKey.FOOD, store.cityId);

  const dropoff = await prisma.address.findUnique({
    where: { id: input.dropoffAddressId },
    include: { city: true },
  });
  if (!dropoff || dropoff.archivedAt !== null) {
    throw new AddressNotUsableError('That address is no longer in your address book');
  }
  // An address id from another account is not an authorisation.
  if (dropoff.userId !== input.customerId) {
    throw new AddressNotUsableError('That address belongs to someone else');
  }
  if (dropoff.cityId !== store.cityId) {
    throw new AddressNotUsableError(
      `This store delivers within ${store.city.name}, and that address is in ${dropoff.city.name}`,
    );
  }

  // --- Prices come from HERE, not from the request. ---
  const requestedIds = Array.from(new Set(input.lines.map((line) => line.menuItemId)));
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: requestedIds }, storeId: store.id },
    // The choices come with the dish, and only through the dish: an option id
    // that belongs to another item — or another shop — is not in this result,
    // so `resolveChoices` refuses it rather than pricing it.
    include: {
      optionGroups: {
        orderBy: { sortOrder: 'asc' },
        include: { options: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  const menuById = new Map(menuItems.map((item) => [item.id, item]));

  const unavailable = requestedIds.filter((id) => {
    const item = menuById.get(id);
    return !item || !item.isAvailable;
  });
  if (unavailable.length > 0) {
    throw new UnavailableItemsError(unavailable);
  }

  const items: FoodItemSnapshot[] = input.lines.map((line) => {
    const item = menuById.get(line.menuItemId)!;
    const quantity = Math.floor(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
      throw new RangeError(
        `Quantity for "${item.name}" must be a whole number between 1 and ${MAX_QUANTITY_PER_LINE}`,
      );
    }
    // Every delta is read from the row, and the group rules are checked
    // again: a required size still has to have been chosen, an answer that
    // ran out while the cart sat open is refused by name, and an id from
    // somewhere else is not on this dish. This is the only place any of that
    // is authoritative — the store page's arithmetic is for reading.
    const choices = resolveChoices(item.optionGroups, line.optionIds ?? []);
    const unitPriceCentavos = unitPriceWithChoices(item.priceCentavos, choices);

    return {
      menuItemId: item.id,
      name: item.name,
      unitPriceCentavos,
      quantity,
      options: choices.map((choice) => ({
        name: choice.name,
        priceDeltaCentavos: choice.priceDeltaCentavos,
      })),
      ...(line.notes?.trim() ? { notes: line.notes.trim().slice(0, 500) } : {}),
      lineTotalCentavos: unitPriceCentavos * quantity,
    };
  });

  const subtotalCentavos = items.reduce((total, item) => total + item.lineTotalCentavos, 0);

  const delivery = await quoteDeliveryFee({
    serviceType: ServiceKey.FOOD,
    cityId: store.cityId,
    subtotalCentavos,
    pickup: { latitude: store.latitude, longitude: store.longitude },
    dropoff: { latitude: dropoff.latitude, longitude: dropoff.longitude },
  });

  // Tips are the one amount the customer does set, so bound it.
  const tipCentavos = Math.max(0, Math.min(Math.floor(input.tipCentavos ?? 0), 100_000));

  // Surge is READ, never measured here. The market is counted once a minute by
  // the cron and written to a snapshot; a quote looks up the newest one. That
  // is what makes the number on the checkout screen and the number placement
  // charges the same number — counting the queue per quote would let them
  // disagree by a few seconds and show one price while charging another.
  //
  // Keyed on the STORE's city, matching the delivery fee rule the surge is
  // added to: a rider is drawn to a job by where it starts.
  const surge = await currentSurge(ServiceKey.FOOD, store.cityId);

  const promoBasis: PromoOrderFacts = {
    serviceType: ServiceKey.FOOD,
    cityId: store.cityId,
    storeId: store.id,
    subtotalCentavos,
    // The fee BEFORE any waiver. `applyBenefits` keeps the fee on the order at
    // full value and records a waiver as a discount line, so a FREE_DELIVERY
    // code takes off the figure that is actually charged. Passing a
    // subscription-waived zero here would make a free-delivery code worth
    // nothing to the customer who already pays us monthly.
    deliveryFeeCentavos: delivery.deliveryFeeCentavos,
  };

  // Resolved, never consumed. This runs on every checkout render — a keystroke
  // in the code field must not burn the one use the customer gets, which is
  // the mistake `commitBenefitUsage` exists to avoid for a monthly allowance.
  // The use is spent in `placeOrder`'s transaction, where the caps can hold.
  const promo = await resolvePromoForOrder({
    code: input.promoCode,
    customerId: input.customerId,
    order: promoBasis,
  });

  const price = await quoteOrderPrice({
    serviceType: ServiceKey.FOOD,
    customerId: input.customerId,
    cityId: store.cityId,
    subtotalCentavos,
    baseDeliveryFeeCentavos: delivery.deliveryFeeCentavos,
    serviceFeeCentavos: delivery.serviceFeeCentavos,
    smallOrderFeeCentavos: delivery.smallOrderFeeCentavos,
    surgeCentavos: surge.surgeCentavos,
    tipCentavos,
    promoDiscountCentavos: promo.discountCentavos,
    promoStacksWithSubscription: promo.stacksWithSubscription,
    // Credits cover as much as they can; the engine caps at what is owed.
    requestedWalletCreditCentavos: input.useCredits ? Number.MAX_SAFE_INTEGER : 0,
  });

  // Credits are the only non-cash rail, so paying with them is all or nothing.
  const creditShortfallCentavos =
    input.paymentMethod === PaymentMethod.WALLET_CREDIT ? price.totalCentavos : 0;

  return {
    serviceType: ServiceKey.FOOD,
    storeId: store.id,
    storeName: store.name,
    items,
    merchantPreparationMinutes: store.preparationMinutes,
    delivery,
    surge,
    promo,
    promoBasis,
    price,
    creditShortfallCentavos,
  };
}

/**
 * Places an order.
 *
 * Re-quotes rather than trusting anything computed earlier, then does the whole
 * thing in ONE transaction: create the order and its address snapshots, move it
 * to the vertical's submitted state, consume subscription benefits, spend
 * credits, and record address usage. A half-placed order — credits taken, no
 * order; or an order with no benefit usage recorded — is the failure mode worth
 * paying a transaction for.
 *
 * Serializable, because it touches the credits ledger and the ledger's
 * correctness depends on nobody reading a stale balance.
 */
export async function placeOrder(input: CheckoutInput): Promise<{
  order: Order;
  quote: CheckoutQuote;
}> {
  // One attempt is the WHOLE of placement, quote included, so a retry prices
  // the order against fresh state rather than replaying a stale quote. That
  // matters here specifically: a retry re-resolves the promo code against a
  // redemption count that has moved, and the accepted-discount floor below is
  // what stops the customer being charged more than they were shown.
  return withSerializationRetry(() => attemptPlacement(input));
}

/**
 * One attempt. Everything it writes is inside one serializable transaction.
 *
 * Placement contends per CUSTOMER on their own credits ledger, and — since
 * promo codes — across EVERYBODY on a shared redemption count. Four
 * concurrent placements against one code produced three `P2034` failures and
 * one order before the retry above existed. The contention is not a mistake to
 * optimise away: it is what makes a campaign's cap exact, and counting outside
 * the transaction would go over budget silently instead.
 */
async function attemptPlacement(input: CheckoutInput): Promise<{
  order: Order;
  quote: CheckoutQuote;
}> {
  const quote = await quoteCheckout(input);

  // Before anything is written: never charge more surge than was displayed.
  // The re-quote above is authoritative for the PRICE; this only decides
  // whether to proceed at it.
  if (
    input.acceptedSurgeCentavos !== undefined &&
    quote.surge.surgeCentavos > input.acceptedSurgeCentavos
  ) {
    throw new SurgeChangedError(
      input.acceptedSurgeCentavos,
      quote.surge.surgeCentavos,
    );
  }

  // And never give LESS discount than was displayed. The mirror of the check
  // above: placement refuses so the screen can re-quote and show the real
  // total, rather than billing the difference without comment.
  if (
    input.acceptedPromoDiscountCentavos !== undefined &&
    quote.price.promoDiscountCentavos < input.acceptedPromoDiscountCentavos
  ) {
    throw new PromoNoLongerValidError(
      quote.promo.code,
      quote.promo.refusal === null
        ? 'it does not take off as much as it did a moment ago.'
        : 'it is no longer available.',
    );
  }

  if (quote.creditShortfallCentavos > 0) {
    throw new InsufficientCreditsForPaymentError(quote.creditShortfallCentavos);
  }

  const details = parseOrderDetails(ServiceKey.FOOD, {
    storeId: quote.storeId,
    storeName: quote.storeName,
    items: quote.items,
    merchantPreparationMinutes: quote.merchantPreparationMinutes,
    includeCutlery: input.includeCutlery ?? false,
    ...(input.merchantNotes?.trim()
      ? { merchantNotes: input.merchantNotes.trim().slice(0, 500) }
      : {}),
  });

  const [store, dropoff] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: quote.storeId },
      include: { city: true },
    }),
    prisma.address.findUniqueOrThrow({
      where: { id: input.dropoffAddressId },
      include: { city: true },
    }),
  ]);

  const order = await prisma.$transaction(
    async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber: generateOrderNumber(),
          serviceType: ServiceKey.FOOD,
          customerId: input.customerId,
          // Starts in the lifecycle's initial state; `submitOrder` moves it on.
          status: getLifecycle(ServiceKey.FOOD).initialStatus,
          subtotalCentavos: quote.price.subtotalCentavos,
          deliveryFeeCentavos: quote.price.deliveryFeeCentavos,
          serviceFeeCentavos: quote.price.serviceFeeCentavos,
          smallOrderFeeCentavos: quote.price.smallOrderFeeCentavos,
          surgeCentavos: quote.price.surgeCentavos,
          // The reason, alongside the money, for the life of the receipt.
          surgeLabel: quote.surge.label,
          tipCentavos: quote.price.tipCentavos,
          promoDiscountCentavos: quote.price.promoDiscountCentavos,
          subscriptionDiscountCentavos: quote.price.subscriptionDiscountCentavos,
          loyaltyDiscountCentavos: quote.price.loyaltyDiscountCentavos,
          walletCreditAppliedCentavos: quote.price.walletCreditAppliedCentavos,
          totalCentavos: quote.price.totalCentavos,
          paymentMethod: input.paymentMethod,
          // Nothing is owed when credits covered it; otherwise cash on arrival.
          paymentStatus:
            quote.price.totalCentavos === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
          details: details as Prisma.InputJsonValue,
          etaAt: estimateEta(quote),
          addresses: {
            create: [
              {
                role: FulfilmentAddressRole.PICKUP,
                label: store.name,
                line1: store.addressLine,
                cityId: store.cityId,
                cityName: store.city.name,
                province: store.city.province,
                latitude: store.latitude,
                longitude: store.longitude,
                contactName: store.name,
                contactPhone: store.contactPhone,
              },
              {
                role: FulfilmentAddressRole.DROPOFF,
                sourceAddressId: dropoff.id,
                label: dropoff.label,
                line1: dropoff.line1,
                line2: dropoff.line2,
                barangay: dropoff.barangay,
                cityId: dropoff.cityId,
                cityName: dropoff.city.name,
                province: dropoff.province,
                postalCode: dropoff.postalCode,
                landmark: dropoff.landmark,
                deliveryNotes: dropoff.deliveryNotes,
                latitude: dropoff.latitude,
                longitude: dropoff.longitude,
                contactName: dropoff.contactName,
                contactPhone: dropoff.contactPhone,
              },
            ],
          },
        },
      });

      // The code is spent HERE and nowhere else: inside the serializable
      // transaction that creates the order, which is the only place a
      // campaign's caps can actually hold. A hundred uses and two hundred
      // people at checkout all hold a valid quote; the count that decides is
      // the one taken where the orders are created, one at a time.
      //
      // `price.promoDiscountCentavos` rather than `promo.discountCentavos`:
      // zero means the code was offered and not applied — a non-stacking code
      // that lost to the customer's plan — and an unapplied code must not be
      // spent.
      if (quote.price.promoDiscountCentavos > 0) {
        await consumePromoCode(
          {
            code: quote.promo.code,
            customerId: input.customerId,
            orderId: created.id,
            order: quote.promoBasis,
            appliedCentavos: quote.price.promoDiscountCentavos,
          },
          tx,
        );
      }

      // A prepaid order waits for the money before it reaches the shop.
      // `totalCentavos > 0` matters: credits can cover an order completely, and
      // holding an order that owes nothing would wait forever for a transfer
      // nobody needs to make.
      const awaitPayment =
        isPrepaid(input.paymentMethod) && quote.price.totalCentavos > 0;

      // The state machine decides where a FOOD order goes next, not us.
      const submitted = await submitOrder(
        {
          orderId: created.id,
          serviceType: ServiceKey.FOOD,
          actor: OrderActor.CUSTOMER,
          actorUserId: input.customerId,
          awaitPayment,
        },
        tx,
      );

      if (awaitPayment) {
        // Recorded inside the placement transaction: an order parked in
        // PENDING_PAYMENT with no event saying why is an order support cannot
        // explain to the person waiting.
        await recordPaymentEvent(
          {
            orderId: created.id,
            type: PaymentEventType.CHARGE_REQUESTED,
            method: input.paymentMethod,
            actorUserId: input.customerId,
            idempotencyKey: `charge-requested:${created.id}`,
          },
          tx,
        );
      }

      // Deliberately NOT gated on `subscriptionId`. It used to be, which was
      // correct while a subscription was the only thing that conferred a
      // benefit — and became a silent hole the moment a loyalty tier could:
      // a customer with a tier and no plan would have had no usage row
      // written, so their monthly allowance would never be spent and their
      // receipt would carry no benefit line. Nobody would notice until the
      // free deliveries never ran out. Found by the compiler when
      // `commitBenefitUsage` started requiring the customer id.
      if (quote.price.appliedBenefits.length > 0) {
        await commitBenefitUsage(
          {
            subscriptionId: quote.price.subscriptionId,
            customerId: input.customerId,
            orderId: created.id,
            appliedBenefits: quote.price.appliedBenefits,
          },
          { client: tx },
        );
      }

      if (quote.price.walletCreditAppliedCentavos > 0) {
        await spendOnOrder(
          {
            userId: input.customerId,
            orderId: created.id,
            amountCentavos: quote.price.walletCreditAppliedCentavos,
            description: `Order ${created.orderNumber} · ${quote.storeName}`,
            // Keyed to the order, so a retried placement cannot double-charge.
            idempotencyKey: `order-payment:${created.id}`,
          },
          tx,
        );
      }

      await bumpAddressUsage(dropoff.id, tx);

      return submitted;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return { order, quote };
}

/**
 * A first ETA: the merchant's prep time plus travel at a conservative city
 * average. Replaced by live rider tracking once a partner is assigned.
 */
function estimateEta(quote: CheckoutQuote): Date {
  const AVERAGE_SPEED_METERS_PER_MINUTE = 300; // ~18km/h through traffic
  const travelMinutes = Math.ceil(
    quote.delivery.distanceMeters / AVERAGE_SPEED_METERS_PER_MINUTE,
  );
  const totalMinutes = quote.merchantPreparationMinutes + travelMinutes + 5;
  return new Date(Date.now() + totalMinutes * 60_000);
}

/** Re-exported so a caller can accept a transaction client without importing prisma. */
export type { PrismaTransactionClient };
