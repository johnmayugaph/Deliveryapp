import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { safeNextPath } from '@/lib/auth/login';
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

  return (
    <main className="px-4 py-10">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
          TARA
        </p>
        <h1 className="mt-1 text-2xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Just your number. No password.
        </p>
      </header>

      <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <LoginFlow redirectTo={safeNextPath(next)} />
      </div>
    </main>
  );
}
