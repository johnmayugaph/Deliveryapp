import Link from 'next/link';
import {
  STOREFRONT_BLOCKERS,
  needsSupport,
  screenToOpen,
  type BlockerFix,
  type StorefrontServiceView,
  type StorefrontState,
} from '@/lib/merchant/storefront-policy';

/**
 * Whether customers can order, and what to do about it.
 *
 * First on the settings screen, above the prep time, because it answers the
 * only question a shop with an empty queue is actually asking. Every sentence
 * comes from `storefront-policy.ts`, so none of it can outlive the gate it
 * describes.
 */

/**
 * The chip beside each blocker: where the fix is, in two words.
 *
 * Compile-enforced over the fix union, because the first version derived it
 * from a single "the shop can clear this" flag and therefore labelled a shop
 * that had closed for the night "Yours to fix".
 */
const CHIP: Readonly<Record<BlockerFix['kind'], { label: string; tone: string }>> = {
  SUPPORT: { label: 'TARA', tone: 'bg-surface text-ink-muted' },
  WAIT: { label: 'Not yet', tone: 'bg-surface text-ink-muted' },
  SWITCH: { label: 'Your switch', tone: 'bg-surface-sunken text-ink-muted ring-1 ring-black/5' },
  SCREEN: { label: 'Yours to fix', tone: 'bg-brand-50 text-brand-700' },
};

/** Compile-enforced, so a fifth standing cannot render as a blank pill. */
const STANDING: Readonly<
  Record<StorefrontServiceView['standing'], { label: (city: string) => string; tone: string }>
> = {
  ORDERABLE: {
    // A statement about the SERVICE, which is what this row is. It read
    // "Taking orders", which sat under "Customers cannot find your shop" on a
    // hidden shop and flatly contradicted it.
    label: () => 'Live here',
    tone: 'bg-emerald-50 text-emerald-800',
  },
  NOT_HERE_YET: {
    // The city is named because "not live" reads as "not built" otherwise,
    // and this service is running perfectly well somewhere else.
    label: (city) => `Not in ${city} yet`,
    tone: 'bg-amber-50 text-amber-900',
  },
  COMING_SOON: {
    label: () => 'Coming soon',
    tone: 'bg-surface-sunken text-ink-faint',
  },
  NO_PRICING: {
    label: () => 'No delivery pricing',
    tone: 'bg-rose-50 text-rose-800',
  },
};

function Headline({ state }: { state: StorefrontState }) {
  if (state.orderable) {
    return (
      <p className="mt-1 text-[13px] font-semibold text-emerald-800">
        Customers can order now.
      </p>
    );
  }
  if (state.readyWhenOpen) {
    // Closed on purpose is not a fault, and must not be dressed as one.
    return (
      <p className="mt-1 text-[13px] font-semibold text-ink">
        Sarado — everything else is ready.
      </p>
    );
  }
  return (
    <p className="mt-1 text-[13px] font-semibold text-rose-800">
      {state.listed
        ? 'Customers can find you, but cannot finish an order.'
        : 'Customers cannot find your shop.'}
    </p>
  );
}

export function StorefrontPanel({
  state,
  storeId,
  slug,
  addressLine,
}: {
  state: StorefrontState;
  storeId: string;
  slug: string;
  addressLine: string;
}) {
  const screen = screenToOpen(state);
  const support = needsSupport(state);

  return (
    <section
      aria-labelledby="storefront-heading"
      className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="storefront-heading" className="text-[13px] font-semibold">
        Your storefront
      </h2>
      <Headline state={state} />

      {state.blockers.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {state.blockers.map((blocker) => {
            const copy = STOREFRONT_BLOCKERS[blocker];
            const chip = CHIP[copy.fix.kind];
            return (
              <li
                key={blocker}
                className="rounded-lg bg-surface-sunken p-2.5 text-[11px] leading-relaxed"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-ink">{copy.title}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${chip.tone}`}
                  >
                    {chip.label}
                  </span>
                </div>
                <p className="mt-0.5 text-ink-muted">{copy.detail}</p>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
        One route out, rather than a link on every row saying the same thing —
        and only where a link is actually the answer. The switch needs none:
        it is in the header of this very screen, which the sentence says.
      */}
      {screen !== null || support ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {screen !== null ? (
            <Link
              href={`/merchant/${storeId}/${screen.path}`}
              className="rounded-lg bg-surface-sunken px-3 py-2 text-[12px] font-semibold text-brand-700"
            >
              Open {screen.tab}
            </Link>
          ) : null}
          {support ? (
            <Link
              href="/help/contact"
              className="rounded-lg bg-surface-sunken px-3 py-2 text-[12px] font-semibold text-brand-700"
            >
              Message support
            </Link>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-4 space-y-1.5 border-t border-black/5 pt-3 text-[11px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-faint">Address</dt>
          <dd className="text-right text-ink-muted">
            {addressLine}, {state.cityName}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-faint">Customer page</dt>
          <dd className="text-right">
            {/* The shop's own storefront, as a customer sees it. Nothing else in
                the merchant app links there, so checking what a customer sees
                meant knowing the slug. */}
            <Link href={`/stores/${slug}`} className="font-semibold text-brand-700">
              /stores/{slug}
            </Link>
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-[11px] text-ink-faint">
        The shop’s name, address and map pin are set by TARA. Message support to
        change them.
      </p>
    </section>
  );
}

/** The services row, rendered from the same state. */
export function StorefrontServices({ state }: { state: StorefrontState }) {
  if (state.services.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-ink-muted">
        This shop is not attached to any service yet.
      </p>
    );
  }
  return (
    <ul className="mt-2 space-y-1.5">
      {state.services.map((service) => {
        const standing = STANDING[service.standing];
        return (
          <li key={service.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{service.displayName}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${standing.tone}`}
            >
              {standing.label(state.cityName)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
