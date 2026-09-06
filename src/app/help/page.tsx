import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { serviceGlyph } from '@/lib/services/presentation';

export const dynamic = 'force-dynamic';

/**
 * One help section for every service.
 *
 * FAQ categories are driven by the Service registry: a category carrying a
 * `serviceType` is shown under that service's name, and general/account
 * categories (a null `serviceType`) sit on their own. A coming-soon service
 * with no articles simply does not appear — no placeholder sections.
 *
 * The ticket model behind "Contact support" is a single `SupportTicket` covering
 * every vertical, with a `serviceType` and an optional `relatedOrderId`.
 */
export default async function HelpPage() {
  const [services, categories] = await Promise.all([
    getAllServices(),
    prisma.faqCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { articles: { orderBy: { sortOrder: 'asc' } } },
    }),
  ]);

  const serviceByKey = new Map(services.map((service) => [service.key, service]));

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <h1 className="text-xl font-bold">Help</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Isang help section para sa lahat ng service.
        </p>
      </header>

      {categories.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">Wala pang help articles.</p>
      ) : (
        <div className="space-y-4 px-4 py-4">
          {categories.map((category) => {
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
          })}
        </div>
      )}
    </main>
  );
}
