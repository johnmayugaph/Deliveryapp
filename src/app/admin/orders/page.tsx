import Link from 'next/link';
import { OrderStatus, type ServiceKey } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import { requireAdmin } from '@/lib/admin/access';
import { attachStores, listOrders } from '@/lib/admin/queries';
import { getAllServices } from '@/lib/services/registry';
import {
  Empty,
  Panel,
  PersonLink,
  StatusPill,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Orders, every vertical in one list.
 *
 * The filters are built from the registry and the status enum, so a sixth
 * service or a new status appears here without anybody editing this file —
 * which is the same rule the customer app follows, applied to the tool the
 * operators use.
 *
 * Filtering is done with links and a GET form rather than client state, so a
 * filtered view is a URL somebody can paste into a support thread.
 */
export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; status?: string; live?: string; q?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const services = await getAllServices();
  // Values from a query string are input. Anything not in the registry or the
  // enum is dropped rather than passed to Prisma.
  const serviceType = services.some((service) => service.key === params.service)
    ? (params.service as ServiceKey)
    : undefined;
  const status = Object.values(OrderStatus).includes(params.status as OrderStatus)
    ? (params.status as OrderStatus)
    : undefined;
  const liveOnly = params.live === '1';
  const search = params.q?.trim() || undefined;

  const orders = await listOrders({
    ...(serviceType ? { serviceType } : {}),
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    liveOnly,
    limit: 100,
  }).then(attachStores);

  const query = (next: Record<string, string | undefined>) => {
    const merged = new URLSearchParams();
    const base = {
      service: serviceType,
      status,
      live: liveOnly ? '1' : undefined,
      q: search,
      ...next,
    };
    for (const [key, value] of Object.entries(base)) {
      if (value) merged.set(key, value);
    }
    const qs = merged.toString();
    return qs ? `/admin/orders?${qs}` : '/admin/orders';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Orders</h1>
          <p className="mt-0.5 text-xs text-ink-muted">
            {orders.length === 100
              ? 'Showing the newest 100. Narrow the filters or search to see further back.'
              : `${orders.length} order${orders.length === 1 ? '' : 's'}.`}
          </p>
        </div>

        {/* A plain GET form: the result is a shareable URL, and it works with
            no JavaScript at all. */}
        <form className="flex items-center gap-2">
          {serviceType ? <input type="hidden" name="service" value={serviceType} /> : null}
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {liveOnly ? <input type="hidden" name="live" value="1" /> : null}
          <input
            name="q"
            defaultValue={search ?? ''}
            placeholder="Order number or phone"
            aria-label="Search orders"
            className="w-56 rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-xs"
          />
          <button
            type="submit"
            className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Search
          </button>
        </form>
      </div>

      <div className="space-y-2 rounded-xl bg-surface p-3 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Service
          </span>
          <FilterChip href={query({ service: undefined })} active={!serviceType}>
            All
          </FilterChip>
          {services.map((service) => (
            <FilterChip
              key={service.key}
              href={query({ service: service.key })}
              active={serviceType === service.key}
            >
              {service.displayName}
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Status
          </span>
          <FilterChip href={query({ status: undefined, live: undefined })} active={!status && !liveOnly}>
            Any
          </FilterChip>
          <FilterChip href={query({ status: undefined, live: '1' })} active={liveOnly && !status}>
            In flight
          </FilterChip>
          {Object.values(OrderStatus).map((value) => (
            <FilterChip
              key={value}
              href={query({ status: value, live: undefined })}
              active={status === value}
            >
              {humaniseEnum(value)}
            </FilterChip>
          ))}
        </div>
      </div>

      <Panel title="Results">
        {orders.length === 0 ? (
          <Empty>
            Nothing matches. {search ? 'Try a partial phone number — the match is a substring.' : null}
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Customer</Th>
                <Th>Store</Th>
                <Th>Partner</Th>
                <Th numeric>Total</Th>
                <Th numeric>Credits used</Th>
                <Th>Placed</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <Link
                      href={`/admin/orders/${order.orderNumber}`}
                      className="font-mono text-[11px] font-semibold text-brand-700 hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                  </Td>
                  <Td>{order.serviceType}</Td>
                  <Td>
                    <StatusPill status={order.status} />
                  </Td>
                  <Td>
                    <PersonLink user={order.customer} />
                    <span className="mt-0.5 block font-mono text-[10px] text-ink-faint">
                      {order.customer.phone}
                    </span>
                  </Td>
                  <Td muted={!order.storeName}>{order.storeName ?? '—'}</Td>
                  <Td muted={!order.assignedRider}>
                    {order.assignedRider?.user.fullName ?? '—'}
                  </Td>
                  <Td numeric>{formatCentavos(order.totalCentavos)}</Td>
                  <Td numeric muted={order.walletCreditAppliedCentavos === 0}>
                    {order.walletCreditAppliedCentavos > 0
                      ? formatCentavos(order.walletCreditAppliedCentavos)
                      : '—'}
                  </Td>
                  <Td muted>{manilaTime(order.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
        active ? 'bg-brand-700 text-white' : 'bg-surface-sunken text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}
