#!/usr/bin/env tsx
/**
 * The launch switch.
 *
 *     npm run plan:activate                          # list plans and their state
 *     npm run plan:activate -- deliveryapp-plus      # launch it
 *     npm run plan:activate -- deliveryapp-plus --off  # pull it
 *
 * `SubscriptionPlan.isActive` is the entire launch mechanism: the pricing
 * engine, the plan screen and the enrollment layer all gate on it, so this flag
 * turns the tier on everywhere with no deploy. Which is exactly why it should
 * not be flipped casually, and why it is a deliberate command rather than a
 * button in an admin screen nobody has reviewed.
 */
import { prisma } from '../src/lib/prisma';
import { formatCentavos } from '../src/lib/money';
import { benefitTerms } from '../src/lib/subscriptions/plans';

async function list() {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      benefits: { orderBy: { sortOrder: 'asc' } },
      _count: { select: { subscriptions: true } },
    },
  });

  if (plans.length === 0) {
    console.log('No plans exist. Run npm run db:seed.');
    return;
  }

  for (const plan of plans) {
    console.log(
      `${plan.isActive ? 'LIVE  ' : 'off   '} ${plan.slug}  ` +
        `${formatCentavos(plan.monthlyPriceCentavos)}/month  ` +
        `${plan._count.subscriptions} subscription(s) ever`,
    );
    for (const benefit of plan.benefits) {
      console.log(`         · ${benefit.displayLabel}`);
      console.log(`           ${benefitTerms(benefit).join(' · ')}`);
    }
  }
  console.log('\nTo launch: npm run plan:activate -- <slug>');
}

async function main() {
  const argv = process.argv.slice(2);
  const off = argv.includes('--off');
  const [slug] = argv.filter((arg) => !arg.startsWith('--'));

  if (!slug) {
    await list();
    return;
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { slug } });
  if (!plan) {
    console.error(`No plan with slug "${slug}".`);
    process.exit(1);
  }

  const nextActive = !off;
  if (plan.isActive === nextActive) {
    console.log(`${plan.name} is already ${nextActive ? 'live' : 'off'}. Nothing to do.`);
    return;
  }

  const [liveSubscriptions, updated] = await prisma.$transaction([
    prisma.userSubscription.count({
      where: { planId: plan.id, status: { in: ['ACTIVE', 'PAST_DUE'] } },
    }),
    prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: { isActive: nextActive },
    }),
  ]);

  console.log(`${updated.name} is now ${nextActive ? 'LIVE' : 'off'}.`);

  if (nextActive) {
    console.log(
      'Benefits now apply at checkout for every ACTIVE subscriber, and the plan ' +
        'screen will offer enrollment.',
    );
    console.log(
      'Paid enrollment still needs a payment provider — until one is configured, ' +
        'only granted subscriptions can be created (npm run plan:comp).',
    );
  } else {
    console.log(
      `Benefits stop immediately, including for the ${liveSubscriptions} live ` +
        'subscription(s) on this plan — the pricing engine requires an active ' +
        'plan. Nobody is charged and nothing is cancelled; the rows stay put.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
