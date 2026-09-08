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
import type { SurgeCharge } from '@/lib/pricing/surge-policy';
import { spendOnOrder } from '@/lib/wallet/ledger';
import { bumpAddressUsage } from '@/lib/addresses/usage';
import { generateOrderNumber } from '@/lib/reference-numbers';
import { resolveChoices, unitPriceWithChoices } from '@/lib/merchant/option-policy';

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

      if (quote.price.subscriptionId && quote.price.appliedBenefits.length > 0) {
        await commitBenefitUsage(
          {
            subscriptionId: quote.price.subscriptionId,
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
