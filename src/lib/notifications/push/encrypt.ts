import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/**
 * Message Encryption for Web Push — RFC 8291, in the aes128gcm content coding
 * of RFC 8188.
 *
 * Written out rather than pulled in as a dependency, because the whole thing is
 * about a hundred lines of well-specified key derivation and one AES-GCM call,
 * and because a push payload that is encrypted wrongly fails in the worst
 * possible way: the push service accepts it, returns 201, and the browser
 * silently discards a message it cannot decrypt. There is no error to catch.
 * Code that can fail that way should be readable.
 *
 * The output is verified byte-for-byte against the reference implementation
 * (`http_ece`, by the author of the RFC) in `src/tests/push-crypto.test.ts`,
 * using fixed keys and a fixed salt so the expected bytes are pinned.
 *
 * The shape of the thing:
 *
 *   ECDH(our ephemeral key, the browser's key)  ->  shared secret
 *   HKDF(salt = the browser's auth secret, ...) ->  IKM
 *   HKDF(salt = a random 16 bytes, IKM, ...)    ->  AES key and nonce
 *   body = salt | record size | our public key | AES-128-GCM(payload | 0x02)
 *
 * The browser's `auth` secret is what makes this end-to-end: it never reaches
 * the push service, so the service routes ciphertext it cannot read.
 */

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
/** AES-128. */
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const SALT_LENGTH = 16;
/** An uncompressed P-256 point: 0x04 followed by two 32-byte coordinates. */
const PUBLIC_KEY_LENGTH = 65;
const AUTH_SECRET_LENGTH = 16;

/** salt(16) | record size(4) | key id length(1) | our public key(65). */
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH;

/**
 * The largest payload that fits.
 *
 * Push services cap a request body at 4096 bytes, and the body is the header,
 * the payload, a one-byte record delimiter and the GCM tag. RFC 8188 allows
 * splitting across records; this implementation deliberately does not, because
 * a push notification is a title and a line of text and nothing that needs
 * multiple records is a notification.
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_LENGTH - 1 - TAG_LENGTH;

export class PayloadTooLargeError extends Error {
  constructor(size: number) {
    super(
      `A push payload of ${size} bytes does not fit: the limit is ${MAX_PAYLOAD_BYTES}. ` +
        'Shorten the body — a notification is a headline, and the app has the detail.',
    );
    this.name = 'PayloadTooLargeError';
  }
}

export class MalformedSubscriptionKeysError extends Error {
  constructor(message: string) {
    super(
      `${message} These keys come from the browser and cannot be regenerated ` +
        'here; the subscription has to be replaced.',
    );
    this.name = 'MalformedSubscriptionKeysError';
  }
}

/** The browser's half of the exchange, as `PushSubscription.toJSON().keys`. */
export interface SubscriptionKeys {
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface EncryptedPush {
  /** The complete request body. */
  body: Buffer;
  /** Exposed for the tests that pin the derivation; not needed to send. */
  salt: Buffer;
  senderPublicKey: Buffer;
}

/** Overrides for tests, so a run is reproducible. Never set in production. */
export interface EncryptionOverrides {
  salt?: Buffer;
  /** Our ephemeral private key, 32 bytes. Random when absent, as it must be. */
  senderPrivateKey?: Buffer;
}

function hmacSha256(key: Buffer, input: Buffer): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

/**
 * HKDF-SHA256, extract-and-expand, for outputs of at most 32 bytes.
 *
 * Every derivation here asks for 32, 16 or 12 bytes, so the expand step is a
 * single HMAC block. Refusing anything larger keeps the loop out of the file
 * rather than leaving an untested branch in it.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) {
    throw new Error('hkdf here is single-block; nothing needs more than 32 bytes');
  }
  const prk = hmacSha256(salt, ikm);
  const block = hmacSha256(prk, Buffer.concat([info, Buffer.from([1])]));
  return block.subarray(0, length);
}

function decodeKey(value: string, expected: number, name: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expected) {
    throw new MalformedSubscriptionKeysError(
      `The ${name} decodes to ${decoded.length} bytes; it must be ${expected}.`,
    );
  }
  return decoded;
}

/**
 * Encrypts one push payload for one subscription.
 *
 * A fresh ephemeral key pair per message, which is the point: the shared secret
 * differs every time, so the same plaintext to the same browser produces
 * unrelated ciphertext and the push service learns nothing from repetition.
 */
export function encryptPushPayload(
  plaintext: Buffer | string,
  keys: SubscriptionKeys,
  overrides: EncryptionOverrides = {},
): EncryptedPush {
  const payload = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(payload.length);
  }

  const clientPublicKey = decodeKey(keys.p256dh, PUBLIC_KEY_LENGTH, 'p256dh key');
  if (clientPublicKey[0] !== 0x04) {
    throw new MalformedSubscriptionKeysError(
      'The p256dh key is not an uncompressed P-256 point (it does not start with 0x04).',
    );
  }
  const authSecret = decodeKey(keys.auth, AUTH_SECRET_LENGTH, 'auth secret');

  const ecdh = createECDH('prime256v1');
  let senderPublicKey: Buffer;
  if (overrides.senderPrivateKey) {
    ecdh.setPrivateKey(overrides.senderPrivateKey);
    senderPublicKey = ecdh.getPublicKey();
  } else {
    senderPublicKey = ecdh.generateKeys();
  }

  // computeSecret rejects a point that is not on the curve, which is the check
  // that stops a malicious `p256dh` from being an invalid-curve attack.
  const sharedSecret = ecdh.computeSecret(clientPublicKey);

  // RFC 8291 §3.4. The two public keys go in receiver-then-sender order, and
  // getting them the wrong way round produces a key the browser will not
  // derive — with no error anywhere, which is why the test pins the bytes.
  const ikm = hkdf(
    authSecret,
    sharedSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), clientPublicKey, senderPublicKey]),
    32,
  );

  const salt = overrides.salt ?? randomBytes(SALT_LENGTH);
  if (salt.length !== SALT_LENGTH) {
    throw new Error(`the salt must be ${SALT_LENGTH} bytes`);
  }

  const contentEncryptionKey = hkdf(
    salt,
    ikm,
    Buffer.from('Content-Encoding: aes128gcm\0'),
    KEY_LENGTH,
  );
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), NONCE_LENGTH);

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  const sealed = Buffer.concat([
    cipher.update(payload),
    // 0x02 marks the last record. 0x01 would mean "another record follows",
    // and a browser that read 0x01 here would wait for one that never comes.
    cipher.update(Buffer.from([2])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(HEADER_LENGTH);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_LENGTH);
  header.writeUInt8(PUBLIC_KEY_LENGTH, SALT_LENGTH + 4);
  senderPublicKey.copy(header, SALT_LENGTH + 5);

  return { body: Buffer.concat([header, sealed]), salt, senderPublicKey };
}
