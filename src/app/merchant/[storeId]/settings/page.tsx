import { StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireStoreAccess, roleSatisfies, STORE_ROLE_LABELS } from '@/lib/merchant/access';
import { getAllServices } from '@/lib/services/registry';
import { PrepTimeForm } from '@/components/merchant/PrepTimeForm';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { displayNameFor } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Store settings, and who can work it. */
export default async function MerchantSettingsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);

  const [members, services] = await Promise.all([
    prisma.storeMember.findMany({
      where: { storeId: access.store.id },
      include: { user: true },
      orderBy: { role: 'asc' },
    }),
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

      <section
        aria-labelledby="members-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="members-heading" className="text-[13px] font-semibold">
          Who has access
        </h2>
        <ul className="mt-2 space-y-1.5">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0">
                <span className="block font-medium">
                  {displayNameFor(member.user)}
                  {member.userId === access.user.id ? (
                    <span className="ml-1.5 text-[10px] font-semibold text-brand-700">ikaw</span>
                  ) : null}
                </span>
                <span className="block text-[11px] text-ink-faint tabular-nums">
                  {formatPhilippineMobile(member.user.phone)}
                </span>
              </span>
              <span className="shrink-0 text-[11px] font-semibold text-ink-muted">
                {STORE_ROLE_LABELS[member.role]}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-ink-faint">
          Staff: queue lang. Manager: menu at settings din. May-ari: lahat.
        </p>
      </section>
    </main>
  );
}
