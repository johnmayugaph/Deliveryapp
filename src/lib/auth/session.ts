import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { Session, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  generateSessionToken,
  hashClientIp,
  hashSessionToken,
} from '@/lib/auth/crypto';

export { pruneSessions } from '@/lib/auth/prune';

/**
 * Sessions.
 *
 * An opaque 256-bit token in an httpOnly cookie; the database stores only its
 * SHA-256 hash. Server-side rows rather than a self-contained JWT for one
 * reason that outweighs the convenience: a session must be revocable. A signed
 * token that asserts "valid for 30 days" cannot be taken back when a phone is
 * stolen.
 *
 * `getCurrentUser()` returns ONE `User` and nothing downstream may assume that
 * user is a customer — roles live in `user.roles`, which is an array.
 */

export const SESSION_COOKIE = 'tara_session';

/** How long a session lasts without use. */
const SESSION_TTL_DAYS = 30;
/**
 * Sliding window: a session in active use is extended, but only when it is
 * within this much of expiry, so a busy customer is not writing to the database
 * on every page view.
 */
const REFRESH_WHEN_REMAINING_DAYS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the client address from the proxy headers.
 *
 * Hashed before it is stored anywhere, and STRICTLY best-effort. Two ways it
 * can come back empty, both fine:
 *
 *  - behind a proxy that sets neither header;
 *  - on the progressive-enhancement path, where a form posts natively before
 *    hydration and `headers()` is not available. That path must still be able
 *    to log someone in — the client address is an input to a throttle, not a
 *    correctness requirement, so a login never fails over it. (This cost a
 *    500 on the no-JS login before the try/catch was here.)
 *
 * Either way the per-source throttle degrades to the per-phone one.
 */
export async function getClientIp(): Promise<string | undefined> {
  try {
    const headerList = await headers();
    const forwarded = headerList.get('x-forwarded-for');
    if (forwarded) {
      // Left-most entry is the original client; the rest are proxies.
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    return headerList.get('x-real-ip') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Truncated, because a full user-agent string is a fingerprint we do not need.
 * Absent rather than fatal when headers are unavailable, for the same reason as
 * above — a device label is not worth failing a sign-in for.
 */
async function getUserAgent(): Promise<string | undefined> {
  try {
    const headerList = await headers();
    return headerList.get('user-agent')?.slice(0, 180) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Raised when a session cannot be started because there is no request to attach
 * the cookie to.
 *
 * This is reachable: a login form submitted BEFORE the page hydrates is
 * delivered as a plain form post, and Next runs the action without a request
 * scope, so `cookies()` throws. Signing in is the one flow that cannot
 * degrade gracefully — its entire output is a cookie — so the honest response
 * is to say "the page is still loading, try again" rather than to appear to
 * succeed.
 */
export class SessionCookieUnavailableError extends Error {
  constructor() {
    super(
      'No request scope, so the session cookie cannot be set. A login form ' +
        'submitted before the page hydrated arrives this way.',
    );
    this.name = 'SessionCookieUnavailableError';
  }
}

/**
 * Starts a session and sets the cookie.
 *
 * Called only after a code has been verified. Returns nothing useful on
 * purpose: the token exists in the cookie and in no variable a caller might log.
 *
 * The cookie store is resolved FIRST, before the row is written. Doing it the
 * other way round left an unusable `Session` row behind on every pre-hydration
 * submission — a token nobody holds, sitting in the table until the pruner
 * reached it.
 */
export async function createSession(userId: string): Promise<void> {
  let cookieStore: Awaited<ReturnType<typeof cookies>>;
  try {
    cookieStore = await cookies();
  } catch {
    throw new SessionCookieUnavailableError();
  }

  const token = generateSessionToken();
  const clientIp = await getClientIp();

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS),
      userAgent: await getUserAgent(),
      ipHash: clientIp ? hashClientIp(clientIp) : null,
    },
  });

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true, // not readable by script, so XSS cannot lift it
    sameSite: 'lax', // survives a normal link click, blocks cross-site POSTs
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

/**
 * The session row for the current cookie, or null.
 *
 * Cached per request: the layout, the page and any server action in one render
 * all want the current user and none of them should each cost a query.
 */
const loadSession = cache(
  async (): Promise<(Session & { user: User }) | null> => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) {
      return null;
    }

    let session: (Session & { user: User }) | null;
    try {
      session = await prisma.session.findUnique({
        where: { tokenHash: hashSessionToken(token) },
        include: { user: true },
      });
    } catch (error) {
      // No database yet (a fresh clone before `npm run db:setup`). Treat it as
      // signed out rather than crashing every page.
      console.error('loadSession: lookup failed', error);
      return null;
    }

    if (!session) {
      return null;
    }
    if (session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    if (session.user.isBlocked) {
      return null;
    }

    return session;
  },
);

/**
 * The signed-in user, or null.
 *
 * Also nudges the sliding window: a session used inside its refresh threshold
 * gets extended. The write is fire-and-forget — a failed bookkeeping update
 * must not fail a page render.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await loadSession();
  if (!session) {
    return null;
  }

  const remainingMs = session.expiresAt.getTime() - Date.now();
  if (remainingMs < REFRESH_WHEN_REMAINING_DAYS * DAY_MS) {
    void prisma.session
      .update({
        where: { id: session.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS),
        },
      })
      .catch((error) => console.error('session refresh failed', error));
  }

  return session.user;
});

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotAuthenticatedError';
  }
}

export class OnboardingIncompleteError extends Error {
  constructor() {
    super('This account has not finished onboarding');
    this.name = 'OnboardingIncompleteError';
  }
}

/**
 * The signed-in user, or a thrown error.
 *
 * For server actions and anything that writes: a mutation must never quietly
 * act as nobody.
 */
export async function requireCurrentUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new NotAuthenticatedError();
  }
  return user;
}

/**
 * As above, and also insists the account has a name.
 *
 * Placing an order needs someone to hand the food to, so checkout requires a
 * completed account rather than accepting a nameless one.
 */
export async function requireOnboardedUser(): Promise<User> {
  const user = await requireCurrentUser();
  if (user.onboardedAt === null) {
    throw new OnboardingIncompleteError();
  }
  return user;
}

/** Ends the current session and clears the cookie. */
export async function signOutCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    // Revoke rather than delete, so "signed in on" history survives a sign-out
    // and a stolen token cannot be resurrected by re-inserting a row.
    await prisma.session
      .updateMany({
        where: { tokenHash: hashSessionToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch((error) => console.error('signOut: revoke failed', error));
  }

  cookieStore.delete(SESSION_COOKIE);
}

/** Revokes every other session for a user. For "sign out everywhere". */
export async function revokeOtherSessions(userId: string): Promise<number> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const keepHash = token ? hashSessionToken(token) : null;

  const { count } = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepHash ? { tokenHash: { not: keepHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return count;
}

export interface ActiveSessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  isCurrent: boolean;
}

/** Live sessions for the account, for a "signed in on" list. */
export async function listActiveSessions(userId: string): Promise<ActiveSessionSummary[]> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const currentHash = token ? hashSessionToken(token) : null;

  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    take: 20,
  });

  return sessions.map((session) => ({
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    userAgent: session.userAgent,
    isCurrent: currentHash !== null && session.tokenHash === currentHash,
  }));
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

/** Display name for a user who may not have given one yet. */
export function displayNameFor(user: Pick<User, 'displayName' | 'fullName' | 'phone'>): string {
  return user.displayName ?? user.fullName ?? user.phone;
}
