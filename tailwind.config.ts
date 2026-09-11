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
        /*
         * MAGENTA, WITH THE YELLOW KEPT ON ITS OWN TOKEN.
         *
         * The magenta is the chrome: the header block, the primary buttons,
         * the links. White sits on 600 at 6.7:1 and on 700 at 8.6:1, which is
         * why the fifty-five `bg-brand-600 text-white` controls in this
         * application needed no edits for this hue either — the ramp was built
         * so the dark end carries white whatever the colour is. 500 is 4.6:1,
         * fine for large type and headers, not for a button label; controls
         * take 600 or darker.
         *
         * The mango did not survive as the brand colour but it survives as
         * `sun`, because a promotion is the one thing on a blue screen that
         * has to shout, and a brighter blue cannot shout past the header. Ink
         * on `sun-400` is 9.6:1; white on it is 1.7:1, so a yellow surface
         * always takes a dark label. That rule is the only thing to remember
         * when adding a control: blue surface, white label; yellow surface,
         * ink label.
         */
        brand: {
          50: '#fff1f6',
          100: '#ffe0ec',
          200: '#ffc2d9',
          300: '#ff8fb8',
          400: '#f95d94',
          500: '#e11d6f',
          600: '#c41259',
          700: '#a10f4a',
          800: '#7f0c3a',
          900: '#5e0a2b',
        },
        /*
         * Cool neutrals again, now that the chrome is blue: warm ink over a
         * blue header reads as two different greys. Same three steps, same
         * lightness, so every contrast ratio in the application is unchanged.
         */
        /* The promotion colour. See the note on `brand`. */
        sun: {
          100: '#fff0c4',
          300: '#ffd24a',
          400: '#ffc01c',
          500: '#ffb100',
          700: '#8a4b00',
        },
        ink: {
          DEFAULT: '#101828',
          muted: '#475467',
          faint: '#98a2b3',
        },
        surface: {
          DEFAULT: '#ffffff',
          // The ground the white panels sit on. Cool and very light, so the
          // blue header above it and the cards on it are the only two things
          // with any weight.
          sunken: '#f2f5fb',
          raised: '#ffffff',
        },
        // Per-service accents, resolved from `Service.accentToken`. Adding a
        // vertical means adding a token here and setting it on the row.
        //
        // The softs are pulled toward the cream page so five tiles read as one
        // family in one grid; the bolds stay separated by hue, because the
        // colour is what tells a rider's eye Parcel from Errands at a glance.
        // Every bold is AA on its own soft.
        food: { soft: '#fff1d6', bold: '#9a4a11' },
        mart: { soft: '#e8f6e9', bold: '#166534' },
        parcel: { soft: '#e7effd', bold: '#1e40af' },
        pabili: { soft: '#fdeaf1', bold: '#a21858' },
        ride: { soft: '#ece9fb', bold: '#4338ca' },
      },
      borderRadius: {
        tile: '1.25rem',
        card: '1.5rem',
      },
      boxShadow: {
        /*
         * Warm shadows, and two of them rather than one.
         *
         * A neutral shadow over cream greys the paper it falls on. These are
         * tinted with the ink colour instead, and each is a tight contact
         * shadow plus a wide soft one — the pair is what reads as a card
         * resting on a surface rather than a box with a grey edge.
         */
        tile: '0 1px 2px rgba(16,24,40,0.05), 0 10px 24px -14px rgba(16,24,40,0.22)',
        lifted: '0 2px 4px rgba(16,24,40,0.06), 0 18px 40px -18px rgba(16,24,40,0.28)',
        nav: '0 -1px 0 rgba(16,24,40,0.06), 0 -12px 28px -22px rgba(16,24,40,0.35)',
      },
      backgroundImage: {
        // The promotion card's ground. Kept as a gradient rather than a flat
        // fill so a rail of them does not read as one long yellow block.
        sun: 'linear-gradient(135deg, #ffd24a 0%, #ffc01c 55%, #ffb100 100%)',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        // Used on the home groups. Short, once, and no layout shift — a long
        // entrance on a screen somebody opens twenty times a day is a tax.
        'rise-in': 'rise-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
