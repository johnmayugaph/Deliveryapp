'use server';

import { revalidatePath } from 'next/cache';
import { StoreRole } from '@prisma/client';
import {
  InsufficientStoreRoleError,
  NoStoreAccessError,
  requireStoreAccess,
} from '@/lib/merchant/access';
import {
  OptionGroupNotFoundError,
  OptionNotFoundError,
  TooManyGroupsError,
  TooManyOptionsError,
  addOption,
  addOptionGroup,
  editOption,
  editOptionGroup,
  moveOption,
  moveOptionGroup,
  removeOption,
  removeOptionGroup,
  setOptionAvailability,
} from '@/lib/merchant/options';
import {
  DuplicateOptionNameError,
  GroupNameRequiredError,
  ImpossibleGroupError,
  OptionDeltaNotUnderstoodError,
  OptionDeltaOutOfRangeError,
  OptionNameRequiredError,
  parseOptionDelta,
} from '@/lib/merchant/option-policy';
import { MenuItemNotFoundError, type Direction } from '@/lib/merchant/menu-policy';
import { centavosFromPesoInput } from '@/lib/money';

/**
 * A shop declaring the choices on a dish.
 *
 * MANAGER and above, like the rest of the menu: a choice carries a price, and
 * what the business sells is not a shift decision. The one exception is
 * marking an answer out of stock, which is exactly a shift decision — the
 * sauce runs out at eight — and that stays open to STAFF for the same reason
 * item availability does.
 *
 * Split out of `menu-actions.ts` because that file is already the menu's own
 * surface and this is a second screen with its own nouns; the pattern is
 * identical, deliberately, so there is nothing new to learn in it.
 */

export interface OptionActionResult {
  ok: boolean;
  message: string;
}

function explain(error: unknown): OptionActionResult {
  if (
    error instanceof GroupNameRequiredError ||
    error instanceof OptionNameRequiredError ||
    error instanceof OptionDeltaNotUnderstoodError ||
    error instanceof OptionDeltaOutOfRangeError ||
    error instanceof ImpossibleGroupError ||
    error instanceof DuplicateOptionNameError ||
    error instanceof OptionGroupNotFoundError ||
    error instanceof OptionNotFoundError ||
    error instanceof MenuItemNotFoundError ||
    error instanceof TooManyGroupsError ||
    error instanceof TooManyOptionsError
  ) {
    return { ok: false, message: error.message };
  }
  if (error instanceof NoStoreAccessError || error instanceof InsufficientStoreRoleError) {
    return { ok: false, message: 'You do not have access to this store.' };
  }
  throw error;
}

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

function number(formData: FormData, key: string, fallback: number): number {
  const parsed = Number(field(formData, key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function direction(formData: FormData): Direction {
  return field(formData, 'direction') === 'UP' ? 'UP' : 'DOWN';
}

/** The dish's own screen, the menu it sits on, and the customer's view. */
function refresh(storeId: string, slug: string, menuItemId: string): void {
  revalidatePath(`/merchant/${storeId}/menu/${menuItemId}/options`);
  revalidatePath(`/merchant/${storeId}/menu`);
  revalidatePath(`/stores/${slug}`);
}

export async function addOptionGroupAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const menuItemId = field(formData, 'itemId');
    const group = await addOptionGroup({
      storeId: access.store.id,
      menuItemId,
      name: field(formData, 'name'),
      minChoices: number(formData, 'minChoices', 0),
      maxChoices: number(formData, 'maxChoices', 1),
    });
    refresh(access.store.id, access.store.slug, menuItemId);
    return { ok: true, message: `“${group.name}” added. Now add its answers.` };
  } catch (error) {
    return explain(error);
  }
}

export async function editOptionGroupAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const group = await editOptionGroup({
      storeId: access.store.id,
      groupId: field(formData, 'groupId'),
      name: field(formData, 'name'),
      minChoices: number(formData, 'minChoices', 0),
      maxChoices: number(formData, 'maxChoices', 1),
    });
    refresh(access.store.id, access.store.slug, group.menuItemId);
    return { ok: true, message: `Saved “${group.name}”.` };
  } catch (error) {
    return explain(error);
  }
}

export async function removeOptionGroupAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const removed = await removeOptionGroup({
      storeId: access.store.id,
      groupId: field(formData, 'groupId'),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return { ok: true, message: `“${removed.name}” removed, with its answers.` };
  } catch (error) {
    return explain(error);
  }
}

export async function moveOptionGroupAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await moveOptionGroup({
      storeId: access.store.id,
      groupId: field(formData, 'groupId'),
      direction: direction(formData),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return outcome.moved
      ? { ok: true, message: 'Moved.' }
      : { ok: true, message: 'Already at the end.' };
  } catch (error) {
    return explain(error);
  }
}

export async function addOptionAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const option = await addOption({
      storeId: access.store.id,
      groupId: field(formData, 'groupId'),
      name: field(formData, 'name'),
      priceDeltaCentavos: parseOptionDelta(field(formData, 'delta'), centavosFromPesoInput),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return { ok: true, message: `“${option.name}” added.` };
  } catch (error) {
    return explain(error);
  }
}

export async function editOptionAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const option = await editOption({
      storeId: access.store.id,
      optionId: field(formData, 'optionId'),
      name: field(formData, 'name'),
      priceDeltaCentavos: parseOptionDelta(field(formData, 'delta'), centavosFromPesoInput),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return { ok: true, message: `Saved “${option.name}”.` };
  } catch (error) {
    return explain(error);
  }
}

export async function removeOptionAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const removed = await removeOption({
      storeId: access.store.id,
      optionId: field(formData, 'optionId'),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return { ok: true, message: `“${removed.name}” removed.` };
  } catch (error) {
    return explain(error);
  }
}

export async function moveOptionAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.MANAGER);
    const outcome = await moveOption({
      storeId: access.store.id,
      optionId: field(formData, 'optionId'),
      direction: direction(formData),
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return outcome.moved
      ? { ok: true, message: 'Moved.' }
      : { ok: true, message: 'Already at the end.' };
  } catch (error) {
    return explain(error);
  }
}

/**
 * Out of stock, or back — and STAFF may do this.
 *
 * The sauce running out at eight is the same kind of decision as the pork
 * running out at lunch, and whoever is on the counter has to be able to say
 * so. It changes what can be ordered tonight, not what the business sells.
 */
export async function setOptionAvailabilityAction(
  _previous: OptionActionResult | null,
  formData: FormData,
): Promise<OptionActionResult> {
  try {
    const access = await requireStoreAccess(field(formData, 'storeId'), StoreRole.STAFF);
    const option = await setOptionAvailability({
      storeId: access.store.id,
      optionId: field(formData, 'optionId'),
      isAvailable: field(formData, 'available') === 'true',
    });
    refresh(access.store.id, access.store.slug, field(formData, 'itemId'));
    return {
      ok: true,
      message: option.isAvailable ? `“${option.name}” is back.` : `“${option.name}” marked out.`,
    };
  } catch (error) {
    return explain(error);
  }
}
