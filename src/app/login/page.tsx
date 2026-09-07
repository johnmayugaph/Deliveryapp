import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { safeNextPath } from '@/lib/auth/login';
import { isCaptchaConfigured } from '@/lib/auth/captcha';
import { Wordmark } from '@/components/brand/Wordmark';
import { LoginFlow } from '@/components/auth/LoginFlow';

export const dynamic = 'force-dynamic';

/**
 * Sign in.
 *
 * `next` carries where the person was heading before they were bounced here, so
 * a deep link survives a login. `safeNextPath` validates it as a same-site
 * path — an open redirect on a login page turns it into a phishing tool.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [{ next }, user] = await Promise.all([searchParams, getCurrentUser()]);

  if (user) {
    redirect(user.onboardedAt === null ? '/welcome' : safeNextPath(next));
  }

  const captchaSiteKey = isCaptchaConfigured()
    ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
    : undefined;

  return (
    <main className="px-4 py-10">
      <header>
        <Wordmark size="lg" />
        <h1 className="mt-4 text-2xl font-bold tracking-[-0.02em]">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Just your number. No password.
        </p>
      </header>

      <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <LoginFlow
          redirectTo={safeNextPath(next)}
          /* Read here, at request time, rather than inlined into the client
             bundle — so rotating the key pair is a restart rather than a
             rebuild. Passed only when BOTH halves are set: a site key with no
             secret would render a widget whose token nothing checks. */
          {...(captchaSiteKey === undefined ? {} : { captchaSiteKey })}
        />
      </div>

      {/* The one route out for somebody whose number is gone. Quiet, because
          almost nobody needs it and the people who do are looking for it. */}
      <p className="mt-5 text-xs text-ink-muted">
        Lost your number?{' '}
        <Link href="/recover" className="font-semibold text-brand-700">
          Recover your account
        </Link>
        .
      </p>
    </main>
  );
}
