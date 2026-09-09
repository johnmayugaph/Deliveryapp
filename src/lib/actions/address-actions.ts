'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireScreen } from '@/lib/auth/access';
import {
  ADDRESS_ERROR_MESSAGES,
  readAddressEntry,
  shouldBeDefault,
} from '@/lib/addresses/entry';

/**
 * Saving an address from the address book.
 *
 * Its own module rather than `checkout-actions.ts`, because an address is not
 * part of a checkout: the same row is a parcel pickup and a ride origin later,
 * and the book is reachable from `/profile` with no cart in sight.
 *
 * The rules live in `lib/addresses/entry.ts` and are pure. What is left here is
 * the part that needs a session and a database: who is asking, which cities
 * exist, and whether this is their first address.
 */

export interface AddressActionResult {
  ok: boolean;
  /** A sentence for the person, on failure. */
  message: string | null;
}

export async function createAddressAction(
  _previous: AddressActionResult | null,
  formData: FormData,
): Promise<AddressActionResult> {
  /* `requireScreen` REDIRECTS when the session is gone rather than returning,
     and a server action is a place that can redirect — so a form submitted
     after an expiry lands the person on /login with `next` pointing back here,
     which is what the customer-screens audit established as the right shape
     for an expected refusal. */
  const { id: userId } = await requireScreen('addresses');

  /* Only ACTIVE cities. An inactive city is one this deployment does not
     deliver in, and saving an address there would produce a book entry that
     every checkout then refuses. */
  const cities = await prisma.city.findMany({
    where: { isActive: true },
    select: { id: true, province: true },
  });

  const read = readAddressEntry(
    {
      label: formData.get('label')?.toString(),
      line1: formData.get('line1')?.toString(),
      line2: formData.get('line2')?.toString(),
      barangay: formData.get('barangay')?.toString(),
      cityId: formData.get('cityId')?.toString(),
      landmark: formData.get('landmark')?.toString(),
      deliveryNotes: formData.get('deliveryNotes')?.toString(),
      contactName: formData.get('contactName')?.toString(),
      contactPhone: formData.get('contactPhone')?.toString(),
      latitude: formData.get('latitude')?.toString(),
      longitude: formData.get('longitude')?.toString(),
      isPickupCapable: formData.get('isPickupCapable') !== null,
    },
    cities,
  );
  if (!read.ok) {
    return { ok: false, message: ADDRESS_ERROR_MESSAGES[read.error] };
  }

  const asked = formData.get('isDefault') !== null;

  await prisma.$transaction(async (tx) => {
    const existingCount = await tx.address.count({
      where: { userId, archivedAt: null },
    });
    const isDefault = shouldBeDefault({ existingCount, asked });

    /* One default per person, cleared in the same transaction as the new row
       is written. Two defaults would make the checkout pre-selection depend
       on row order, which is the kind of bug that only shows up for the
       customer who has three addresses. */
    if (isDefault && existingCount > 0) {
      await tx.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    await tx.address.create({
      data: { userId, ...read.entry, isDefault },
    });
  });

  // The book, and the checkout that reads it.
  revalidatePath('/addresses');
  revalidatePath('/checkout');
  return { ok: true, message: null };
}
