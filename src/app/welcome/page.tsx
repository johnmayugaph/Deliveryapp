import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { WelcomeForm } from '@/components/auth/WelcomeForm';

export const dynamic = 'force-dynamic';

/**
 * Onboarding, for an account that exists but has no name yet.
 *
 * A phone-first signup creates the `User` at the moment the code is verified,
 * which is before the person has typed anything else — so `fullName` is null
 * and this screen is the only route out.
 */
export default async function WelcomePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login?next=%2Fwelcome');
  }
  if (user.onboardedAt !== null) {
    redirect('/');
  }

  return (
    <main className="px-4 py-10">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
          Bagong account
        </p>
        <h1 className="mt-1 text-2xl font-bold">Kumusta!</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Verified na ang {formatPhilippineMobile(user.phone)}. Ano ang pangalan mo?
        </p>
      </header>

      <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <WelcomeForm />
      </div>
    </main>
  );
}
