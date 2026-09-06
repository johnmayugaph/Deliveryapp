import { cache } from 'react';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Session resolution.
 *
 * PLACEHOLDER. Real authentication (OTP over SMS, per the `phone` login
 * identity on `User`) is a later phase. Until then this resolves the seeded
 * demo customer so the screens have a real person to render, and every caller
 * already treats "no session" as a valid state.
 *
 * The only thing to keep when this is replaced: it returns ONE `User`, and
 * roles are read from `user.roles`. Nothing downstream should assume a session
 * belongs to a customer.
 */

const DEMO_CUSTOMER_PHONE = '+639171234567';

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const phone = process.env.DEMO_SESSION_PHONE ?? DEMO_CUSTOMER_PHONE;
  try {
    return await prisma.user.findUnique({ where: { phone } });
  } catch {
    // No database yet (fresh clone, `npm run dev` before `npm run db:setup`).
    // The screens render their empty states rather than crashing.
    return null;
  }
});

/** The city whose services and stores we should show. */
export async function getCurrentCityId(): Promise<string> {
  const user = await getCurrentUser();
  return (
    user?.preferredCityId ??
    process.env.NEXT_PUBLIC_DEFAULT_CITY_ID ??
    'city_manila'
  );
}
