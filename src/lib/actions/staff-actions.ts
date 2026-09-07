'use server';

import { revalidatePath } from 'next/cache';
import { StoreRole } from '@prisma/client';
import {
  InsufficientStoreRoleError,
  NoStoreAccessError,
  requireStoreAccess
} from '@/lib/merchant/access';
import {
  changeStoreRole,
  inviteToStore,
  removeFromStore,
  revokeInvite,
} from '@/lib/merchant/staff';
import {
  AlreadyAMemberError,
  CannotChangeRoleError,
  CannotGrantRoleError,
  CannotRemoveError,
  InviteNotFoundError,
  LastOwnerError,
} from '@/lib/merchant/staff-policy';
import { InvalidPhoneNumberError, formatPhilippineMobile } from '@/lib/auth/phone';
import { STORE_ROLE_LABELS } from '@/lib/merchant/staff-policy';

/**
 * A shop deciding who works there.
 *
 * Every action here takes the store id from the form and then throws it away
 * as an authorisation input: `requireStoreAccess` resolves the caller's role
 * from the session and THAT membership, so a form field cannot buy access to a
 * store somebody is not in. Minimum STAFF, deliberately — the real decision
 * about who may grant what belongs to `staff-policy.ts`, and duplicating a
 * role check here would mean two places to keep in agreement.
 */

export interface StaffActionResult {
  ok: boolean;
  message: string;
}

/**
 * Turns the policy's exceptions into sentences.
 *
 * Anything not listed is a real fault and is rethrown rather than reported as
 * a friendly failure: a bug that says "please try again" is a bug nobody
 * fixes.
 */
function explain(error: unknown): StaffActionResult {
  if (
    error instanceof CannotGrantRoleError ||
    error instanceof CannotChangeRoleError ||
    error instanceof CannotRemoveError ||
    error instanceof LastOwnerError ||
    error instanceof AlreadyAMemberError ||
    error instanceof InviteNotFoundError ||
    error instanceof InvalidPhoneNumberError
  ) {
    return { ok: false, message: error.message };
  }
  if (error instanceof NoStoreAccessError || error instanceof InsufficientStoreRoleError) {
    return { ok: false, message: 'You do not have access to this store.' };
  }
  throw error;
}

function refresh(storeId: string): void {
  revalidatePath(`/merchant/${storeId}/staff`);
  revalidatePath(`/merchant/${storeId}/settings`);
}

export async function inviteStaffAction(
  _previous: StaffActionResult | null,
  formData: FormData,
): Promise<StaffActionResult> {
  const storeId = String(formData.get('storeId') ?? '').trim();
  const rawPhone = String(formData.get('phone') ?? '');
  const role = String(formData.get('role') ?? '') as StoreRole;
  if (!(role in STORE_ROLE_LABELS)) {
    return { ok: false, message: 'Pick a role.' };
  }

  try {
    const access = await requireStoreAccess(storeId);
    const outcome = await inviteToStore({
      storeId: access.store.id,
      actorId: access.user.id,
      actorRole: access.role,
      rawPhone,
      role,
    });

    refresh(access.store.id);

    const who = formatPhilippineMobile(outcome.phone);
    return outcome.kind === 'ADDED'
      ? {
          ok: true,
          message: `${who} can work this store now, as ${STORE_ROLE_LABELS[role].toLowerCase()}.`,
        }
      : {
          ok: true,
          message:
            `${who} has no TARA account yet, so the invitation is waiting. ` +
            'They get access the first time they sign in with that number — ' +
            'tell them to install the app and sign in.',
        };
  } catch (error) {
    return explain(error);
  }
}

export async function changeStaffRoleAction(
  _previous: StaffActionResult | null,
  formData: FormData,
): Promise<StaffActionResult> {
  const storeId = String(formData.get('storeId') ?? '').trim();
  const memberId = String(formData.get('memberId') ?? '').trim();
  const role = String(formData.get('role') ?? '') as StoreRole;
  if (!(role in STORE_ROLE_LABELS)) {
    return { ok: false, message: 'Pick a role.' };
  }

  try {
    const access = await requireStoreAccess(storeId);
    await changeStoreRole({
      storeId: access.store.id,
      actorId: access.user.id,
      actorRole: access.role,
      memberId,
      role,
    });
    refresh(access.store.id);
    return { ok: true, message: `Now ${STORE_ROLE_LABELS[role].toLowerCase()}.` };
  } catch (error) {
    return explain(error);
  }
}

export async function removeStaffAction(
  _previous: StaffActionResult | null,
  formData: FormData,
): Promise<StaffActionResult> {
  const storeId = String(formData.get('storeId') ?? '').trim();
  const memberId = String(formData.get('memberId') ?? '').trim();

  try {
    const access = await requireStoreAccess(storeId);
    const outcome = await removeFromStore({
      storeId: access.store.id,
      actorId: access.user.id,
      actorRole: access.role,
      memberId,
    });
    refresh(access.store.id);
    return {
      ok: true,
      message: outcome.wasSelf
        ? 'You have left this store.'
        : 'Removed. They have been told.',
    };
  } catch (error) {
    return explain(error);
  }
}

export async function revokeStaffInviteAction(
  _previous: StaffActionResult | null,
  formData: FormData,
): Promise<StaffActionResult> {
  const storeId = String(formData.get('storeId') ?? '').trim();
  const inviteId = String(formData.get('inviteId') ?? '').trim();

  try {
    const access = await requireStoreAccess(storeId, StoreRole.MANAGER);
    await revokeInvite({ storeId: access.store.id, inviteId });
    refresh(access.store.id);
    return { ok: true, message: 'Invitation withdrawn.' };
  } catch (error) {
    return explain(error);
  }
}
