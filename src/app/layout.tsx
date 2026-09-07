import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/nav/BottomNav';
import { CartProvider } from '@/components/cart/CartProvider';
import { CartBar } from '@/components/cart/CartBar';

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
    <html lang="en-PH">
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
