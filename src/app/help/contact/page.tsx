import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireScreen } from '@/lib/auth/access';
import { getLifecycle } from '@/lib/orders/transitions';
import { contactDetails } from '@/lib/support/contact';
import { listHelpCategories } from '@/lib/support/tickets';
import { ContactPanel } from '@/components/support/ContactPanel';
import { NewTicketForm } from '@/components/support/NewTicketForm';
import { formatDayIn } from '@/lib/time/manila';

export const dynamic = 'force-dynamic';

/**
 * A new message to support.
 *
 * Needs an account, so it redirects rather than rendering a dead form — and it
 * carries `next` so somebody who signs in lands back here rather than on the
 * home screen having forgotten what they were doing.
 *
 * The recent-orders list is built here rather than in the client component so
 * the "happening now" flag comes from the registry's own lifecycle definition:
 * each service declares its terminal statuses, and nothing on this screen knows
 * which services exist.
 */
export default async function ContactSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const user = await requireScreen('helpContact');

  const { order: initialOrderId } = await searchParams;

  const [orders, categories] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        serviceType: true,
        createdAt: true,
      },
    }),
    listHelpCategories(),
  ]);

  const orderChoices = orders.map((row) => ({
    id: row.id,
    label: `${row.orderNumber} — ${formatDayIn(row.createdAt)}`,
    live: !getLifecycle(row.serviceType).terminalStatuses.includes(row.status),
  }));

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/help" className="text-xs font-semibold text-brand-700">
          ← Help
        </Link>
        <h1 className="mt-1 text-xl font-bold">Send us a message</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          A person reads this. You will get a notification when we reply.
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <NewTicketForm
            orders={orderChoices}
            categories={categories.map((category) => ({
              slug: category.slug,
              title: category.title,
            }))}
            {...(initialOrderId === undefined ? {} : { initialOrderId })}
          />
        </div>

        {/* Still here, and deliberately. Somebody whose order is going wrong
            right now should not have to wait for a reply if there is a phone
            number they could ring instead. */}
        <ContactPanel contact={contactDetails()} />
      </div>
    </main>
  );
}
