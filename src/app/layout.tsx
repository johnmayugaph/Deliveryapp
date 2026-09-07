import type { Metadata, Viewport } from 'next';
import { Outfit } from 'next/font/google';
import './globals.css';
import { BottomNav } from '@/components/nav/BottomNav';
import { CartProvider } from '@/components/cart/CartProvider';
import { CartBar } from '@/components/cart/CartBar';

/**
 * The typeface.
 *
 * A geometric grotesque with a single-storey `a`, which is what the brand
 * artwork uses — the wordmark, the headline weight and the tight tracking all
 * come from that family. Loaded through `next/font`, so the files are served
 * from our own origin: no request to a third party on first paint, and no
 * layout shift while a fallback is swapped out.
 *
 * `variable` rather than a class, because Tailwind reads it as the sans stack
 * and every existing `font-semibold` and `font-bold` keeps working.
 */
const display = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TARA',
  description:
    'Tara — food, mart, parcel, errands and rides in one app.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-PH" className={display.variable}>
      <body>
        <CartProvider>
          <div className="app-shell mx-auto min-h-dvh max-w-lg bg-surface-sunken">
            {children}
          </div>
          <CartBar />
          <BottomNav />
        </CartProvider>
      </body>
    </html>
  );
}
