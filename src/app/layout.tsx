import type { Metadata, Viewport } from 'next';
import { Urbanist } from 'next/font/google';
import './globals.css';
import { BottomNav } from '@/components/nav/BottomNav';
import { CartProvider } from '@/components/cart/CartProvider';
import { CartBar } from '@/components/cart/CartBar';

/**
 * The typeface.
 *
 * Urbanist, which is the closest free match to the brand artwork on the three
 * features that give that wordmark its character: a single-storey `a` built
 * from a circle and a straight stem with no tail, a `t` whose stem curves right
 * into a tail at the baseline, and flat-cut terminals throughout.
 *
 * It replaced Outfit, which gets the `a` right and the `t` wrong — Outfit's
 * stem stops flat at the baseline, and against the artwork that is the first
 * difference the eye finds.
 *
 * The artwork's own face looks like Circular, Sofia Pro or Gilroy, all
 * commercial. If the licensed file arrives, self-host it and change the
 * `fontFamily.sans` stack: nothing else moves.
 *
 * Loaded through `next/font`, so the files come from our own origin — no
 * third-party request on first paint, and no layout shift while a fallback is
 * swapped out. `variable` rather than a class, because Tailwind reads it as the
 * sans stack and every existing `font-semibold` keeps working.
 */
const display = Urbanist({
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
