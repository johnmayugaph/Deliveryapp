/**
 * The console's two charts, drawn as inline SVG on the server.
 *
 * NO CHARTING LIBRARY, deliberately. A line through a handful of points is
 * about thirty lines of path arithmetic; the alternative is shipping a
 * rendering engine to the browser, turning two server components into client
 * ones, and — the part that actually decided it — loading a script from a CDN,
 * which this deployment's egress does not reach. Inline SVG renders with
 * JavaScript switched off, prints, and scales.
 *
 * Both are `aria-hidden` with the figures stated in text beside them. A chart
 * is a summary of numbers a screen reader user should be given directly, not
 * an SVG they have to infer a trend from.
 */

/** A point's y, mapped into the box, with a flat series pinned to the middle. */
function scale(value: number, min: number, max: number, height: number, pad: number): number {
  if (max === min) return height / 2;
  return height - pad - ((value - min) / (max - min)) * (height - pad * 2);
}

/**
 * The line beside a KPI, at a glance.
 *
 * `preserveAspectRatio="none"` with a viewBox, so one component fits whatever
 * width its card turns out to be without measuring anything.
 */
export function Sparkline({
  values,
  className = '',
}: {
  values: number[];
  className?: string;
}) {
  if (values.length < 2) {
    // One point is not a trend. A flat line drawn through a single reading
    // claims a stability nobody has observed.
    return null;
  }

  const width = 240;
  const height = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = width / (values.length - 1);

  const points = values.map(
    (value, index) => `${index * step},${scale(value, min, max, height, 4)}`,
  );

  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`h-9 w-full ${className}`}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The big one: a filled area with a horizontal grid and dated ends.
 *
 * The y-axis starts at zero rather than at the lowest reading. An axis cropped
 * to its data turns a quiet fortnight into a mountain range, which is the
 * oldest way to mislead somebody with a true chart.
 */
export function AreaChart({
  points,
  formatValue,
}: {
  points: { label: string; value: number }[];
  /** How a y-axis figure reads. Money is not a count. */
  formatValue: (value: number) => string;
}) {
  if (points.length < 2) {
    return (
      <p className="px-5 py-12 text-center text-xs text-ink-faint">
        Not enough days yet to draw a line.
      </p>
    );
  }

  const width = 720;
  const height = 220;
  const padY = 12;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = width / (points.length - 1);

  const coords = points.map((point, index) => ({
    x: index * step,
    y: scale(point.value, 0, max, height, padY),
  }));

  const line = coords.map((coord) => `${coord.x},${coord.y}`).join(' ');
  const area = `${coords[0]!.x},${height} ${line} ${coords[coords.length - 1]!.x},${height}`;

  // Four gridlines including the top, so the eye has something to measure the
  // curve against without a full axis.
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    fraction,
    y: scale(max * fraction, 0, max, height, padY),
    label: formatValue(Math.round(max * fraction)),
  }));

  return (
    <div className="px-5 pb-4">
      <div className="flex gap-3">
        <ul className="flex w-20 shrink-0 flex-col-reverse justify-between py-1 text-right text-[10px] tabular-nums text-ink-faint">
          {gridlines.map((gridline) => (
            <li key={gridline.fraction}>{gridline.label}</li>
          ))}
        </ul>

        <svg
          aria-hidden
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-52 w-full text-brand-600"
        >
          <defs>
            <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          {gridlines.map((gridline) => (
            <line
              key={gridline.fraction}
              x1={0}
              x2={width}
              y1={gridline.y}
              y2={gridline.y}
              stroke="currentColor"
              strokeOpacity={0.12}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <polygon points={area} fill="url(#area-fill)" />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      {/* Only the ends are dated. Thirty labels on a phone-width panel is a
          grey smear; the two that matter are where the window starts and
          where it stops. */}
      <div className="ml-[5.75rem] mt-1 flex justify-between text-[10px] text-ink-faint">
        <span>{points[0]!.label}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
    </div>
  );
}
