import { ServiceKey } from '@prisma/client';
import { z } from 'zod';

/**
 * The `Order.details` container.
 *
 * `Order` holds everything shared by every vertical as real columns. Everything
 * that is specific to one vertical lives in this JSON container, whose shape
 * varies by `serviceType`. Getting the container right now means the other four
 * verticals slot in without a migration to the base table.
 *
 * Only the FOOD shape is implemented. The other four are declared here as
 * documented placeholders so the container's shape is settled from the start
 * and `parseOrderDetails` fails loudly rather than silently accepting a payload
 * nobody has designed yet.
 */

// -----------------------------------------------------------------------------
// FOOD — implemented
// -----------------------------------------------------------------------------

/**
 * An item as it was at the moment of ordering. Snapshotted, not referenced: a
 * merchant raising a price or renaming a dish must not rewrite a receipt from
 * last month. `menuItemId` is kept for analytics but is not the source of truth
 * for anything the customer sees.
 */
export const foodItemSnapshotSchema = z.object({
  menuItemId: z.string().min(1),
  name: z.string().min(1),
  /** Unit price at order time, centavos. */
  unitPriceCentavos: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  /** Chosen options/add-ons, each with its own price delta at order time. */
  options: z
    .array(
      z.object({
        name: z.string().min(1),
        priceDeltaCentavos: z.number().int(),
      }),
    )
    .default([]),
  /** "No onions", "extra rice". Passed to the merchant verbatim. */
  notes: z.string().max(500).optional(),
  /** unitPrice * quantity, plus option deltas. Stored so a receipt needs no maths. */
  lineTotalCentavos: z.number().int().nonnegative(),
});

export const foodOrderDetailsSchema = z.object({
  storeId: z.string().min(1),
  /** Store name at order time, so history survives a rebrand. */
  storeName: z.string().min(1),
  items: z.array(foodItemSnapshotSchema).min(1),
  /** The merchant's quoted preparation time, in minutes, at order time. */
  merchantPreparationMinutes: z.number().int().nonnegative(),
  /** Whether the customer asked for cutlery — merchants ask for this constantly. */
  includeCutlery: z.boolean().default(false),
  /** Note to the kitchen, distinct from the rider's delivery notes. */
  merchantNotes: z.string().max(500).optional(),
});

export type FoodItemSnapshot = z.infer<typeof foodItemSnapshotSchema>;
export type FoodOrderDetails = z.infer<typeof foodOrderDetailsSchema>;

// -----------------------------------------------------------------------------
// MART, PARCEL, PABILI, RIDE — planned shapes, not yet implemented
// -----------------------------------------------------------------------------

/**
 * Shapes we have committed to but not built. Written down as types so the
 * container's design is reviewable today, and so the day we implement one the
 * only question left is the UI.
 */

/** MART: a shopper buys from a store catalogue on the customer's behalf. */
export interface PlannedMartOrderDetails {
  storeId: string;
  storeName: string;
  items: FoodItemSnapshot[];
  /** What the shopper should do when an item is out of stock. */
  substitutionPreference: 'NO_SUBSTITUTION' | 'SIMILAR_ITEM' | 'CALL_ME';
  substitutionNotes?: string;
}

/** PARCEL: point-to-point movement of a thing. No merchant leg at all. */
export interface PlannedParcelOrderDetails {
  packageDescription: string;
  declaredValueCentavos: number;
  sizeCategory: 'SMALL' | 'MEDIUM' | 'LARGE' | 'BULKY';
  weightGrams?: number;
  recipientName: string;
  recipientPhone: string;
  /** Whether the sender requires a signature or photo at handover. */
  proofOfDeliveryRequired: boolean;
}

/** PABILI: the partner buys things we have no catalogue for. */
export interface PlannedPabiliOrderDetails {
  /** Free text, because the whole point is that there is no catalogue. */
  shoppingListText: string;
  estimatedBudgetCentavos: number;
  /** Hard ceiling the partner may not exceed without customer approval. */
  budgetCeilingCentavos: number;
  /** Filled in after shopping, from the receipt photo. */
  actualReceiptCentavos?: number;
  receiptPhotoUrl?: string;
}

/** RIDE: moving a person. */
export interface PlannedRideOrderDetails {
  passengerCount: number;
  vehicleClass: 'MOTORCYCLE' | 'SEDAN' | 'MPV' | 'VAN';
  /** Encoded polyline of the quoted route. */
  routePolyline?: string;
  estimatedDistanceMeters?: number;
  estimatedDurationSeconds?: number;
}

/** The union of every vertical's details shape. */
export type OrderDetails =
  | FoodOrderDetails
  | PlannedMartOrderDetails
  | PlannedParcelOrderDetails
  | PlannedPabiliOrderDetails
  | PlannedRideOrderDetails;

// -----------------------------------------------------------------------------
// The registry of details shapes
// -----------------------------------------------------------------------------

export type DetailsImplementationStatus = 'IMPLEMENTED' | 'PLANNED';

interface OrderDetailsSpec {
  status: DetailsImplementationStatus;
  /** Present only when `status` is IMPLEMENTED. */
  schema: z.ZodTypeAny | null;
  /**
   * The fields the planned shape will carry. Kept as data so the docs page and
   * the roadmap can render it without anyone maintaining a second copy.
   */
  plannedFields: readonly string[];
}

/**
 * Keyed by every `ServiceKey`, so adding a sixth vertical is a compile error
 * here rather than a runtime surprise in checkout.
 */
export const ORDER_DETAILS_SPECS: Readonly<Record<ServiceKey, OrderDetailsSpec>> = {
  [ServiceKey.FOOD]: {
    status: 'IMPLEMENTED',
    schema: foodOrderDetailsSchema,
    plannedFields: ['storeId', 'items', 'merchantPreparationMinutes'],
  },
  [ServiceKey.MART]: {
    status: 'PLANNED',
    schema: null,
    plannedFields: ['storeId', 'items', 'substitutionPreference'],
  },
  [ServiceKey.PARCEL]: {
    status: 'PLANNED',
    schema: null,
    plannedFields: [
      'packageDescription',
      'declaredValueCentavos',
      'sizeCategory',
      'recipientName',
      'recipientPhone',
    ],
  },
  [ServiceKey.PABILI]: {
    status: 'PLANNED',
    schema: null,
    plannedFields: [
      'shoppingListText',
      'estimatedBudgetCentavos',
      'budgetCeilingCentavos',
      'actualReceiptCentavos',
    ],
  },
  [ServiceKey.RIDE]: {
    status: 'PLANNED',
    schema: null,
    plannedFields: ['passengerCount', 'vehicleClass', 'routePolyline'],
  },
};

export class ServiceDetailsNotImplementedError extends Error {
  constructor(readonly serviceType: ServiceKey, readonly plannedFields: readonly string[]) {
    super(
      `Order details for service "${serviceType}" are not implemented yet. ` +
        `The planned shape is: ${plannedFields.join(', ')}.`,
    );
    this.name = 'ServiceDetailsNotImplementedError';
  }
}

export class InvalidOrderDetailsError extends Error {
  constructor(readonly serviceType: ServiceKey, readonly issues: z.ZodIssue[]) {
    super(
      `Order details for service "${serviceType}" are invalid: ` +
        issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; '),
    );
    this.name = 'InvalidOrderDetailsError';
  }
}

/**
 * Validates and normalises a details payload for a given vertical. Looks the
 * shape up in `ORDER_DETAILS_SPECS` — it does not know what food is.
 */
export function parseOrderDetails(serviceType: ServiceKey, input: unknown): OrderDetails {
  const spec = ORDER_DETAILS_SPECS[serviceType];

  if (spec.status !== 'IMPLEMENTED' || spec.schema === null) {
    throw new ServiceDetailsNotImplementedError(serviceType, spec.plannedFields);
  }

  const result = spec.schema.safeParse(input);
  if (!result.success) {
    throw new InvalidOrderDetailsError(serviceType, result.error.issues);
  }

  return result.data as OrderDetails;
}

export function isDetailsShapeImplemented(serviceType: ServiceKey): boolean {
  return ORDER_DETAILS_SPECS[serviceType].status === 'IMPLEMENTED';
}

/**
 * Reads a persisted `Order.details` back as a FOOD payload. Typed narrowly on
 * purpose: a caller that wants food fields should have to say so, and should
 * get a clear failure if the row is not a food order.
 */
export function readFoodDetails(serviceType: ServiceKey, details: unknown): FoodOrderDetails {
  const parsed = foodOrderDetailsSchema.safeParse(details);
  if (!parsed.success) {
    throw new InvalidOrderDetailsError(serviceType, parsed.error.issues);
  }
  return parsed.data;
}

/**
 * A vertical-agnostic summary line for the order history and the active-order
 * strip, derived without branching on the service key. Falls back to the
 * service's own display name, which is exactly what a not-yet-implemented
 * vertical should show.
 */
export function summariseDetails(details: unknown, fallback: string): string {
  if (details === null || typeof details !== 'object') {
    return fallback;
  }
  const record = details as Record<string, unknown>;

  const storeName = record.storeName;
  if (typeof storeName === 'string' && storeName.length > 0) {
    const items = record.items;
    if (Array.isArray(items) && items.length > 0) {
      const count = items.reduce<number>((total, item) => {
        const quantity = (item as { quantity?: unknown }).quantity;
        return total + (typeof quantity === 'number' ? quantity : 1);
      }, 0);
      return `${storeName} · ${count} ${count === 1 ? 'item' : 'items'}`;
    }
    return storeName;
  }

  const packageDescription = record.packageDescription;
  if (typeof packageDescription === 'string' && packageDescription.length > 0) {
    return packageDescription;
  }

  const shoppingListText = record.shoppingListText;
  if (typeof shoppingListText === 'string' && shoppingListText.length > 0) {
    return shoppingListText.split('\n')[0] ?? fallback;
  }

  return fallback;
}
