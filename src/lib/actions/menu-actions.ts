'use server';

import { revalidatePath } from 'next/cache';
import { StoreRole } from '@prisma/client';
import {
  InsufficientStoreRoleError,
  NoStoreAccessError,
  requireStoreAccess,
} from '@/lib/merchant/access';
import {
  addMenuItem,
  editMenuItem,
  moveCategory,
  moveMenuItem,
  removeMenuItem,
  renameCategory,
} from '@/lib/merchant/menu';
import {
  CategoryNotFoundError,
  DuplicateItemNameError,
  ItemNameRequiredError,
  MenuFullError,
  MenuItemChangedError,
  MenuItemNotFoundError,
  ComparePriceNotHigherError,
  parseComparePrice,
  PriceNotUnderstoodError,
  PriceOutOfRangeError,
  normaliseItemName,
  parsePrice,
  type Direction,
} from '@/lib/merchant/menu-policy';
import { centavosFromPesoInput } from '@/lib/money';
import {
  MenuItemNotInStoreError,
  putMenuItemImage,
  removeMenuItemImage,
} from '@/lib/media/menu-images';
import {
  ImageTooLargeError,
  ImageWrongShapeError,
  MAX_IMAGE_BYTES,
  NotAnImageError,
} from '@/lib/media/image-bytes';

/**
 * A shop editing its own menu.
 *
 * Every action takes a store id from the form and then throws it away as an
 * authorisation input: `requireStoreAccess` resolves the caller's real
 * membership and role from the session, so a form field cannot buy access to
 * somebody else's shop.
 *
 * **MANAGER and above for all of it.** Marking the pork out of stock is a
 * shift decision and stays at STAFF, in `merchant-actions.ts` — but adding,
 * renaming, repricing and deleting dishes is the shop's shopfront, and the
 * person on the counter at 8pm should not be able to change what the business
 * sells. The check is here AND in nothing else: the screen hides the controls
 * for staff, and a hidden control is not an authorisation check, so the server
 * refuses independently.
 *
 * Kept out of `merchant-actions.ts` because that file is about moving an order
 * through its lifecycle and authorises against the ORDER's store; this one
 * authorises against a store directly. Two different questions, two files.
 */

export interface MenuActionResult {
  ok: boolean;
  message: string;
}

/**
 * Turns the policy's refusals into sentences a shop owner can act on.
 *
 * Anything not listed is rethrown, so a real bug reaches the error monitor
 * instead of being reported to the merchant as "please try again" — a failure
 * that apologises is a failure nobody fixes.
 */
function explain(error: unknown): MenuActionResult {
  if (
    error instanceof ItemNameRequiredError ||
    error instanceof PriceNotUnderstoodError ||
    error instanceof PriceOutOfRangeError ||
    error instanceof ComparePriceNotHigherError ||
    error instanceof DuplicateItemNameError ||
    error instanceof MenuFullError ||
    error instanceof MenuItemNotFoundError ||
    error instanceof MenuItemChangedError ||
    error instanceof CategoryNotFoundError
  ) {
    return { ok: false, message: error.message };
  }
  if (
    error instanceof NotAnImageError ||
    error instanceof ImageTooLargeError ||
    error instanceof ImageWrongShapeError ||
    error instanceof MenuItemNotInStoreError
  ) {
    return { ok: false, message: error.message };
  }
  if (error instanceof NoStoreAccessError || error instanceof InsufficientStoreRoleError) {
    // One message either way, so this screen cannot be used to find out
    // whether another shop's id exists.
    return { ok: false, message: 'You do not have access to this store.' };
  }
  throw error;
}

/** The merchant's own screen, and the customer-facing page it feeds. */
function refresh(storeId: string, slug: string): void {
  revalidatePath(`/merchant/${storeId}/menu`);
  revalidatePath(`/stores/${slug}`);
}

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

function direction(formData: FormData): Direction {
  return field(formData, 'direction') === 'UP' ? 'UP' : 'DOWN';
}

export async function addMenuItemAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const priceCentavos = parsePrice(field(formData, 'price'), centavosFromPesoInput);
    const created = await addMenuItem({
      storeId: access.store.id,
      name: field(formData, 'name'),
      category: field(formData, 'category'),
      description: field(formData, 'description'),
      priceCentavos,
      compareAtPriceCentavos: parseComparePrice(
        field(formData, 'comparePrice'),
        priceCentavos,
        centavosFromPesoInput,
      ),
    });
    refresh(access.store.id, access.store.slug);
    return { ok: true, message: `${created.name} is on the menu.` };
  } catch (error) {
    return explain(error);
  }
}

export async function editMenuItemAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const priceCentavos = parsePrice(field(formData, 'price'), centavosFromPesoInput);
    const updated = await editMenuItem({
      storeId: access.store.id,
      itemId: field(formData, 'itemId'),
      name: field(formData, 'name'),
      category: field(formData, 'category'),
      description: field(formData, 'description'),
      priceCentavos,
      compareAtPriceCentavos: parseComparePrice(
        field(formData, 'comparePrice'),
        priceCentavos,
        centavosFromPesoInput,
      ),
    });
    refresh(access.store.id, access.store.slug);
    return { ok: true, message: `Saved ${updated.name}.` };
  } catch (error) {
    return explain(error);
  }
}

/**
 * Deletes a dish.
 *
 * The form carries the name the merchant was looking at and this checks it
 * against the row before deleting — so a stale screen, opened before somebody
 * else reordered the menu, cannot delete a different dish than the one whose
 * button was pressed.
 */
export async function removeMenuItemAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const expected = normaliseItemName(field(formData, 'name'));
    const removed = await removeMenuItem({
      storeId: access.store.id,
      itemId: field(formData, 'itemId'),
      expectedName: expected,
    });
    refresh(access.store.id, access.store.slug);
    return { ok: true, message: `${removed.name} is off the menu.` };
  } catch (error) {
    return explain(error);
  }
}

export async function moveMenuItemAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await moveMenuItem({
      storeId: access.store.id,
      itemId: field(formData, 'itemId'),
      direction: direction(formData),
    });
    refresh(access.store.id, access.store.slug);
    return outcome.moved
      ? { ok: true, message: 'Moved.' }
      : { ok: true, message: 'Already at the end of its section.' };
  } catch (error) {
    return explain(error);
  }
}

export async function moveCategoryAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await moveCategory({
      storeId: access.store.id,
      category: field(formData, 'category'),
      direction: direction(formData),
    });
    refresh(access.store.id, access.store.slug);
    return outcome.moved
      ? { ok: true, message: 'Moved.' }
      : { ok: true, message: 'Already at the end of the menu.' };
  } catch (error) {
    return explain(error);
  }
}

export async function renameCategoryAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await renameCategory({
      storeId: access.store.id,
      category: field(formData, 'category'),
      name: field(formData, 'name'),
    });
    refresh(access.store.id, access.store.slug);
    return {
      ok: true,
      message: `${outcome.items} item${outcome.items === 1 ? '' : 's'} now under ${outcome.category}.`,
    };
  } catch (error) {
    return explain(error);
  }
}

/**
 * Puts a photograph on a dish.
 *
 * The file arrives already resized: the browser draws it into a canvas at
 * 1200px and re-encodes it, so what reaches here is around 150 KB instead of
 * the four megabytes a phone camera produces. That is a convenience, not a
 * defence — `putMenuItemImage` reads the real type and size out of the bytes
 * and refuses anything outside the limits, because a form field is not a
 * promise about what was sent.
 *
 * No reason field and no audit row, unlike the console's actions: this is a
 * shop editing its own shopfront, and the same is true of every other control
 * on this screen.
 */
export async function uploadMenuItemImageAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const file = formData.get('photo');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: 'Pick a photo first.' };
    }
    // Checked before reading the whole thing into memory. The real limit is
    // enforced on the bytes; this is the cheap one.
    if (file.size > MAX_IMAGE_BYTES * 2) {
      return { ok: false, message: 'That photo is too big to send. Try taking it again.' };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await putMenuItemImage({
      storeId: access.store.id,
      menuItemId: field(formData, 'itemId'),
      bytes,
      uploadedByUserId: access.user.id,
    });

    refresh(access.store.id, access.store.slug);
    return {
      ok: true,
      message: `Photo saved — ${stored.width}×${stored.height}, ${Math.round(
        stored.byteSize / 1024,
      )} KB.`,
    };
  } catch (error) {
    return explain(error);
  }
}

/** Takes the photograph off a dish, leaving the dish. */
export async function removeMenuItemImageAction(
  _previous: MenuActionResult | null,
  formData: FormData,
): Promise<MenuActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await removeMenuItemImage({
      storeId: access.store.id,
      menuItemId: field(formData, 'itemId'),
    });
    refresh(access.store.id, access.store.slug);
    return outcome.removed
      ? { ok: true, message: 'Photo removed.' }
      : { ok: true, message: 'That dish had no photo.' };
  } catch (error) {
    return explain(error);
  }
}
