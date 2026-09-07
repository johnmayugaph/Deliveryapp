'use server';

import { AdminAccessRequiredError, requireAdmin } from '@/lib/admin/access';
import {
  GEOCODE_FAILURE_MESSAGE,
  searchAddress,
  type GeocodeCandidate,
} from '@/lib/geo/geocode';
import { isInPhilippines, type Coordinate } from '@/lib/geo/philippines';

/**
 * Looking up an address for the store form's map.
 *
 * Its own module rather than `admin-actions.ts`, for the same reason the
 * support controls are: everything in that file demands a reason and writes an
 * audit row, and a test asserts it of each one, because everything in there
 * moves money, roles or access. This is a READ of somebody else's public
 * search index. An audit row saying "an administrator typed a street name"
 * would be noise in the log that matters.
 *
 * `requireAdmin()` all the same. Without it this would be an open geocoding
 * proxy for anybody who found the action id, which is both an abuse of a free
 * service and a good way to get the deployment's address blocked.
 */

export interface AddressSearchResult {
  ok: boolean;
  /** Empty on failure. */
  candidates: GeocodeCandidate[];
  /** A sentence, on failure or when nothing matched. */
  message: string | null;
}

const DENIED: AddressSearchResult = {
  ok: false,
  candidates: [],
  message: 'That is only available to an administrator.',
};

export async function searchAddressAction(
  _previous: AddressSearchResult | null,
  formData: FormData,
): Promise<AddressSearchResult> {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  // Optional, and validated rather than trusted: it arrives from the form as
  // whatever the city select last put there, and a nonsense pair would make
  // the viewbox nonsense too.
  const latitude = Number(formData.get('nearLat'));
  const longitude = Number(formData.get('nearLng'));
  const near: Coordinate | undefined = isInPhilippines({ latitude, longitude })
    ? { latitude, longitude }
    : undefined;

  const outcome = await searchAddress({
    query: formData.get('query'),
    ...(near === undefined ? {} : { near }),
  });

  if (!outcome.ok) {
    return {
      ok: false,
      candidates: [],
      message: GEOCODE_FAILURE_MESSAGE[outcome.reason],
    };
  }

  return { ok: true, candidates: outcome.candidates, message: null };
}
