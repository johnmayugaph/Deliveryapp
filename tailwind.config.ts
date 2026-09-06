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
      colors: {
        brand: {
          50: '#eef7ff',
          100: '#d9edff',
          200: '#bce0ff',
          300: '#8ecdff',
          400: '#59b0ff',
          500: '#3390fb',
          600: '#1c71f0',
          700: '#175add',
          800: '#194ab3',
          900: '#1a418d',
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
