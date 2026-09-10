'use client';

/**
 * The delivery fee fields, as `extraFields` inside a `ReasonForm`.
 *
 * Its own component for one reason: nine money inputs is enough that they need
 * grouping and help text, and `ReasonForm` should stay the thing that owns the
 * reason and the button rather than growing a layout.
 *
 * **Pesos, everywhere, said out loud.** The columns are centavos and the form
 * is pesos, and that conversion is the single most dangerous thing on this
 * screen — a rule entered in centavos would charge a hundredth of the intended
 * fee and look plausible on the list. So every label carries a ₱ and every
 * placeholder is a realistic peso amount rather than a round number that could
 * be read either way.
 */

const FIELD =
  'mt-1 w-full rounded-lg bg-surface-sunken px-3 py-2 text-sm tabular-nums ring-1 ring-black/5';
const LABEL = 'text-[11px] font-semibold text-ink-muted';
const HELP = 'mt-0.5 block text-[10px] leading-snug text-ink-faint';

export function FeeRuleFields({
  services,
  cities,
}: {
  services: { key: string; displayName: string }[];
  cities: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Service</span>
          <select name="serviceType" required className={FIELD} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {services.map((service) => (
              <option key={service.key} value={service.key}>
                {service.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className={LABEL}>City</span>
          {/* Empty value is the fallback rule — `DeliveryFeeRule.cityId` is
              nullable and documents null as "every city where the service is
              live". Named in the option text so it is not a blank that reads
              like an unfilled field. */}
          <select name="cityId" className={FIELD} defaultValue="">
            <option value="">Every city (fallback)</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={LABEL}>Base fee ₱</span>
          <input name="baseFee" required placeholder="39" className={FIELD} />
          <span className={HELP}>Charged before any distance.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Per kilometre ₱</span>
          <input name="perKilometre" required placeholder="12" className={FIELD} />
          <span className={HELP}>Pro rata, beyond the included distance.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Included distance (metres)</span>
          <input name="includedMeters" placeholder="2000" className={FIELD} />
          <span className={HELP}>Covered by the base fee. Blank means none.</span>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={LABEL}>Minimum fee ₱</span>
          <input name="minimumFee" placeholder="39" className={FIELD} />
          <span className={HELP}>Floor on the computed fee. Blank means none.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Maximum fee ₱</span>
          <input name="maximumFee" placeholder="blank for none" className={FIELD} />
          <span className={HELP}>
            Ceiling. TARA absorbs the rest on a long trip.
          </span>
        </label>
        <label className="block">
          <span className={LABEL}>Service fee ₱</span>
          <input name="serviceFee" placeholder="10" className={FIELD} />
          <span className={HELP}>Flat platform fee. TARA keeps this.</span>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={LABEL}>Small order under ₱</span>
          <input name="smallOrderThreshold" placeholder="150" className={FIELD} />
          <span className={HELP}>Subtotal below which the fee below applies.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Small order fee ₱</span>
          <input name="smallOrderFee" placeholder="20" className={FIELD} />
          <span className={HELP}>Needs a threshold, or it can never fire.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Free delivery above ₱</span>
          <input name="freeAboveSubtotal" placeholder="blank to disable" className={FIELD} />
          <span className={HELP}>
            Applies to everybody, unlike the Plus benefit.
          </span>
        </label>
      </div>
    </div>
  );
}
