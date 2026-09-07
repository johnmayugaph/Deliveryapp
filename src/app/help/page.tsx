import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth/session';
import { getAllServices } from '@/lib/services/registry';
import { serviceGlyph } from '@/lib/services/presentation';
import { contactDetails } from '@/lib/support/contact';
import { ticketsAwaitingCustomer } from '@/lib/support/tickets';
import { ContactPanel } from '@/components/support/ContactPanel';

export const dynamic = 'force-dynamic';

/**
 * One help section for every service — and two ways to reach a person.
 *
 * FAQ categories are driven by the Service registry: a category carrying a
 * `serviceType` is shown under that service's name, and general/account
 * categories (a null `serviceType`) sit on their own. A coming-soon service
 * with no articles simply does not appear — no placeholder sections.
 *
 * This route is PUBLIC, and the contact panel is why. Somebody with a question
 * should not have to sign up to read the answer, and somebody locked out of
 * their account has to be able to find a phone number here — a ticket needs a
 * session, so for them the form below does not exist. The ticket entry points
 * appear only when there is an account to attach a thread to, and say so
 * otherwise rather than bouncing anybody to a login screen.
 */
export default async function HelpPage() {
  const [user, services, categories] = await Promise.all([
    getCurrentUser(),
    getAllServices(),
    prisma.faqCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { articles: { orderBy: { sortOrder: 'asc' } } },
    }),
  ]);

  const contact = contactDetails();
  const awaiting = user ? await ticketsAwaitingCustomer(user.id) : 0;
  const serviceByKey = new Map(services.map((service) => [service.key, service]));

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <h1 className="text-xl font-bold">Help</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          One help section for every service.
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* First, not last. Somebody who opened this screen has a problem the
            FAQ did not solve — that is why they are here. */}
        <ContactPanel contact={contact} />

        {user ? (
          <section
            aria-labelledby="tickets-heading"
            className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
          >
            <h2 id="tickets-heading" className="text-sm font-semibold">
              Send us a message
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              We reply here, and you get a notification when we do.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/help/contact"
                className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white"
              >
                New message
              </Link>
              <Link
                href="/help/tickets"
                className="rounded-xl bg-surface-sunken px-4 py-2.5 text-sm font-semibold text-brand-700"
              >
                Your conversations
                {awaiting > 0 ? (
                  <span className="ml-1.5 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {awaiting}
                  </span>
                ) : null}
              </Link>
            </div>
          </section>
        ) : (
          <section className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
            <h2 className="text-sm font-semibold">Send us a message</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              <Link href="/login?next=/help/contact" className="font-semibold text-brand-700 underline">
                Sign in
              </Link>{' '}
              and we can keep the conversation with your account, so you get the
              reply as a notification. If you cannot sign in, use the details
              above instead.
            </p>
          </section>
        )}

        {categories.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">Wala pang help articles.</p>
        ) : (
          categories.map((category) => {
            const service = category.serviceType
              ? serviceByKey.get(category.serviceType)
              : undefined;

            return (
              <section
                key={category.id}
                aria-labelledby={`faq-${category.id}`}
                className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
              >
                <h2
                  id={`faq-${category.id}`}
                  className="flex items-center gap-2 text-sm font-semibold"
                >
                  {service ? (
                    <span aria-hidden className="text-base leading-none">
                      {serviceGlyph(service.icon)}
                    </span>
                  ) : null}
                  {category.title}
                  {service && !service.isActive ? (
                    <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-faint">
                      Coming soon
                    </span>
                  ) : null}
                </h2>

                <dl className="mt-3 space-y-3">
                  {category.articles.map((article) => (
                    <div key={article.id}>
                      <dt className="text-[13px] font-medium">{article.question}</dt>
                      <dd className="mt-1 text-xs leading-relaxed text-ink-muted">
                        {article.answer}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })
        )}
      </div>
    </main>
  );
}
