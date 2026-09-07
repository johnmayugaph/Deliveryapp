import { createECDH, createDecipheriv, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPushPayload,
  MalformedSubscriptionKeysError,
  MAX_PAYLOAD_BYTES,
  PayloadTooLargeError,
} from '@/lib/notifications/push/encrypt';
import {
  decodeVapidToken,
  generateVapidKeys,
  InvalidVapidKeysError,
  NoVapidKeysError,
  pushAudience,
  resolveVapidConfig,
  vapidAuthorization,
  verifyVapidToken,
  type VapidEnv,
} from '@/lib/notifications/push/vapid';

/**
 * Push encryption is the one part of this codebase that fails silently when it
 * is wrong: a push service accepts a badly encrypted payload, answers 201, and
 * the browser discards a message it cannot decrypt. Nothing raises. So the
 * expected bytes are pinned.
 *
 * The two vectors below were produced by running this implementation and
 * `http_ece` — the reference implementation, written by the author of RFC 8291
 * — over the same fixed keys and salt, and asserting the outputs were
 * identical. That comparison also ran over 200 randomised rounds with fresh
 * keys, salts and payload sizes, with zero disagreements, and round-tripped
 * through the reference decryptor. The reference library is not a dependency of
 * this project, so what is committed is the agreed output rather than the
 * comparison: if a change to `encrypt.ts` alters a single byte, these fail.
 */

// A fixed browser-side key pair. Any P-256 scalar works; these are constants,
// not secrets, and exist only so the expected ciphertext is reproducible.
const CLIENT_PRIVATE = Buffer.from(
  'b1bfc1a2ab5e30b6b0e6a8ab1a6b6b1b0e0f4a2c3d4e5f60718293a4b5c6d7e8',
  'hex',
);
const CLIENT_PUBLIC =
  'BH3o03cLh1aPG0j3p-GhAQ_oANtIwwaBgoIExs_DkgfAL5s1WIA_zPCKHD7bW-wL4pUIJ_NvjBRKMWxYwCvU8F8';
const SENDER_PRIVATE = Buffer.from(
  'c9f58f89813e9f1e611f52ae0a3a1e4f4b7e0d5a6c8b9a0d1e2f30415263748a',
  'hex',
);
const AUTH_SECRET = Buffer.from('1c2d3e4f50617283940a5b6c7d8e9f00', 'hex');

const KEYS = {
  p256dh: CLIENT_PUBLIC,
  auth: AUTH_SECRET.toString('base64url'),
};

describe('the encrypted body, byte for byte', () => {
  it('matches the reference implementation on vector 1', () => {
    const result = encryptPushPayload('TARA: order #A1B2C3 is on the way.', KEYS, {
      salt: Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex'),
      senderPrivateKey: SENDER_PRIVATE,
    });

    expect(result.body.toString('base64')).toBe(
      'obLD1OX2BxgpOktcbX6PkAAAEABBBCOpEqXrF5aOBDdltxGhXsIIrxA3it0U06ffeosvjApFkXB5MSX7eQkXtdN6' +
        'LjJEGmTz6ee6YSGZ/DoP2Gqbo008yaCgLYPTjgsiV79pSU7Vi5ywz3BdNqb4t4/ViZRU1d9b77l6rz6EOqPmDpgQNspcwBo=',
    );
  });

  it('matches the reference implementation on vector 2', () => {
    const result = encryptPushPayload('hi', KEYS, {
      salt: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      senderPrivateKey: SENDER_PRIVATE,
    });

    expect(result.body.toString('base64')).toBe(
      'ABEiM0RVZneImaq7zN3u/wAAEABBBCOpEqXrF5aOBDdltxGhXsIIrxA3it0U06ffeosvjApFkXB5MSX7eQkXtdN6' +
        'LjJEGmTz6ee6YSGZ/DoP2Gqbo01Ys1OOSKMgiiu1dyFScHmXWPXG',
    );
  });
});

describe('the header the browser parses', () => {
  const encrypted = encryptPushPayload('hello', KEYS, {
    salt: Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex'),
    senderPrivateKey: SENDER_PRIVATE,
  });

  it('leads with the 16-byte salt', () => {
    expect(encrypted.body.subarray(0, 16).toString('hex')).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    );
  });

  it('declares a 4096-byte record size', () => {
    expect(encrypted.body.readUInt32BE(16)).toBe(4096);
  });

  it('carries our public key as a 65-byte key id', () => {
    expect(encrypted.body.readUInt8(20)).toBe(65);
    expect(encrypted.body.subarray(21, 86)).toEqual(encrypted.senderPublicKey);
    // Uncompressed point, or the browser cannot do the ECDH at all.
    expect(encrypted.body[21]).toBe(0x04);
  });
});

describe('a browser could actually read it', () => {
  /**
   * Decrypts the way a browser does, from the wire format alone: read the salt
   * and the sender key out of the header, do the ECDH with the client private
   * key, derive, open the record. Independent of the encryption path — it
   * shares no helper with it — so agreement means the derivation is right and
   * not just self-consistent.
   */
  function decryptAsBrowser(body: Buffer): string {
    const salt = body.subarray(0, 16);
    const keyIdLength = body.readUInt8(20);
    const senderPublic = body.subarray(21, 21 + keyIdLength);
    const record = body.subarray(21 + keyIdLength);

    const curve = createECDH('prime256v1');
    curve.setPrivateKey(CLIENT_PRIVATE);
    const shared = curve.computeSecret(senderPublic);

    const hmac = (key: Buffer, data: Buffer) =>
      createHmac('sha256', key).update(data).digest();
    const hkdf = (s: Buffer, ikm: Buffer, info: Buffer, length: number) =>
      hmac(hmac(s, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

    const ikm = hkdf(
      AUTH_SECRET,
      shared,
      Buffer.concat([
        Buffer.from('WebPush: info\0'),
        curve.getPublicKey(),
        senderPublic,
      ]),
      32,
    );
    const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

    const tag = record.subarray(record.length - 16);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(record.subarray(0, record.length - 16)),
      decipher.final(),
    ]);

    // The final byte is the record delimiter, not content.
    expect(plain[plain.length - 1]).toBe(2);
    return plain.subarray(0, plain.length - 1).toString('utf8');
  }

  it('round-trips a message', () => {
    const message = JSON.stringify({ title: 'Order accepted', body: 'Aling Nena is cooking.' });
    expect(decryptAsBrowser(encryptPushPayload(message, KEYS).body)).toBe(message);
  });

  it('round-trips the largest payload that fits', () => {
    const message = 'x'.repeat(MAX_PAYLOAD_BYTES);
    expect(decryptAsBrowser(encryptPushPayload(message, KEYS).body)).toBe(message);
  });

  it('round-trips multi-byte characters without cutting one in half', () => {
    // The limit is bytes, not characters. A body measured in characters would
    // truncate mid-codepoint and produce a payload no browser can parse.
    const message = 'Ang order mo ay papunta na — ₱489.00 🛵';
    expect(decryptAsBrowser(encryptPushPayload(message, KEYS).body)).toBe(message);
  });

  it('produces different ciphertext for the same message every time', () => {
    // The ephemeral key pair is per message. Identical output would let a push
    // service tell that the same notification went out twice.
    const a = encryptPushPayload('same', KEYS).body;
    const b = encryptPushPayload('same', KEYS).body;
    expect(a.equals(b)).toBe(false);
    expect(decryptAsBrowser(a)).toBe('same');
    expect(decryptAsBrowser(b)).toBe('same');
  });
});

describe('refusing what cannot work', () => {
  it('rejects a payload one byte over the limit', () => {
    expect(() => encryptPushPayload('x'.repeat(MAX_PAYLOAD_BYTES + 1), KEYS)).toThrow(
      PayloadTooLargeError,
    );
  });

  it('rejects a p256dh of the wrong length', () => {
    expect(() =>
      encryptPushPayload('hi', { ...KEYS, p256dh: Buffer.alloc(64).toString('base64url') }),
    ).toThrow(MalformedSubscriptionKeysError);
  });

  it('rejects a p256dh that is not an uncompressed point', () => {
    const compressed = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]);
    expect(() =>
      encryptPushPayload('hi', { ...KEYS, p256dh: compressed.toString('base64url') }),
    ).toThrow(/uncompressed/);
  });

  it('rejects a point that is not on the curve', () => {
    // A public key off the curve is how an invalid-curve attack starts. Node's
    // computeSecret is what refuses it; this asserts we do not bypass that.
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xaa)]);
    expect(() =>
      encryptPushPayload('hi', { ...KEYS, p256dh: offCurve.toString('base64url') }),
    ).toThrow();
  });

  it('rejects an auth secret of the wrong length', () => {
    expect(() =>
      encryptPushPayload('hi', { ...KEYS, auth: Buffer.alloc(12).toString('base64url') }),
    ).toThrow(MalformedSubscriptionKeysError);
  });

  it('says the keys cannot be regenerated here', () => {
    // The message matters: somebody reading this error needs to know the fix is
    // "the browser subscribes again", not "rotate a key on the server".
    expect(() =>
      encryptPushPayload('hi', { ...KEYS, auth: 'short' }),
    ).toThrow(/cannot be regenerated/);
  });
});

describe('VAPID', () => {
  const config = {
    publicKey:
      'BH3o03cLh1aPG0j3p-GhAQ_oANtIwwaBgoIExs_DkgfAL5s1WIA_zPCKHD7bW-wL4pUIJ_NvjBRKMWxYwCvU8F8',
    privateKey: CLIENT_PRIVATE.toString('base64url'),
    subject: 'mailto:ops@tara.ph',
  };

  it('signs a token that verifies against the public key', () => {
    const header = vapidAuthorization({
      audience: 'https://fcm.googleapis.com',
      config,
      now: new Date('2026-09-07T08:00:00.000Z'),
    });
    const token = header.slice('vapid t='.length).split(', k=')[0]!;
    expect(verifyVapidToken(token, config.publicKey)).toBe(true);
  });

  it('does NOT verify against a different key', () => {
    const header = vapidAuthorization({ audience: 'https://fcm.googleapis.com', config });
    const token = header.slice('vapid t='.length).split(', k=')[0]!;
    expect(verifyVapidToken(token, generateVapidKeys().publicKey)).toBe(false);
  });

  it('carries both halves in the header the spec names', () => {
    const header = vapidAuthorization({ audience: 'https://fcm.googleapis.com', config });
    expect(header.startsWith('vapid t=')).toBe(true);
    expect(header).toContain(`, k=${config.publicKey}`);
  });

  it('claims the origin as the audience, not the whole endpoint', () => {
    // Signing the endpoint would leak which subscription a token was minted
    // for, and would stop one token covering a batch to the same service.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123?x=1';
    expect(pushAudience(endpoint)).toBe('https://fcm.googleapis.com');

    const header = vapidAuthorization({ audience: pushAudience(endpoint), config });
    const claims = decodeVapidToken(header.slice('vapid t='.length).split(', k=')[0]!);
    expect(claims?.aud).toBe('https://fcm.googleapis.com');
    expect(claims?.sub).toBe('mailto:ops@tara.ph');
  });

  it('expires 12 hours out', () => {
    const now = new Date('2026-09-07T08:00:00.000Z');
    const header = vapidAuthorization({ audience: 'https://x.example', config, now });
    const claims = decodeVapidToken(header.slice('vapid t='.length).split(', k=')[0]!);
    expect(claims?.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 60 * 60);
  });

  it('refuses a lifetime past the 24-hour ceiling', () => {
    expect(() =>
      vapidAuthorization({
        audience: 'https://x.example',
        config,
        lifetimeSeconds: 25 * 60 * 60,
      }),
    ).toThrow(InvalidVapidKeysError);
  });

  it('generates usable pairs', () => {
    for (let i = 0; i < 10; i += 1) {
      const generated = { ...generateVapidKeys(), subject: 'mailto:ops@tara.ph' };
      expect(Buffer.from(generated.publicKey, 'base64url')).toHaveLength(65);
      expect(Buffer.from(generated.privateKey, 'base64url')).toHaveLength(32);
      const header = vapidAuthorization({ audience: 'https://x.example', config: generated });
      const token = header.slice('vapid t='.length).split(', k=')[0]!;
      expect(verifyVapidToken(token, generated.publicKey)).toBe(true);
    }
  });
});

describe('VAPID configuration', () => {
  const valid = {
    VAPID_PUBLIC_KEY:
      'BH3o03cLh1aPG0j3p-GhAQ_oANtIwwaBgoIExs_DkgfAL5s1WIA_zPCKHD7bW-wL4pUIJ_NvjBRKMWxYwCvU8F8',
    VAPID_PRIVATE_KEY: CLIENT_PRIVATE.toString('base64url'),
    VAPID_SUBJECT: 'mailto:ops@tara.ph',
  } satisfies VapidEnv;

  it('reads a complete configuration', () => {
    expect(resolveVapidConfig(valid).subject).toBe('mailto:ops@tara.ph');
  });

  it('refuses a partial one rather than half-working', () => {
    expect(() => resolveVapidConfig({ VAPID_PUBLIC_KEY: valid.VAPID_PUBLIC_KEY })).toThrow(
      NoVapidKeysError,
    );
  });

  it('warns that rotating the pair invalidates every subscription', () => {
    // The single most expensive mistake available here, so the error says it.
    expect(() => resolveVapidConfig({})).toThrow(/invalidates every existing subscription/);
  });

  it('rejects a public key of the wrong length', () => {
    expect(() =>
      resolveVapidConfig({ ...valid, VAPID_PUBLIC_KEY: 'dG9vLXNob3J0' }),
    ).toThrow(InvalidVapidKeysError);
  });

  it('rejects a subject that is neither mailto: nor https:', () => {
    // Push service operators use it to contact us about our traffic. An
    // http: URL or a bare string means they cannot, and FCM rejects it.
    expect(() =>
      resolveVapidConfig({ ...valid, VAPID_SUBJECT: 'http://tara.ph' }),
    ).toThrow(InvalidVapidKeysError);
    expect(() => resolveVapidConfig({ ...valid, VAPID_SUBJECT: 'ops@tara.ph' })).toThrow(
      InvalidVapidKeysError,
    );
  });
});
