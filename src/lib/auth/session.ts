import { cache } from 'react';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Session resolution.
 *
 * PLACEHOLDER. Real authentication (OTP over SMS against `User.phone`) is
 * Phase 6. Until then this resolves a seeded demo customer so the screens have
 * a real person to render.
 *
 * IMPORTANT — this consults no request state, so it returns the SAME person to
 * every visitor. On a public URL that would make every visitor Juan Dela Cruz,
 * including on /orders, /credits and /profile, and the ownership check on the
 * tracking screen would pass for all of them. So it FAILS CLOSED: in
 * production the placeholder refuses to serve unless someone has explicitly
 * acknowledged it with ALLOW_INSECURE_DEMO_SESSION=1. A placeholder that
 * cannot silently ship is the only kind worth having.
 *
 * When this is replaced, keep two properties: it returns ONE `User`, and roles
 * are read from `user.roles`. Nothing downstream may assume a session belongs
 * to a customer.
 */

const DEMO_CUSTOMER_PHONE = '+639171234567';

export class InsecureSessionError extends Error {
  constructor() {
    super(
      'src/lib/auth/session.ts is an unauthenticated placeholder and refuses to run in ' +
        'production: it returns the same seeded user to every visitor. Implement real ' +
        'authentication (Phase 6), or set ALLOW_INSECURE_DEMO_SESSION=1 to override for a ' +
        'throwaway demo deployment.',
    );
    this.name = 'InsecureSessionError';
  }
}

/** Whether the placeholder is permitted to answer in this environment. */
export function isPlaceholderSessionAllowed(
  env: { NODE_ENV?: string; ALLOW_INSECURE_DEMO_SESSION?: string } = process.env,
): boolean {
  return env.NODE_ENV !== 'production' || env.ALLOW_INSECURE_DEMO_SESSION === '1';
}

export const getCurrentUser = cache(async (): Promise<User | null> => {
  if (!isPlaceholderSessionAllowed()) {
    throw new InsecureSessionError();
  }

  const phone = process.env.DEMO_SESSION_PHONE ?? DEMO_CUSTOMER_PHONE;
  try {
    return await prisma.user.findUnique({ where: { phone } });
  } catch {
    // No database yet (fresh clone, `npm run dev` before `npm run db:setup`).
    // The screens render their empty states rather than crashing.
    return null;
  }
});

/**
 * The signed-in user, or a thrown error. For server actions and anything that
 * writes — a mutation must never quietly act as nobody.
 */
export async function requireCurrentUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Not signed in');
  }
  return user;
}

/** The city whose services and stores we should show. */
export async function getCurrentCityId(): Promise<string> {
  const user = await getCurrentUser();
  return (
    user?.preferredCityId ??
    process.env.NEXT_PUBLIC_DEFAULT_CITY_ID ??
    'city_manila'
  );
}
