import Link from 'next/link';
import { PaymentMethod } from '@prisma/client';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { listAddressBook } from '@/lib/addresses/usage';
import { getSpendableCentavos } from '@/lib/wallet/ledger';
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
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login?next=%2Fcheckout');
  }
  // Placing an order needs somebody to hand the food to.
  if (user.onboardedAt === null) {
    redirect('/welcome');
  }

  const [addresses, spendableCreditsCentavos] = await Promise.all([
    listAddressBook({ userId: user.id }),
    getSpendableCentavos(user.id),
  ]);

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
          spendableCreditsCentavos={spendableCreditsCentavos}
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
