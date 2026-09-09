#!/usr/bin/env tsx
/**
 * Sends exactly one real SMS, to prove the gateway works.
 *
 *     npm run sms:send-one -- 09171234567
 *     npm run sms:send-one -- 09171234567 --message "custom text"
 *     npm run sms:send-one -- 09171234567 --dry-run
 *
 * This exists because the SMS adapter cannot be finished by testing. Everything
 * below the wire is covered by `src/tests/sms-wire.test.ts`, which asserts the
 * exact bytes a gateway receives. What no test can settle is the gateway's own
 * side: whether the API key is live, whether the sender name is registered,
 * what a message costs, and whether a handset in Manila actually rings.
 *
 * So: one command, one message, the full result printed. Run it once against a
 * number you hold, read the output, and the adapter stops being provisional.
 *
 * It refuses to fan out. One recipient per invocation, no list, no loop — a
 * script that can send to many numbers is a script that can spend a prepaid
 * balance by accident.
 */
import {
  formatPhilippineMobile,
  InvalidPhoneNumberError,
  normalisePhilippineMobile,
} from '../src/lib/auth/phone';
import {
  NoSmsSenderError,
  SMS_PROVIDERS,
  SMS_PROVIDER_NAMES,
  describeSmsSetup,
  resolveSmsSender,
  SmsDeliveryError,
} from '../src/lib/auth/sms';
import { ConsoleSmsSender } from '../src/lib/auth/sms';

const DEFAULT_MESSAGE =
  'TARA: this is a one-off delivery test. Nothing is wrong with your account.';

function usage(): never {
  console.error(
    [
      'Usage: npm run sms:send-one -- <philippine-mobile> [options]',
      '',
      'Options:',
      '  --message <text>   What to send. Default is a short delivery test.',
      '  --dry-run          Print what would be sent and exit without sending.',
      '',
      'Examples:',
      '  npm run sms:send-one -- 09171234567',
      '  npm run sms:send-one -- +639171234567 --dry-run',
    ].join('\n'),
  );
  process.exit(2);
}

interface Args {
  to: string;
  message: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let to: string | undefined;
  let message = DEFAULT_MESSAGE;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--message') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error('--message needs a value.');
        usage();
      }
      message = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      usage();
    } else if (to === undefined) {
      to = arg;
    } else {
      // Refusing a second positional is the whole no-fan-out rule.
      console.error(
        'One recipient at a time. This command deliberately cannot send to a list.',
      );
      usage();
    }
  }

  if (to === undefined) usage();
  if (message.trim() === '') {
    console.error('An empty message is not a test of anything.');
    process.exit(2);
  }

  return { to, message, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let to: string;
  try {
    to = normalisePhilippineMobile(args.to);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      console.error(`Not a Philippine mobile number: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  let sender;
  try {
    sender = resolveSmsSender();
  } catch (error) {
    if (error instanceof NoSmsSenderError) {
      console.error(
        [
          'No SMS gateway is configured, so there is nothing to test.',
          '',
          'Set one of these in .env and run again:',
          ...SMS_PROVIDER_NAMES.map((name) => {
            const spec = SMS_PROVIDERS[name];
            return `  ${spec.label}: ${spec.fix}`;
          }),
          '',
          'Without a registered sender name the gateway uses the account',
          'default; an unregistered one is rejected outright.',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }

  const viaConsole = sender instanceof ConsoleSmsSender;

  console.log('');
  console.log(`  to:       ${formatPhilippineMobile(to)}  (${to})`);
  console.log(`  provider: ${sender.name}`);
  /* Printed because a provider's *_ENDPOINT can redirect sends in
     development, and a test that quietly hit a stub would prove nothing.
     Read off whichever adapter was selected — structurally, so a third
     provider with an endpoint needs no change here. */
  const withEndpoint = sender as { endpoint?: unknown };
  if (typeof withEndpoint.endpoint === 'string') {
    console.log(`  endpoint: ${withEndpoint.endpoint}`);
  }
  console.log(`  message:  ${args.message}`);
  console.log(`  length:   ${args.message.length} chars`);
  if (args.message.length > 160) {
    // Gateways bill per 160-character segment; a long body is several messages.
    console.log(
      `            over 160 — this bills as ${Math.ceil(args.message.length / 153)} segments`,
    );
  }
  console.log('');

  if (viaConsole) {
    console.log(
      'The console sender is selected, which means nothing leaves this machine.\n' +
        `That is not a gateway test. Configure a gateway to make it one:\n  ${describeSmsSetup()}\n`,
    );
  }

  if (args.dryRun) {
    console.log('--dry-run: stopping here. Nothing was sent.');
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await sender.send({ to, body: args.message });
    const elapsed = Date.now() - startedAt;
    console.log(`Accepted by ${result.provider} in ${elapsed}ms.`);
    console.log(
      `Provider message id: ${result.providerMessageId ?? '(none returned)'}`,
    );
    console.log('');
    console.log(
      'Accepted means queued, not delivered. Check the handset, and check the\n' +
        "gateway's own dashboard for the final status of that message id.",
    );
  } catch (error) {
    if (error instanceof SmsDeliveryError) {
      console.error(`Rejected by ${error.provider}: ${error.message}`);
      if (error.cause !== undefined) {
        console.error(`Cause: ${String(error.cause)}`);
      }
      console.error(
        [
          '',
          'Common causes, in the order worth checking:',
          '  - sender name not registered on the account (HTTP 422)',
          '  - API key wrong or revoked (HTTP 401)',
          '  - no credit balance on the account',
          '  - outbound HTTPS to api.semaphore.co blocked by a network policy',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
