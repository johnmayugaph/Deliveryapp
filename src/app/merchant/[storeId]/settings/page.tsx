import { StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { loadStorefront } from '@/lib/merchant/storefront';
import { PrepTimeForm } from '@/components/merchant/PrepTimeForm';
import {
  StorefrontPanel,
  StorefrontServices,
} from '@/components/merchant/StorefrontPanel';

export const dynamic = 'force-dynamic';

/** Store settings: whether customers can order, what the shop can change. */
export default async function MerchantSettingsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);

  const [memberCount, storefront] = await Promise.all([
    prisma.storeMember.count({ where: { storeId: access.store.id } }),
    loadStorefront(access.store),
  ]);

  return (
    <main className="space-y-4 px-4 py-4 pb-8">
      {/*
        First, above the prep time, because it is the answer to the question a
        shop with an empty queue is actually asking. Until this existed the
        merchant app had no reading of `isVisible` at all: a shop taken off the
        app from the console saw an emerald "Bukas" in its own header and
        nothing else, while every customer listing filtered it out and
        `quoteCheckout` refused outright.
      */}
      <StorefrontPanel
        state={storefront}
        storeId={access.store.id}
        slug={access.store.slug}
        addressLine={access.store.addressLine}
      />

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
        {/*
          The badge used to read `service.isActive ? 'Live' : 'Coming soon'` —
          the registry's GLOBAL flag, on a screen belonging to a shop that
          stands in one city. `isOrderableIn` exists precisely because those
          diverge from the first single-city launch onwards, so a Baguio shop
          was shown an emerald "Live" against a service running only in Cebu.
          It now reads the same rule the customer's tiles read.
        */}
        <StorefrontServices state={storefront} />
        <p className="mt-2 text-[11px] text-ink-faint">
          Contact support to add a service.
        </p>
      </section>

      {/* The list itself moved to its own tab once it became editable: adding
          somebody, changing a role and withdrawing an invitation are a
          screenful, and they do not belong beside a prep-time field.

          What each role GRANTS is not restated here either. A hand-written
          summary sat here saying "Staff: queue lang. Manager: menu at settings
          din." — wrong on both counts, silent about Payouts, and the second
          copy of a sentence already deleted from the staff screen. The
          explanation is derived from `BACK_OFFICE_AREAS` and lives where a
          role is actually chosen. */}
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
          What each role can see and do is on the Staff tab, beside the roles
          themselves.
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
