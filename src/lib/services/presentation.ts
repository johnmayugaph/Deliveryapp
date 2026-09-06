/**
 * Resolves `Service.accentToken` and `Service.icon` to concrete classes and
 * glyphs.
 *
 * Tailwind cannot build a class name from a runtime string, so the mapping has
 * to be static — but it is keyed by ACCENT TOKEN, not by service key. A new
 * vertical picks an existing token and needs no change here; a new token is one
 * entry plus its colours in tailwind.config.ts.
 */

export interface AccentClasses {
  tileBackground: string
  iconBackground: string
  iconColor: string
}

const ACCENTS: Readonly<Record<string, AccentClasses>> = {
  food: { tileBackground: 'bg-food-soft', iconBackground: 'bg-white', iconColor: 'text-food-bold' },
  mart: { tileBackground: 'bg-mart-soft', iconBackground: 'bg-white', iconColor: 'text-mart-bold' },
  parcel: { tileBackground: 'bg-parcel-soft', iconBackground: 'bg-white', iconColor: 'text-parcel-bold' },
  pabili: { tileBackground: 'bg-pabili-soft', iconBackground: 'bg-white', iconColor: 'text-pabili-bold' },
  ride: { tileBackground: 'bg-ride-soft', iconBackground: 'bg-white', iconColor: 'text-ride-bold' },
  brand: { tileBackground: 'bg-brand-50', iconBackground: 'bg-white', iconColor: 'text-brand-700' },
};

const FALLBACK_ACCENT: AccentClasses = ACCENTS.brand!;

export function accentClasses(token: string): AccentClasses {
  return ACCENTS[token] ?? FALLBACK_ACCENT;
}

/**
 * Emoji stand-ins for `Service.icon`. Deliberately a lookup rather than an
 * import per service: swapping in a real icon set later means changing this map
 * and nothing else.
 */
const ICONS: Readonly<Record<string, string>> = {
  utensils: '🍽️',
  'shopping-basket': '🧺',
  package: '📦',
  'clipboard-list': '📝',
  bike: '🛵',
};

export function serviceGlyph(icon: string): string {
  return ICONS[icon] ?? '•';
}
