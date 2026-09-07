import type { Config } from 'tailwindcss';

/**
 * Palette note: service tiles never hardcode a colour per service key. Each
 * Service row carries its own `accentToken`, which resolves against these
 * named tokens at render time. Adding a sixth vertical is a data change.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // The variable is set on <html> by next/font; the fallbacks are the
        // geometric-ish system faces, so a failed font load degrades to
        // something with the same proportions rather than to Times.
        sans: [
          'var(--font-display)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // Built around the brand blue, #077aff, which is 500 — the wordmark and
        // large type use it as-is. Buttons and small white-on-blue text use 700
        // instead: white on #077aff is 4.0:1, which passes AA for large text
        // and misses it for body, and a brand colour is not worth an
        // unreadable label.
        brand: {
          50: '#ecf4ff',
          100: '#d7e9ff',
          200: '#b3d5ff',
          300: '#7fb8ff',
          400: '#3f95ff',
          500: '#077aff',
          600: '#0668e6',
          700: '#0a56c4',
          800: '#0d479c',
          900: '#0f3d7d',
        },
        ink: {
          DEFAULT: '#101828',
          muted: '#475467',
          faint: '#98a2b3',
        },
        surface: {
          DEFAULT: '#ffffff',
          sunken: '#f7f8fa',
          raised: '#ffffff',
        },
        // Per-service accents, resolved from `Service.accentToken`. Adding a
        // vertical means adding a token here and setting it on the row.
        food: { soft: '#fff1e6', bold: '#c2410c' },
        mart: { soft: '#eafaf1', bold: '#047857' },
        parcel: { soft: '#eef2ff', bold: '#4338ca' },
        pabili: { soft: '#fdf2f8', bold: '#be185d' },
        ride: { soft: '#eff6ff', bold: '#1d4ed8' },
      },
      borderRadius: {
        tile: '1rem',
      },
    },
  },
  plugins: [],
};

export default config;
