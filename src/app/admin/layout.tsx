import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdminUser } from '@/lib/admin/access';
import { displayNameFor } from '@/lib/auth/session';
import { Wordmark } from '@/components/brand/Wordmark';

/**
 * The console shell.
 *
 * Two decisions worth naming.
 *
 * **A non-admin gets `notFound()`, not a "forbidden" page.** A 403 tells
 * somebody probing the app that `/admin` exists and that they merely lack the
 * role; a 404 tells them nothing. This is not the security boundary — that is
 * `requireAdmin()` in every action and every page — but there is no reason to
 * advertise the door.
 *
 * **It escapes the phone frame with a fixed overlay.** The root layout wraps
 * everything in `max-w-lg`, which is right for the four apps people use on a
 * phone and wrong for a console whose whole job is showing wide tables. A
 * nested layout cannot widen a parent, and a second root layout would mean
 * moving every other route into a route group. A fixed, scrolling container is
 * two lines and covers the customer navigation as well.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-surface-sunken">
      <header className="sticky top-0 z-10 border-b border-black/10 bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
          <Link href="/admin" className="flex items-baseline gap-2">
            <Wordmark size="sm" />
            <span className="text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
              Console
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium">
            <Link href="/admin" className="hover:text-brand-700">
              Overview
            </Link>
            <Link href="/admin/orders" className="hover:text-brand-700">
              Orders
            </Link>
            <Link href="/admin/users" className="hover:text-brand-700">
              People
            </Link>
            <Link href="/admin/services" className="hover:text-brand-700">
              Services
            </Link>
            <Link href="/admin/support" className="hover:text-brand-700">
              Support
            </Link>
            <Link href="/admin/health" className="hover:text-brand-700">
              Delivery health
            </Link>
            <Link href="/admin/errors" className="hover:text-brand-700">
              Errors
            </Link>
            <Link href="/admin/audit" className="hover:text-brand-700">
              Audit log
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
            {/* Named, because everything done here is attributed to this
                account and a person should be able to see which one. */}
            <span>
              Signed in as <span className="font-semibold">{displayNameFor(admin)}</span>
            </span>
            <Link href="/" className="font-semibold text-brand-700">
              Leave the console
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-6">{children}</div>
    </div>
  );
}
