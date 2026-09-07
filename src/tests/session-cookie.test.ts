import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A login is a cookie. Everything else about signing in — the number, the code,
 * the rate limits — is preparation for one `Set-Cookie`, so the moment that
 * cannot happen, nothing else should either.
 *
 * The case is real rather than theoretical: a form submitted before the page
 * hydrates arrives as a plain form post, which Next runs with no request scope,
 * and `cookies()` throws. The old order of operations wrote the `Session` row
 * first and threw afterwards, leaving a token nobody held in the table on every
 * such attempt.
 */

const cookieStore = { set: vi.fn() };
let cookiesAvailable = true;

vi.mock('next/headers', () => ({
  cookies: async () => {
    if (!cookiesAvailable) {
      throw new Error('`cookies` was called outside a request scope.');
    }
    return cookieStore;
  },
  headers: async () => new Map(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { create: vi.fn(async () => ({ id: 'session_1' })) },
  },
}));

const { createSession, SessionCookieUnavailableError, SESSION_COOKIE } = await import(
  '@/lib/auth/session'
);
const { prisma } = await import('@/lib/prisma');

beforeEach(() => {
  cookiesAvailable = true;
  cookieStore.set.mockClear();
  vi.mocked(prisma.session.create).mockClear();
});

describe('createSession', () => {
  it('writes a session row and sets the cookie', async () => {
    await createSession('user_1');

    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(cookieStore.set).toHaveBeenCalledTimes(1);

    const [name, token, options] = cookieStore.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe(SESSION_COOKIE);
    // 256 bits of CSPRNG output, base64url-encoded: 43 characters, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('stores the hash of the token, never the token', async () => {
    await createSession('user_1');

    const [, token] = cookieStore.set.mock.calls[0] as [string, string];
    const written = vi.mocked(prisma.session.create).mock.calls[0]?.[0] as {
      data: { tokenHash: string };
    };
    expect(written.data.tokenHash).not.toBe(token);
    expect(written.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when there is no request to attach a cookie to', async () => {
    cookiesAvailable = false;

    await expect(createSession('user_1')).rejects.toBeInstanceOf(
      SessionCookieUnavailableError,
    );
  });

  it('writes no session row when the cookie cannot be set', async () => {
    cookiesAvailable = false;

    await expect(createSession('user_1')).rejects.toThrow();
    // The row must not exist: a session nobody can present is a token sitting
    // in the table until the pruner reaches it.
    expect(prisma.session.create).not.toHaveBeenCalled();
  });
});
