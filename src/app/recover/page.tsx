import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { isEmailConfigured } from '@/lib/auth/email';
import { RECOVERY_CREDIT_FREEZE_DAYS } from '@/lib/auth/recovery';
import { Wordmark } from '@/components/brand/Wordmark';
import { RecoveryFlow } from '@/components/auth/RecoveryFlow';

export const dynamic = 'force-dynamic';

/**
 * Recovering an account whose phone number is gone.
 *
 * Reachable without signing in — the whole premise is that the person cannot.
 * Somebody already signed in is sent to their profile instead, where changing
 * a number is a settings change rather than a recovery.
 *
 * The page is honest about the three-day credit hold before anybody starts,
 * because a person who finds out about it afterwards reads it as a punishment
 * and a person who is told first reads it as what it is: the thing that makes
 * this safe to offer at all.
 */
export default async function RecoverPage() {
  const user = await getCurrentUser();
  if (user) redirect('/profile');

  const available = isEmailConfigured();

  return (
    <main className="px-4 py-10">
      <header>
        <Wordmark size="lg" />
        <h1 className="mt-4 text-2xl font-bold tracking-[-0.02em]">
          Lost your number?
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          If you confirmed an email address while you still had your old number,
          you can move the account yourself.
        </p>
      </header>

      {available ? (
        <>
          <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
            <RecoveryFlow />
          </div>

          <section
            aria-labelledby="safeguards"
            className="mt-5 rounded-xl bg-surface-sunken p-4"
          >
            <h2 id="safeguards" className="text-[13px] font-semibold">
              What happens when you do this
            </h2>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-muted">
              <li>
                We text your <span className="font-semibold">old</span> number to say
                the account moved. If somebody else is doing this to you, that is
                how you find out.
              </li>
              <li>
                Your credits are held for {RECOVERY_CREDIT_FREEZE_DAYS} days.
                Nothing can be spent from the balance until then — which is what
                makes taking over an account pointless.
              </li>
              <li>
                Everyone signed in to the account is signed out, on every device.
              </li>
              <li>Your orders, addresses and credits balance are untouched.</li>
            </ul>
          </section>
        </>
      ) : (
        <div className="mt-6 rounded-xl bg-surface p-4 text-sm leading-relaxed shadow-sm ring-1 ring-black/5">
          <p className="font-semibold">Recovery by email is not set up yet.</p>
          <p className="mt-1.5 text-ink-muted">
            This deployment has no email provider configured, so we cannot send you
            a code. Support can still move your account by hand — you will be asked
            for something that proves it is yours, like a recent order number.
          </p>
        </div>
      )}

      <p className="mt-6 text-xs text-ink-muted">
        Still have your number?{' '}
        <Link href="/login" className="font-semibold text-brand-700">
          Sign in
        </Link>
        .
      </p>
    </main>
  );
}
