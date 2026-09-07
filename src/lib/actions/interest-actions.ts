'use server';

import type { ServiceKey } from '@prisma/client';
import { getCurrentUser, getCurrentCityId } from '@/lib/auth/session';
import {
  recordServiceInterest,
  ServiceAlreadyLiveError,
  UnknownCityError,
  UnknownServiceError,
} from '@/lib/services/interest';

/**
 * "Tell us you want this."
 *
 * The action behind a coming-soon tile. It requires no account: the tiles are
 * the first thing anybody sees, and a waiting list that only counts people who
 * have already signed up measures the wrong population entirely.
 *
 * It deliberately does NOT revalidate the page. The tile's own state is the
 * whole change, the count comes back in this result, and re-rendering the home
 * screen to move one number would throw away the cart bar and the scroll
 * position of somebody who tapped a tile out of curiosity.
 */
export interface InterestActionResult {
  ok: boolean;
  message: string;
  /** Accounts that have asked. Absent on failure. */
  accounts?: number;
  /**
   * Whether the person who just asked can be told when it launches.
   *
   * False for a visitor with no account, and the tile has to know: there is no
   * way to reach them, so a tile that says "we will tell you" is lying, and a
   * count that says "you and 33 others" counts them among people they are not
   * one of.
   */
  canBeTold?: boolean;
}

export async function registerInterestAction(
  formData: FormData,
): Promise<InterestActionResult> {
  // Cast, then validated against the registry inside recordServiceInterest,
  // which throws for anything that is not a registered key. Nothing here
  // decides anything per service.
  const serviceKey = String(formData.get('serviceKey') ?? '') as ServiceKey;

  const [user, cityId] = await Promise.all([getCurrentUser(), getCurrentCityId()]);

  try {
    const outcome = await recordServiceInterest({
      serviceKey,
      cityId,
      userId: user?.id ?? null,
    });

    return {
      ok: true,
      accounts: outcome.tally.accounts,
      canBeTold: user !== null,
      message:
        user === null
          ? 'Noted. Sign in and we can tell you when it opens here.'
          : outcome.firstTime
            ? 'Noted — we will tell you when it opens here.'
            : 'Already noted. We will tell you when it opens here.',
    };
  } catch (error) {
    if (error instanceof ServiceAlreadyLiveError) {
      return { ok: false, message: 'That one is already open here.' };
    }
    if (error instanceof UnknownServiceError) {
      return { ok: false, message: 'That service does not exist.' };
    }
    if (error instanceof UnknownCityError) {
      // A misconfigured default city, not anything the person did. Say
      // something true and unalarming rather than nothing.
      console.error('registerInterestAction: unknown city', error.cityId);
      return { ok: false, message: 'We could not tell where you are just now.' };
    }
    throw error;
  }
}
