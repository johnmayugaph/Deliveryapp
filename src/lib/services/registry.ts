import { cache } from 'react';
import type { IntentGroup, Service, ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  INTENT_GROUPS_IN_ORDER,
  intentGroupPresentation,
  type IntentGroupPresentation,
} from '@/lib/services/intent-groups';

/**
 * THE service registry.
 *
 * Every part of the product that needs to know something about a vertical asks
 * this module. There is no hardcoded list of services anywhere else in the
 * codebase (`prisma/seed.ts` is the single exception — seeds are the data), and
 * no `if (serviceType === 'FOOD')` branch in shared logic. When behaviour
 * differs between verticals it is either a column on `Service` or an entry in a
 * per-service config map keyed by every `ServiceKey`, so the compiler tells us
 * about the sixth vertical instead of production doing it.
 */

export class UnknownServiceError extends Error {
  constructor(readonly key: string) {
    super(`No service is registered under the key "${key}"`);
    this.name = 'UnknownServiceError';
  }
}

export class ServiceNotActiveError extends Error {
  constructor(readonly key: ServiceKey) {
    super(`Service "${key}" is not accepting orders yet`);
    this.name = 'ServiceNotActiveError';
  }
}

/**
 * Every registered service, in display order. Cached per request: the home
 * screen, the help section and the search box all want this and none of them
 * should each cost a query.
 */
export const getAllServices = cache(async (): Promise<Service[]> => {
  return prisma.service.findMany({ orderBy: { sortOrder: 'asc' } });
});

export const getActiveServices = cache(async (): Promise<Service[]> => {
  const services = await getAllServices();
  return services.filter((service) => service.isActive);
});

export const getComingSoonServices = cache(async (): Promise<Service[]> => {
  const services = await getAllServices();
  return services.filter((service) => !service.isActive && service.isComingSoon);
});

export async function getService(key: ServiceKey): Promise<Service> {
  const services = await getAllServices();
  const service = services.find((candidate) => candidate.key === key);
  if (!service) {
    throw new UnknownServiceError(key);
  }
  return service;
}

/** Active services, restricted to those live in a given city. */
export async function getServicesAvailableInCity(cityId: string): Promise<Service[]> {
  const services = await getActiveServices();
  return services.filter((service) => service.availableCityIds.includes(cityId));
}

export async function isServiceOrderable(key: ServiceKey, cityId?: string): Promise<boolean> {
  const service = await getService(key);
  if (!service.isActive) {
    return false;
  }
  return cityId ? service.availableCityIds.includes(cityId) : true;
}

/**
 * Guard for anything that creates work in a vertical — checkout, dispatch,
 * order creation. Throws rather than returning false so a caller cannot forget
 * to check.
 */
export async function assertServiceOrderable(
  key: ServiceKey,
  cityId?: string,
): Promise<Service> {
  const service = await getService(key);
  if (!service.isActive || (cityId && !service.availableCityIds.includes(cityId))) {
    throw new ServiceNotActiveError(key);
  }
  return service;
}

/**
 * A service as it appears to somebody standing in a particular city.
 *
 * `orderableHere` is the field the tile actually needs, and it is NOT the same
 * as `isActive`. A vertical launches one city at a time — that is how this
 * business works — so "live" and "live where you are" diverge from the first
 * launch onwards, and a component that reads `isActive` to decide whether to
 * make a tile tappable would offer Cebu's Mart to somebody in Manila.
 */
export type ServiceAvailability = Service & { orderableHere: boolean };

/**
 * Whether somebody standing in `cityId` can order this service right now.
 *
 * Pure, and exported, because it is the one rule the tiles, the search hints
 * and the console all have to agree on. With no city (a visitor who has told
 * us nothing) the answer falls back to whether the service is live at all —
 * we would rather show a tile and resolve the city at checkout than show
 * nothing to somebody who has not set an address.
 */
export function isOrderableIn(
  service: Pick<Service, 'isActive' | 'availableCityIds'>,
  cityId?: string,
): boolean {
  if (!service.isActive) return false;
  if (cityId === undefined) return true;
  return service.availableCityIds.includes(cityId);
}

export interface ServiceGroup {
  group: IntentGroup;
  presentation: IntentGroupPresentation;
  services: ServiceAvailability[];
}

/**
 * Services bucketed by intent group, in group order then `sortOrder`. Empty
 * groups are omitted, so the PAY section simply does not render until something
 * lives in it.
 *
 * A service that is live but not in THIS city stays visible, as something to
 * anticipate rather than something to tap. Dropping it — which this function
 * used to do — meant a vertical launched in Cebu vanished from Manila
 * entirely: neither usable nor coming, just absent, with no way for anybody in
 * Manila to know it existed. That is the wrong answer to "we launched
 * somewhere", and it is only reachable now that the console can put a service
 * into that state.
 */
export async function getServicesByIntentGroup(options?: {
  cityId?: string;
}): Promise<ServiceGroup[]> {
  const services = await getAllServices();

  const visible: ServiceAvailability[] = services
    // A service the customer can neither use nor anticipate is noise.
    .filter((service) => service.isActive || service.isComingSoon)
    .map((service) => ({
      ...service,
      orderableHere: isOrderableIn(service, options?.cityId),
    }));

  return INTENT_GROUPS_IN_ORDER.map((group) => ({
    group,
    presentation: intentGroupPresentation(group),
    services: visible
      .filter((service) => service.intentGroup === group)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  })).filter((bucket) => bucket.services.length > 0);
}

/**
 * Service keys a fleet-facing or merchant-facing query should consider. Reads
 * the registry so a newly activated vertical is picked up without a deploy.
 */
export async function getActiveServiceKeys(): Promise<ServiceKey[]> {
  const services = await getActiveServices();
  return services.map((service) => service.key);
}

/** Active services that require a merchant, i.e. that need a store catalogue. */
export async function getMerchantBackedServiceKeys(): Promise<ServiceKey[]> {
  const services = await getActiveServices();
  return services.filter((service) => service.requiresMerchant).map((s) => s.key);
}

/** Active services that need a fleet partner assigned. Dispatch reads this. */
export async function getFleetBackedServiceKeys(): Promise<ServiceKey[]> {
  const services = await getActiveServices();
  return services.filter((service) => service.requiresRider).map((s) => s.key);
}
