import { StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { getAllServices } from '@/lib/services/registry';
import { PrepTimeForm } from '@/components/merchant/PrepTimeForm';

export const dynamic = 'force-dynamic';

/** Store settings, and who can work it. */
export default async function MerchantSettingsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);

  const [memberCount, services] = await Promise.all([
    prisma.storeMember.count({ where: { storeId: access.store.id } }),
    getAllServices(),
  ]);

  // Which verticals this store is orderable in — read from the registry, so a
  // store flagged for MART shows it the day MART activates.
  const storeServices = services.filter((service) =>
    access.store.serviceKeys.includes(service.key),
  );

  return (
    <main className="space-y-4 px-4 py-4 pb-8">
      <section
        aria-labelledby="prep-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="prep-heading" className="text-[13px] font-semibold">
          Prep time
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          This drives the ETA the customer sees, and is snapshotted onto every
          new order.
        </p>
        <div className="mt-3">
          <PrepTimeForm
            storeId={access.store.id}
            minutes={access.store.preparationMinutes}
            canEdit={roleSatisfies(access.role, StoreRole.MANAGER)}
          />
        </div>
      </section>

      <section
        aria-labelledby="services-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="services-heading" className="text-[13px] font-semibold">
          Services
        </h2>
        <ul className="mt-2 space-y-1.5">
          {storeServices.map((service) => (
            <li key={service.key} className="flex items-center justify-between text-xs">
              <span className="font-medium">{service.displayName}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  service.isActive
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-surface-sunken text-ink-faint'
                }`}
              >
                {service.isActive ? 'Live' : 'Coming soon'}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-ink-faint">
          Contact support to add a service.
        </p>
      </section>

      {/* The list itself moved to its own tab once it became editable: adding
          somebody, changing a role and withdrawing an invitation are a
          screenful, and they do not belong beside a prep-time field. */}
      <section
        aria-labelledby="members-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="members-heading" className="text-[13px] font-semibold">
          Who has access
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          {memberCount === 1
            ? 'Just you, for now.'
            : `${memberCount} people can work this store.`}{' '}
          Staff: queue lang. Manager: menu at settings din. May-ari: lahat.
        </p>
        <Link
          href={`/merchant/${access.store.id}/staff`}
          className="mt-3 inline-block rounded-lg bg-surface-sunken px-3 py-2 text-[13px] font-semibold text-brand-700"
        >
          Manage staff
        </Link>
      </section>
    </main>
  );
}
