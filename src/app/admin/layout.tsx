import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdminUser } from '@/lib/admin/access';
import { displayNameFor } from '@/lib/auth/session';
import { supportSummary } from '@/lib/support/queries';
import { countPendingApplications } from '@/lib/admin/fleet';
import { errorSummary } from '@/lib/monitoring/queries';
import { Wordmark } from '@/components/brand/Wordmark';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

/**
 * The console shell: a fixed sidebar, a top bar, and a scrolling page.
 *
 * Three decisions worth naming.
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
 *
 * **The badges are loaded HERE, once, for every screen.** They are the three
 * numbers that mean somebody is waiting on a person: a customer in support, a
 * rider unapproved and unable to earn, a fault nobody has closed. Loading them
 * in the shell is what makes them visible from the screen you are already on,
 * which is the only place a queue ever gets noticed.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const [support, fleet, errors] = await Promise.all([
    supportSummary(),
    countPendingApplications(),
    errorSummary(),
  ]);

  return (
    <div className="fixed inset-0 z-50 flex bg-surface-sunken">
      {/* The sidebar is its own scroll region: the nav is long enough to
          scroll on a laptop, and scrolling a table should not move it. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink/[0.08] bg-surface lg:flex">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-ink/[0.08] px-4">
          <Link href="/admin" className="flex items-baseline gap-2">
            <Wordmark size="sm" />
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-faint">
              Console
            </span>
          </Link>
        </div>
        <AdminSidebar
          badges={{ support: support.waiting, fleet, errors: errors.open }}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink/[0.08] bg-surface px-4">
          {/* The wordmark only below `lg`, where the sidebar is not rendered
              and this is the only thing saying which product you are in. */}
          <Link href="/admin" className="flex items-baseline gap-2 lg:hidden">
            <Wordmark size="sm" />
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-faint">
              Console
            </span>
          </Link>

          {/* Search goes to the orders list, because that is what somebody
              typing an order number or a name into a console is looking for,
              and it is the one list here that takes a search term. A box that
              pretended to search everything would be a box that quietly
              searched one thing. */}
          <form action="/admin/orders" method="get" role="search" className="ml-auto w-full max-w-sm">
            <label htmlFor="admin-search" className="sr-only">
              Search orders
            </label>
            <input
              id="admin-search"
              name="q"
              type="search"
              autoComplete="off"
              placeholder="Search orders by number or name"
              className="w-full rounded-xl bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-ink/[0.08] placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </form>

          <div className="flex shrink-0 items-center gap-3 text-[11px] text-ink-muted">
            {/* Named, because everything done here is attributed to this
                account and a person should be able to see which one. */}
            <span className="hidden sm:inline">
              <span className="font-bold text-ink">{displayNameFor(admin)}</span>
            </span>
            <Link href="/" className="font-bold text-brand-700">
              Leave
            </Link>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* Below `lg` the sidebar is gone, so the nav has to be somewhere.
              A horizontal strip of the same links, scrolling — a console on a
              phone is a thing somebody does standing up, checking one number. */}
          <div className="sticky top-0 z-10 border-b border-ink/[0.08] bg-surface/95 backdrop-blur lg:hidden">
            <AdminSidebar
              compact
              badges={{ support: support.waiting, fleet, errors: errors.open }}
            />
          </div>

          <div className="mx-auto max-w-7xl px-4 py-5 lg:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
