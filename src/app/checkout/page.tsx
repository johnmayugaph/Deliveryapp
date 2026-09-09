import Link from 'next/link';
import { PaymentMethod } from '@prisma/client';
import { requireScreen } from '@/lib/auth/access';
import { listAddressBook } from '@/lib/addresses/usage';
import { readCreditsBalance } from '@/lib/wallet/ledger';
import { creditsState } from '@/lib/wallet/held';
import { CheckoutForm } from '@/components/cart/CheckoutForm';
import { resolvePaymentRail } from '@/lib/payments/rails';

export const dynamic = 'force-dynamic';

/**
 * Checkout.
 *
 * The server supplies the address book and the credits balance; the client
 * component holds the cart and asks the server to price it. Every peso shown
 * here comes from `quoteCheckoutAction`, which is the same function placement
 * calls — so the number on this screen is the number charged, by construction
 * rather than by careful maintenance.
 */
export default async function CheckoutPage() {
  /* ONBOARDED in the screen map: placing an order needs somebody to hand
     the food to, so an unfinished account goes to /welcome and a missing
     session goes to /login and comes back here. */
  const user = await requireScreen('checkout');

  const [addresses, wallet] = await Promise.all([
    listAddressBook({ userId: user.id }),
    readCreditsBalance(user.id),
  ]);
  /* Only for the first paint. Every quote carries the live state, and the form
     prefers it — a balance rendered from page load is a balance that stops
     being true the moment anything happens to it. */
  const credits = creditsState(wallet, new Date());

  // Read on the server and reduced to a label before it crosses to the client:
  // the account name and number are configuration, and they belong on the
  // payment screen of an order that exists, not in the bundle of every
  // checkout page view.
  const rail = resolvePaymentRail();

  return (
    <main className="pb-4">
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/" className="text-xs font-semibold text-brand-700">
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-bold">Checkout</h1>
      </header>

      {addresses.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          You need an address before ordering.{' '}
          <Link href="/addresses" className="font-semibold text-brand-700 underline">
            Add an address
          </Link>
          .
        </p>
      ) : (
        <CheckoutForm
          addresses={addresses.map((address) => ({
            id: address.id,
            label: address.label,
            line1: address.line1,
            barangay: address.barangay,
            cityName: address.city?.name ?? null,
            isDefault: address.isDefault,
          }))}
          credits={credits}
          // The transfer appears only when there is an account to send money
          // to. Offering a payment method the deployment cannot receive takes
          // an order nobody can pay, which is worse than not offering it.
          paymentMethods={[
            PaymentMethod.CASH_ON_DELIVERY,
            ...(rail ? [PaymentMethod.MANUAL_TRANSFER] : []),
            PaymentMethod.WALLET_CREDIT,
          ]}
          transferLabel={rail?.customerLabel ?? null}
        />
      )}
    </main>
  );
}
