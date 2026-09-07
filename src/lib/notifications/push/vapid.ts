import { createECDH, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Voluntary Application Server Identification — RFC 8292.
 *
 * The push services do not know who we are and will not let an anonymous
 * caller send to a subscription. VAPID is how we sign each request: a short
 * ES256 JWT naming the push service as its audience, plus our public key, so
 * the service can confirm the two match and rate-limit us by identity rather
 * than by IP.
 *
 * The key pair is ours and long-lived. It is not the payload encryption key —
 * that one is ephemeral, per message, and lives in `encrypt.ts`. Rotating the
 * VAPID key invalidates every existing subscription, because the browser bound
 * its subscription to the public key it was given, so a rotation means every
 * device has to subscribe again. Generate once, keep it, back it up.
 */

const P256_PRIVATE_KEY_LENGTH = 32;
const P256_PUBLIC_KEY_LENGTH = 65;

/** 12 hours. The spec's ceiling is 24, and being near it invites clock skew. */
export const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;
const MAX_JWT_LIFETIME_SECONDS = 24 * 60 * 60;

export class InvalidVapidKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVapidKeysError';
  }
}

export class NoVapidKeysError extends Error {
  constructor() {
    super(
      'Web push is not configured. Generate a key pair with `npm run push:keys` ' +
        'and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT. Keep the ' +
        'pair: rotating it invalidates every existing subscription, because each ' +
        'browser bound its subscription to the public key it was handed.',
    );
    this.name = 'NoVapidKeysError';
  }
}

export interface VapidConfig {
  /** Base64url, 65 bytes. Also handed to the browser at subscribe time. */
  publicKey: string;
  /** Base64url, 32 bytes. */
  privateKey: string;
  /**
   * A `mailto:` address or an `https:` URL a push service operator can use to
   * reach us about our traffic. Not decorative: it is the only contact path
   * when Google or Mozilla decides our sending pattern looks like abuse.
   */
  subject: string;
}

/** Just the variables VAPID reads. */
export interface VapidEnv {
  VAPID_PUBLIC_KEY?: string | undefined;
  VAPID_PRIVATE_KEY?: string | undefined;
  VAPID_SUBJECT?: string | undefined;
  [key: string]: string | undefined;
}

/** Makes a fresh key pair. Used by `npm run push:keys`, once, ever. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const curve = createECDH('prime256v1');
  curve.generateKeys();

  // Node occasionally returns a private key shorter than 32 bytes when the
  // leading byte is zero. Left-pad it, or the JWK below is rejected.
  let privateKey = curve.getPrivateKey();
  if (privateKey.length < P256_PRIVATE_KEY_LENGTH) {
    privateKey = Buffer.concat([
      Buffer.alloc(P256_PRIVATE_KEY_LENGTH - privateKey.length),
      privateKey,
    ]);
  }

  return {
    publicKey: curve.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

export function validateVapidSubject(subject: string): void {
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    throw new InvalidVapidKeysError(
      `VAPID_SUBJECT must be a mailto: address or an https: URL, not ${subject}.`,
    );
  }
  if (url.protocol !== 'mailto:' && url.protocol !== 'https:') {
    throw new InvalidVapidKeysError(
      `VAPID_SUBJECT must be mailto: or https:, not ${url.protocol}`,
    );
  }
}

/**
 * Reads the key pair from the environment, or explains what is missing.
 *
 * Deliberately shaped like `resolveSmsSender`: absent configuration is an
 * error rather than a silent no-op, so a deployment that forgot the keys finds
 * out at the first send instead of after a week of notifications nobody got.
 */
export function resolveVapidConfig(env: VapidEnv = process.env): VapidConfig {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    throw new NoVapidKeysError();
  }

  if (Buffer.from(publicKey, 'base64url').length !== P256_PUBLIC_KEY_LENGTH) {
    throw new InvalidVapidKeysError(
      `VAPID_PUBLIC_KEY must decode to ${P256_PUBLIC_KEY_LENGTH} bytes.`,
    );
  }
  if (Buffer.from(privateKey, 'base64url').length !== P256_PRIVATE_KEY_LENGTH) {
    throw new InvalidVapidKeysError(
      `VAPID_PRIVATE_KEY must decode to ${P256_PRIVATE_KEY_LENGTH} bytes.`,
    );
  }
  validateVapidSubject(subject);

  return { publicKey, privateKey, subject };
}

export function isPushConfigured(env: VapidEnv = process.env): boolean {
  try {
    resolveVapidConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns the raw key pair into a signing key.
 *
 * Via JWK rather than by hand-assembling DER: the coordinates are already
 * sitting in the uncompressed public key, so `x` and `y` are two slices and
 * Node does the rest. The alternative is an ASN.1 encoder, which is a
 * dependency and a second thing to get wrong.
 */
function signingKey(config: VapidConfig) {
  const publicKey = Buffer.from(config.publicKey, 'base64url');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: config.privateKey,
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * The audience is the push service's ORIGIN, not the full endpoint.
 *
 * Signing the whole endpoint would leak which subscription a token was for and
 * would stop one token being reused across a batch to the same service — which
 * is the entire reason a 12-hour token is worth minting at all.
 */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

export interface VapidHeaderInput {
  /** The push service origin, from `pushAudience`. */
  audience: string;
  config: VapidConfig;
  /** Injected in tests so a token's bytes are reproducible. */
  now?: Date;
  lifetimeSeconds?: number;
}

/**
 * Builds the `Authorization` header value for one push service.
 *
 * The header carries both halves: `t=` the signed token, `k=` our public key.
 * The service verifies the signature against `k`, then checks that `k` matches
 * the key the browser recorded when it subscribed. A mismatch is a 403.
 */
export function vapidAuthorization(input: VapidHeaderInput): string {
  const lifetime = input.lifetimeSeconds ?? VAPID_JWT_LIFETIME_SECONDS;
  if (lifetime <= 0 || lifetime > MAX_JWT_LIFETIME_SECONDS) {
    throw new InvalidVapidKeysError(
      `A VAPID token may live at most ${MAX_JWT_LIFETIME_SECONDS} seconds.`,
    );
  }

  const now = input.now ?? new Date();
  const signingInput =
    `${base64UrlJson({ typ: 'JWT', alg: 'ES256' })}.` +
    `${base64UrlJson({
      aud: input.audience,
      exp: Math.floor(now.getTime() / 1000) + lifetime,
      sub: input.config.subject,
    })}`;

  // ieee-p1363 is the raw r||s pair JWS requires. Node's default for EC keys is
  // DER, which a push service reads as a malformed signature and rejects with
  // a 401 that says nothing about why.
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: signingKey(input.config),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${input.config.publicKey}`;
}

/**
 * Verifies a token against a public key. Used by the tests and by the
 * self-check in `npm run push:keys`, so a bad pair is caught here rather than
 * as an opaque 401 from a push service.
 */
export function verifyVapidToken(token: string, publicKeyBase64Url: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];

  const raw = Buffer.from(publicKeyBase64Url, 'base64url');
  if (raw.length !== P256_PUBLIC_KEY_LENGTH) return false;

  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });

  return verify(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
}

/** Reads a token's claims back. For the self-check and for tests. */
export function decodeVapidToken(
  token: string,
): { aud: string; exp: number; sub: string } | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
