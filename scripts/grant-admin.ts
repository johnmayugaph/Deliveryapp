#!/usr/bin/env tsx
/**
 * Grants or revokes console access.
 *
 *     npm run admin:grant -- 09171234567 --reason "first admin, launch"
 *     npm run admin:grant -- 09171234567 --support --reason "tkt 4821, joining ops"
 *     npm run admin:grant -- 09171234567 --revoke --reason "left the team"
 *
 * This exists because of what `npm run db:purge-demo` does. Purging the demo
 * data removes the only ADMIN account a fresh database has — correctly, since
 * it sits on a number a stranger owns — and there is no screen for making
 * another one, because a screen for granting yourself administrator access
 * would be the largest hole in the product.
 *
 * So the boundary is possession of the database. That is not a loophole: a
 * shell with DATABASE_URL can grant itself anything by writing SQL directly.
 * What this adds over `UPDATE "User" SET roles = ...` is the audit row, which
 * is the part somebody will want six months from now.
 *
 * THE ACCOUNT MUST ALREADY EXIST. It is created the first time somebody signs
 * in with that number, which means the person being made an administrator has
 * already proved they hold the phone. Creating the account here would let an
 * operator mint console access for a number nobody has answered.
 *
 * On the audit row: `actorId` is the account that GAINED or LOST the role,
 * not the person who ran the command, because a shell has no identity to
 * record. That is why `--reason` is mandatory and why it should name a human.
 */
import { AdminAction, UserRole } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import {
  AuditReasonRequiredError,
  normaliseReason,
  recordAdminAction,
} from '../src/lib/admin/access';
import { signInIsPermitted } from '../src/lib/demo/policy';
import {
  InvalidPhoneNumberError,
  formatPhilippineMobile,
  normalisePhilippineMobile,
} from '../src/lib/auth/phone';

/** The roles this script may touch. Nothing else is grantable from a shell. */
const CONSOLE_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.SUPPORT_AGENT];

function usage(): never {
  console.error(
    [
      'Usage: npm run admin:grant -- <philippine-mobile> --reason "<why>" [--support] [--revoke]',
      '',
      '  --reason   Required, at least 8 characters. It goes in the audit trail,',
      '             so name the person and the ticket: "tkt 4821, Rina joining ops".',
      '  --support  Also grant SUPPORT_AGENT (ticket assignment). ADMIN alone is',
      '             enough for the console.',
      '  --revoke   Take both roles away instead.',
      '',
      'The account must already exist — the person signs in once with their own',
      'number first, which is what proves they hold it.',
    ].join('\n'),
  );
  process.exit(2);
}

interface ParsedArgs {
  positional: string[];
  reason: string | undefined;
  revoke: boolean;
  withSupport: boolean;
}

/**
 * Read left to right, so `--reason` consumes the word after it.
 *
 * Written out rather than done with `args.filter` because a reason of "0917
 * 123 4567 asked for it" would otherwise have its first word taken for the
 * phone number, and the resulting audit row would be attached to the wrong
 * account.
 */
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positional: [],
    reason: undefined,
    revoke: false,
    withSupport: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--reason') {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        parsed.reason = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--revoke') {
      parsed.revoke = true;
      continue;
    }
    if (arg === '--support') {
      parsed.withSupport = true;
      continue;
    }
    if (arg.startsWith('--')) continue;
    parsed.positional.push(arg);
  }

  return parsed;
}

async function main() {
  const { positional, reason: reasonValue, revoke, withSupport } = parseArgs(
    process.argv.slice(2),
  );
  if (positional.length !== 1) usage();

  let reason: string;
  try {
    reason = normaliseReason(reasonValue);
  } catch (error) {
    if (error instanceof AuditReasonRequiredError) {
      console.error(`\n  ${error.message}\n`);
      usage();
    }
    throw error;
  }

  let phone: string;
  try {
    phone = normalisePhilippineMobile(positional[0]!);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      console.error(`Not a Philippine mobile number: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const user = await prisma.user.findUnique({
    where: { phone },
    select: {
      id: true,
      phone: true,
      fullName: true,
      roles: true,
      isBlocked: true,
      isDemo: true,
      onboardedAt: true,
    },
  });

  if (!user) {
    console.error('');
    console.error(`  No account with ${formatPhilippineMobile(phone)}.`);
    console.error('');
    console.error('  Ask them to open the app and sign in with that number once —');
    console.error('  the account is created the moment they enter the code. Then run');
    console.error('  this again. Creating it here would grant console access to a');
    console.error('  number nobody has answered.');
    console.error('');
    process.exit(1);
  }

  if (!revoke && !signInIsPermitted(user)) {
    // A blocked account, or a demo account on a production deployment. Either
    // way it cannot hold a session, so the roles would do nothing at all.
    console.error('');
    console.error(`  ${formatPhilippineMobile(user.phone)} cannot sign in:`);
    console.error(
      user.isBlocked
        ? '  the account is blocked. Unblock it in the console first.'
        : '  it is a demo account, and demo accounts are refused in production.\n' +
            '  Use a number a real person controls.',
    );
    console.error('');
    process.exit(1);
  }

  const wanted = revoke
    ? user.roles.filter((role) => !CONSOLE_ROLES.includes(role))
    : [
        ...new Set([
          ...user.roles,
          UserRole.ADMIN,
          ...(withSupport ? [UserRole.SUPPORT_AGENT] : []),
        ]),
      ];

  const unchanged =
    wanted.length === user.roles.length &&
    wanted.every((role) => user.roles.includes(role));
  if (unchanged) {
    console.log('');
    console.log(
      `  ${formatPhilippineMobile(user.phone)} already holds exactly` +
        ` [${user.roles.join(', ')}]. Nothing to change.`,
    );
    console.log('');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { roles: wanted } });
    await recordAdminAction(
      {
        // The account that gained or lost the role. A shell has no identity of
        // its own, and inventing one would be worse than saying so.
        actorId: user.id,
        action: AdminAction.ADMIN_ROLE_CHANGED,
        subjectType: 'User',
        subjectId: user.id,
        subjectLabel: `${user.fullName ?? 'unnamed'} ${formatPhilippineMobile(user.phone)}`,
        reason,
        detail: { via: 'cli', before: user.roles, after: wanted },
      },
      tx,
    );
  });

  console.log('');
  console.log(
    `  ${formatPhilippineMobile(user.phone)} — ${user.fullName ?? '(no name yet)'}`,
  );
  console.log(`  roles: ${user.roles.join(', ')}  ->  ${wanted.join(', ')}`);
  console.log('');
  if (!revoke) {
    if (user.onboardedAt === null) {
      console.log('  They have not finished onboarding — the app will ask for a name');
      console.log('  before /admin opens. That is expected.');
      console.log('');
    }
    console.log('  /admin works for them on their next page load.');
  } else {
    console.log('  Their existing session stays valid as a customer; the console is');
    console.log('  closed to them from the next page load.');
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
