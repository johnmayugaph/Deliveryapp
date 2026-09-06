#!/usr/bin/env tsx
/**
 * Approves a fleet partner for a service.
 *
 *     npm run fleet:approve -- 0917 555 0123 FOOD
 *     npm run fleet:approve -- +639175550123 FOOD RIDE
 *     npm run fleet:approve -- 0917 555 0123 --reject FOOD "Expired licence"
 *
 * There is no admin UI yet, and approval must not be self-service: the whole
 * point of per-service verification is that approval for food is not approval
 * to carry a passenger. This script is the honest stand-in — a real console is
 * a later phase, and until then somebody has to run this deliberately.
 */
import { PrismaClient, ServiceKey, VerificationStatus } from '@prisma/client';
import { normalisePhilippineMobile } from '../src/lib/auth/phone';
import { syncEnabledServices } from '../src/lib/fleet/dispatch';

const prisma = new PrismaClient();

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: npm run fleet:approve -- <phone> [--reject] <SERVICE...> [reason]');
  console.error(`Services: ${Object.values(ServiceKey).join(', ')}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage('No arguments given.');

  const reject = argv.includes('--reject');
  const rest = argv.filter((arg) => arg !== '--reject');

  const serviceNames = new Set(Object.values(ServiceKey) as string[]);
  const services = rest.filter((arg) => serviceNames.has(arg.toUpperCase())) as ServiceKey[];
  if (services.length === 0) usage('Name at least one service.');

  // Whatever is left before the services is the phone; anything after is a
  // rejection reason. Phone numbers get written with spaces, so join them.
  const firstServiceIndex = rest.findIndex((arg) => serviceNames.has(arg.toUpperCase()));
  const phoneParts = rest.slice(0, firstServiceIndex);
  const reason = rest.slice(firstServiceIndex + services.length).join(' ') || null;

  if (phoneParts.length === 0) usage('Name the partner by phone number.');

  let phone: string;
  try {
    phone = normalisePhilippineMobile(phoneParts.join(''));
  } catch (error) {
    usage(error instanceof Error ? error.message : 'Bad phone number.');
  }

  const user = await prisma.user.findUnique({
    where: { phone },
    include: { fleetPartner: true },
  });
  if (!user) usage(`No account for ${phone}.`);
  if (!user.fleetPartner) usage(`${phone} has not applied to the fleet.`);

  const partner = user.fleetPartner;
  const now = new Date();

  for (const serviceType of services.map((s) => s.toUpperCase() as ServiceKey)) {
    await prisma.fleetPartnerServiceVerification.upsert({
      where: { fleetPartnerId_serviceType: { fleetPartnerId: partner.id, serviceType } },
      create: {
        fleetPartnerId: partner.id,
        serviceType,
        status: reject ? VerificationStatus.REJECTED : VerificationStatus.APPROVED,
        submittedAt: now,
        decidedAt: now,
        rejectionReason: reject ? reason : null,
      },
      update: {
        status: reject ? VerificationStatus.REJECTED : VerificationStatus.APPROVED,
        decidedAt: now,
        rejectionReason: reject ? reason : null,
      },
    });
    console.log(`${reject ? 'Rejected' : 'Approved'} ${phone} for ${serviceType}`);
  }

  // `enabledServices` is derived; this is the only thing that writes it.
  const enabled = await syncEnabledServices(partner.id);
  console.log(`enabledServices is now: ${enabled.join(', ') || '(none)'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
