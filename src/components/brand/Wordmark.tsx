/**
 * The wordmark.
 *
 * Lowercase, because that is how the mark is drawn in the brand artwork — the
 * name is written TARA in a sentence and set `tara` as a logo, which is the
 * ordinary split between a wordmark and prose.
 *
 * Tight tracking and the 700 weight are the two things that make it read as the
 * logo rather than as a word in the same typeface, so they live here once
 * instead of being re-typed at every call site.
 */
export function Wordmark({
  size = 'md',
  tone = 'brand',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  tone?: 'brand' | 'light' | 'ink';
  className?: string;
}) {
  const sizes = {
    sm: 'text-base',
    md: 'text-2xl',
    lg: 'text-4xl',
  } as const;

  const tones = {
    brand: 'text-brand-500',
    light: 'text-white',
    ink: 'text-ink',
  } as const;

  return (
    <span
      // The visible text is already the name, so it needs no label of its own.
      className={`inline-block font-bold lowercase leading-none tracking-[-0.045em] ${sizes[size]} ${tones[tone]} ${className}`}
    >
      tara
    </span>
  );
}
