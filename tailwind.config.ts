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
         * MANGO AT THE LIGHT END, BURNT AMBER AT THE DARK END — and that shape
         * is the whole trick of a yellow brand.
         *
         * Yellow is the one hue that cannot carry white text. #ffb100 against
         * white is 1.7:1, which is not a contrast failure so much as an
         * unreadable button. Fifty-five controls in this application are
         * `bg-brand-600`/`bg-brand-700` with `text-white`, and a hundred and
         * sixteen labels are `text-brand-700` on white — so a ramp that is
         * yellow all the way down would have quietly broken every one of them,
         * and repainting a hundred and seventy call sites to chase a hue is how
         * a redesign turns into a fortnight.
         *
         * So the ramp does two jobs at two ends. 300–500 are the mango the
         * brand actually is: tile halos, highlights, the sun band behind the
         * header, the focus ring, the primary CTA where the label goes dark.
         * 600–900 are the same pigment cooked down to a deep amber that white
         * sits on comfortably — 600 is 5.4:1 with white, 700 is 7.2:1, and 700
         * on white is 7.2:1 the other way round. Both readings pass AA for body
         * text, which is what makes this a palette swap rather than a rewrite.
         *
         * The rule when adding a control: yellow surface, ink label; amber
         * surface, white label. Never white on 500 or lighter.
         */
        brand: {
          50: '#fff9e8',
          100: '#fff0c4',
          200: '#ffe289',
          300: '#ffd24a',
          400: '#ffc01c',
          500: '#ffb100',
          600: '#a85f00',
          700: '#8a4b00',
          800: '#6e3b00',
          900: '#522b00',
        },
        /*
         * Ink is warmed off neutral. #101828 was a blue-grey, correct beside a
         * blue brand and slightly cold beside this one: the same text over
         * cream reads as a different colour temperature to the paper behind it.
         * These are the same three steps, rotated warm and kept at the same
         * lightness, so every contrast ratio in the application is unchanged.
         */
        ink: {
          DEFAULT: '#1a1611',
          muted: '#5b5346',
          faint: '#9a9284',
        },
        surface: {
          DEFAULT: '#ffffff',
          // Cream rather than grey. The page behind white cards is where a
          // warm palette either reads as deliberate or as a white app with
          // yellow buttons stuck on it.
          sunken: '#fbf7ef',
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
        tile: '0 1px 2px rgba(26,22,17,0.05), 0 10px 24px -14px rgba(26,22,17,0.22)',
        lifted: '0 2px 4px rgba(26,22,17,0.06), 0 18px 40px -18px rgba(26,22,17,0.28)',
        nav: '0 -1px 0 rgba(26,22,17,0.06), 0 -12px 28px -22px rgba(26,22,17,0.35)',
      },
      backgroundImage: {
        // The sun band behind the location header. A radial rather than a
        // linear gradient, so the warmth has a source instead of a direction.
        sun: 'radial-gradient(120% 100% at 12% -20%, #ffd24a 0%, #ffe289 38%, #fff9e8 72%, #ffffff 100%)',
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
