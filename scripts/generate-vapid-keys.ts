#!/usr/bin/env tsx
/**
 * Generates the VAPID key pair web push needs.
 *
 *     npm run push:keys
 *
 * Run this ONCE per deployment and keep the result. The public key is handed to
 * every browser at subscribe time and the browser binds its subscription to it,
 * so replacing the pair does not rotate a credential — it invalidates every
 * subscription in the database and every device has to grant permission again.
 * There is no migration path, because the old private key is the only thing
 * that could sign for the old public key.
 *
 * So: generate, paste into .env, back it up somewhere that is not this laptop.
 *
 * The pair is self-checked before it is printed — a token is signed and
 * verified — because a key pair that does not round-trip fails later as an
 * opaque 401 from a push service, which is a bad afternoon.
 */
import {
  generateVapidKeys,
  isPushConfigured,
  vapidAuthorization,
  verifyVapidToken,
} from '../src/lib/notifications/push/vapid';

function main() {
  if (isPushConfigured()) {
    console.log('');
    console.log('  Web push is ALREADY configured in this environment.');
    console.log('');
    console.log(
      '  Generating a new pair would invalidate every existing subscription:\n' +
        '  each browser bound its subscription to the public key it was given,\n' +
        '  and none of them would accept a new one without subscribing again.\n' +
        '\n' +
        '  If you are sure, clear VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY first.',
    );
    console.log('');
    process.exit(1);
  }

  const keys = generateVapidKeys();

  // Prove the pair works before anybody puts it in a deployment.
  const header = vapidAuthorization({
    audience: 'https://fcm.googleapis.com',
    config: { ...keys, subject: 'mailto:ops@example.test' },
  });
  const token = header.slice('vapid t='.length).split(', k=')[0];
  if (token === undefined || !verifyVapidToken(token, keys.publicKey)) {
    console.error('The generated pair failed its own signature check. Run again.');
    process.exit(1);
  }

  console.log('');
  console.log('  A key pair that signs and verifies. Add these to .env:');
  console.log('');
  console.log(`VAPID_PUBLIC_KEY="${keys.publicKey}"`);
  console.log(`VAPID_PRIVATE_KEY="${keys.privateKey}"`);
  console.log('VAPID_SUBJECT="mailto:ops@your-domain.ph"');
  console.log('');
  console.log(
    '  VAPID_SUBJECT must be a mailto: address or an https: URL that a push\n' +
      '  service operator can use to reach you about your traffic. It is the\n' +
      '  only contact path when Google or Mozilla decides your sending pattern\n' +
      '  looks like abuse, so make it one somebody reads.',
  );
  console.log('');
  console.log('  Keep the private key. Losing it means every device re-subscribes.');
  console.log('');
}

main();
