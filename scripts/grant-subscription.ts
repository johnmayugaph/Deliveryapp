#!/usr/bin/env tsx
/**
 * Grants or ends a subscription.
 *
 *     npm run plan:comp -- 0917 123 4567 --by 0917 000 9999 "Pilot cohort"
 *     npm run plan:comp -- 0917 123 4567 --by 0917 000 9999 --promo "Launch week"
 *     npm run plan:comp -- 0917 123 4567 --cancel
 *
 * Granting is not self-service, and it is not anonymous: `--by` names the person
 * making the decision and the reason is stored on the row. A comp is revenue we
 * chose not to collect, and a comp list nobody can attribute is how that choice
 * stops being a choice.
 *
 * This is also the only way onto a plan today: paid enrollment is refused while
 * no payment provider is configured — see src/lib/subscriptions/payment.ts.
 */
import { SubscriptionOrigin, UserRole } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { normalisePhilippineMobile, formatPhilippineMobile } from '../src/lib/auth/phone';
import { cancelSubscription, enrollInPlan, liveSubscription } from '../src/lib/subscriptions/enrollment';

const GRANTOR_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.SUPPORT_AGENT];

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: npm run plan:comp -- <phone> --by <admin phone> [--promo] "<reason>"');
  console.error('       npm run plan:comp -- <phone> --cancel');
  process.exit(1);
}

/** A run of digit-ish tokens, joined: phone numbers get typed with spaces. */
function joinPhone(tokens: string[], label: string): string {
  if (tokens.length === 0) usage(`Name the ${label} by phone number.`);
  try {
    return normalisePhilippineMobile(tokens.join(''));
  } catch (error) {
    return usage(error instanceof Error ? error.message : `Bad ${label} number.`);
  }
}

const looksNumeric = (token: string) => /^[+\d][\d\s().-]*$/.test(token);

/**
 * Splits the command line into a subscriber, an optional grantor and a reason.
 *
 * The shell has already split "0917 123 4567" into three tokens, so the parse
 * works by runs: numeric tokens belong to whichever phone is being read, and
 * everything left over is the reason.
 */
export function parseGrantArgs(argv: readonly string[]): {
  subscriberTokens: string[];
  grantorTokens: string[];
  reason: string;
  cancelling: boolean;
  promotional: boolean;
} {
  const subscriberTokens: string[] = [];
  const grantorTokens: string[] = [];
  const reasonWords: string[] = [];
  let cancelling = false;
  let promotional = false;
  let target: 'subscriber' | 'grantor' | null = 'subscriber';

  for (const token of argv) {
    if (token === '--cancel') {
      cancelling = true;
      target = null;
      continue;
    }
    if (token === '--promo') {
      promotional = true;
      target = null;
      continue;
    }
    if (token === '--by') {
      target = 'grantor';
      continue;
    }
    if (token.startsWith('--')) {
      usage(`Unknown flag ${token}.`);
    }
    if (looksNumeric(token)) {
      if (target === 'grantor') {
        grantorTokens.push(token);
        continue;
      }
      if (target === 'subscriber') {
        subscriberTokens.push(token);
        continue;
      }
    }
    // A non-numeric token ends whichever phone was being read.
    target = null;
    reasonWords.push(token);
  }

  return {
    subscriberTokens,
    grantorTokens,
    reason: reasonWords.join(' ').trim(),
    cancelling,
    promotional,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage('No arguments given.');

  const parsed = parseGrantArgs(argv);
  const phone = joinPhone(parsed.subscriberTokens, 'subscriber');
  const { cancelling, promotional, reason } = parsed;
  const grantorPhone =
    parsed.grantorTokens.length > 0 ? joinPhone(parsed.grantorTokens, 'grantor') : null;

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) usage(`No account for ${phone}.`);

  if (cancelling) {
    const ended = await cancelSubscription({ userId: user.id, reason: reason || undefined });
    console.log(
      `Ended ${formatPhilippineMobile(phone)}'s subscription (${ended.origin}). ` +
        'Benefits stop now.',
    );
    return;
  }

  if (!grantorPhone) usage('Say who is granting this: --by <admin phone>.');
  if (!reason) usage('Say why. The reason is stored on the subscription.');

  const grantor = await prisma.user.findUnique({ where: { phone: grantorPhone } });
  if (!grantor) usage(`No account for the grantor ${grantorPhone}.`);
  if (!grantor.roles.some((role) => GRANTOR_ROLES.includes(role))) {
    usage(
      `${grantorPhone} is not an admin or support agent, so cannot grant a ` +
        'subscription.',
    );
  }

  const already = await liveSubscription(user.id);
  if (already) {
    usage(
      `${formatPhilippineMobile(phone)} already holds a live subscription ` +
        `(${already.plan.name}, ${already.status}). Cancel it first.`,
    );
  }

  const subscription = await enrollInPlan({
    userId: user.id,
    origin: promotional ? SubscriptionOrigin.PROMOTIONAL : SubscriptionOrigin.COMPED,
    grantedByUserId: grantor.id,
    grantNote: reason,
  });

  console.log(
    `${formatPhilippineMobile(phone)} is on ${subscription.plan.name} ` +
      `(${subscription.origin}) until ${subscription.renewsAt.toISOString().slice(0, 10)}.`,
  );
  console.log(`Granted by ${formatPhilippineMobile(grantorPhone)} — "${reason}"`);
  console.log('It does not renew itself: a granted term ends and is re-granted on purpose.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
