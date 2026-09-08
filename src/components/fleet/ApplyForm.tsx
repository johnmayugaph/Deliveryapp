'use client';

import { useState, useTransition } from 'react';
import { ServiceKey, VehicleType } from '@prisma/client';
import { applyToFleetAction } from '@/lib/actions/fleet-actions';

export interface ApplyServiceOption {
  key: ServiceKey;
  displayName: string;
  tagline: string;
  isActive: boolean;
}

/**
 * What the rider-invite programme pays, when it is running.
 *
 * Null when it is off, and then the field is not rendered at all rather than
 * rendered disabled: a box asking for a code that can earn nothing is a
 * promise the app cannot keep, and somebody who types their friend's code into
 * it will be waiting for a bonus that was never coming.
 */
export interface ApplyInviteFacts {
  refereeCentavos: number;
  qualifyingDeliveries: number;
}

const VEHICLE_LABELS: Record<VehicleType, string> = {
  [VehicleType.ON_FOOT]: 'Naglalakad',
  [VehicleType.BICYCLE]: 'Bisikleta',
  [VehicleType.MOTORCYCLE]: 'Motorsiklo',
  [VehicleType.TRICYCLE]: 'Traysikel',
  [VehicleType.CAR]: 'Kotse',
  [VehicleType.MPV]: 'MPV',
  [VehicleType.VAN]: 'Van',
};

/**
 * Applying to join the fleet.
 *
 * Services are checkboxes because approval is PER SERVICE — applying for food
 * and for passengers are separate decisions, and a single "join the fleet"
 * button would hide that. Coming-soon services can be applied for so the
 * verification queue is warm on the day one launches.
 */
export function ApplyForm({
  services,
  invite,
}: {
  services: ApplyServiceOption[];
  invite: ApplyInviteFacts | null;
}) {
  const [vehicleType, setVehicleType] = useState<VehicleType | ''>('');
  const [plate, setPlate] = useState('');
  const [selected, setSelected] = useState<ServiceKey[]>([]);
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /** Vehicles with no registration plate to give. */
  const PLATELESS: readonly VehicleType[] = [VehicleType.ON_FOOT, VehicleType.BICYCLE];
  const needsPlate = vehicleType !== '' && !PLATELESS.includes(vehicleType);

  function toggle(key: ServiceKey) {
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        if (vehicleType === '') {
          setError('Choose a vehicle.');
          return;
        }
        startTransition(async () => {
          // Redirects on success, so anything returned is a failure.
          const result = await applyToFleetAction({
            vehicleType: vehicleType as VehicleType,
            vehiclePlate: plate,
            serviceKeys: selected,
            inviteCode,
          });
          if (result && !result.ok) setError(result.message);
        });
      }}
    >
      <fieldset>
        <legend className="text-[13px] font-semibold">Vehicle</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(Object.values(VehicleType) as VehicleType[]).map((type) => (
            <label
              key={type}
              className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium ring-1 transition-colors ${
                vehicleType === type
                  ? 'bg-brand-50 text-brand-800 ring-brand-300'
                  : 'bg-surface-sunken ring-black/5 hover:bg-brand-50/50'
              }`}
            >
              <input
                type="radio"
                name="vehicleType"
                value={type}
                checked={vehicleType === type}
                onChange={() => setVehicleType(type)}
                className="accent-brand-600"
              />
              {VEHICLE_LABELS[type]}
            </label>
          ))}
        </div>
      </fieldset>

      {needsPlate ? (
        <label className="block">
          <span className="text-[13px] font-semibold">Plate number</span>
          <input
            type="text"
            name="vehiclePlate"
            value={plate}
            onChange={(event) => setPlate(event.target.value.toUpperCase())}
            maxLength={20}
            placeholder="NCR 1234"
            className="mt-1.5 w-full rounded-xl bg-surface-sunken px-3 py-2.5 text-sm uppercase ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
      ) : null}

      <fieldset>
        <legend className="text-[13px] font-semibold">Anong gusto mong ihatid?</legend>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          Every service is approved separately. Being approved for food is not
          approval to carry a passenger.
        </p>
        <div className="mt-2 space-y-1.5">
          {services.map((service) => (
            <label
              key={service.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-surface-sunken p-2.5 ring-1 ring-black/5"
            >
              <input
                type="checkbox"
                checked={selected.includes(service.key)}
                onChange={() => toggle(service.key)}
                className="mt-0.5 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">
                  {service.displayName}
                  {service.isActive ? null : (
                    <span className="ml-1.5 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-faint">
                      Coming soon
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-muted">
                  {service.tagline}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {invite ? (
        <label className="block">
          <span className="text-[13px] font-semibold">
            Invite code{' '}
            <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <input
            type="text"
            name="inviteCode"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
            maxLength={40}
            autoComplete="off"
            placeholder="From the rider who told you about TARA"
            className="mt-1.5 w-full rounded-xl bg-surface-sunken px-3 py-2.5 text-sm uppercase tracking-wide ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">
            {invite.refereeCentavos > 0
              ? `You both get paid once you have completed ${invite.qualifyingDeliveries} ${
                  invite.qualifyingDeliveries === 1 ? 'delivery' : 'deliveries'
                } — added to what TARA owes you, not to credits.`
              : `The rider who invited you gets paid once you have completed ${invite.qualifyingDeliveries} ${
                  invite.qualifyingDeliveries === 1 ? 'delivery' : 'deliveries'
                }.`}{' '}
            A code that does not work will not hold up your application.
          </span>
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending || selected.length === 0 || vehicleType === ''}
        className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {isPending ? 'Sending…' : 'Mag-apply'}
      </button>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        We will review your application. No offers arrive until a service
        is approved.
      </p>
    </form>
  );
}
