import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NotificationUrgency } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PushDeliveryError,
  sendPush,
  topicHeader,
  ttlSeconds,
  urgencyHeader,
} from '@/lib/notifications/push/send';
import {
  InvalidPushEndpointError,
  validatePushSubscription,
} from '@/lib/notifications/push/subscriptions';
import { generateVapidKeys, verifyVapidToken } from '@/lib/notifications/push/vapid';

/**
 * The request that reaches a push service, over a real socket.
 *
 * Same approach as the SMS wire test and for the same reason: a stubbed `fetch`
 * proves only that the adapter called the function it was handed. What matters
 * here is the header set — a missing `Content-Encoding` is a 400, a DER
 * signature is a 401, and neither says why.
 *
 * The distinction these tests exist for is GONE versus FAILED. Getting it
 * backwards means either retrying a browser that was uninstalled last month or
 * throwing away a live subscription over one 500.
 */

const CLIENT_PUBLIC =
  'BH3o03cLh1aPG0j3p-GhAQ_oANtIwwaBgoIExs_DkgfAL5s1WIA_zPCKHD7bW-wL4pUIJ_NvjBRKMWxYwCvU8F8';
const CLIENT_AUTH = Buffer.from('1c2d3e4f50617283940a5b6c7d8e9f00', 'hex').toString(
  'base64url',
);

const config = { ...generateVapidKeys(), subject: 'mailto:ops@tara.ph' };

const PAYLOAD = {
  title: 'Order accepted',
  body: 'Aling Nena is cooking your order.',
  href: '/orders/A1B2C3',
};

interface Capture {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function pushService(
  reply: (res: ServerResponse) => void,
): Promise<{ endpoint: string; captured: () => Capture | undefined }> {
  let capture: Capture | undefined;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      capture = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      reply(res);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP');

  return {
    endpoint: `http://127.0.0.1:${address.port}/push/abc123`,
    captured: () => capture,
  };
}

function subscription(endpoint: string) {
  return { endpoint, p256dh: CLIENT_PUBLIC, auth: CLIENT_AUTH };
}

describe('the request a push service receives', () => {
  it('POSTs the encrypted body with the headers RFC 8030 requires', async () => {
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    const outcome = await sendPush({
      subscription: subscription(endpoint),
      payload: PAYLOAD,
      urgency: NotificationUrgency.OPERATIONAL,
      config,
    });

    expect(outcome).toEqual({ kind: 'SENT', status: 201 });

    const request = captured();
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/push/abc123');
    // Without this header the service has no idea the body is encrypted and
    // answers 400.
    expect(request?.headers['content-encoding']).toBe('aes128gcm');
    expect(request?.headers['content-type']).toBe('application/octet-stream');
    expect(request?.headers.ttl).toBe(String(4 * 60 * 60));
    expect(request?.headers.urgency).toBe('high');
  });

  it('signs with a VAPID token the service could verify', async () => {
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    await sendPush({
      subscription: subscription(endpoint),
      payload: PAYLOAD,
      urgency: NotificationUrgency.INFORMATIONAL,
      config,
    });

    const authorization = String(captured()?.headers.authorization ?? '');
    expect(authorization.startsWith('vapid t=')).toBe(true);
    expect(authorization).toContain(`, k=${config.publicKey}`);

    const token = authorization.slice('vapid t='.length).split(', k=')[0]!;
    expect(verifyVapidToken(token, config.publicKey)).toBe(true);
  });

  it('sends a body that is a header plus one sealed record', async () => {
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    await sendPush({
      subscription: subscription(endpoint),
      payload: PAYLOAD,
      urgency: NotificationUrgency.INFORMATIONAL,
      config,
    });

    const body = captured()!.body;
    // 86-byte header, then the record. The plaintext is JSON, so the body must
    // be longer than it and must not contain it.
    expect(body.length).toBeGreaterThan(86);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.includes(Buffer.from('Order accepted'))).toBe(false);
  });

  it('collapses messages about one order onto a single Topic', async () => {
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    await sendPush({
      subscription: subscription(endpoint),
      payload: { ...PAYLOAD, tag: 'order_abc123' },
      urgency: NotificationUrgency.INFORMATIONAL,
      config,
    });

    expect(captured()?.headers.topic).toBe(topicHeader('order_abc123'));
    // The header has a 32-character ceiling; over it, services drop it and the
    // collapsing silently stops working.
    expect(String(captured()?.headers.topic).length).toBeLessThanOrEqual(32);
  });

  it('omits Topic when nothing should collapse', async () => {
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    await sendPush({
      subscription: subscription(endpoint),
      payload: PAYLOAD,
      urgency: NotificationUrgency.INFORMATIONAL,
      config,
    });

    expect(captured()?.headers.topic).toBeUndefined();
  });
});

describe('gone versus failed', () => {
  for (const status of [404, 410]) {
    it(`treats ${status} as a dead subscription, not an error`, async () => {
      // Retrying either of these is guaranteed waste: the browser threw the
      // subscription away, and no number of attempts brings it back.
      const { endpoint } = await pushService((res) => {
        res.writeHead(status);
        res.end();
      });

      const outcome = await sendPush({
        subscription: subscription(endpoint),
        payload: PAYLOAD,
        urgency: NotificationUrgency.INFORMATIONAL,
        config,
      });

      expect(outcome).toEqual({ kind: 'GONE', status });
    });
  }

  for (const status of [429, 500, 502, 503]) {
    it(`treats ${status} as retryable`, async () => {
      // The opposite mistake: discarding a live subscription over a momentary
      // outage would silently stop notifications for that person forever.
      const { endpoint } = await pushService((res) => {
        res.writeHead(status);
        res.end('upstream unavailable');
      });

      await expect(
        sendPush({
          subscription: subscription(endpoint),
          payload: PAYLOAD,
          urgency: NotificationUrgency.INFORMATIONAL,
          config,
        }),
      ).rejects.toThrow(PushDeliveryError);
    });
  }

  it('keeps the status and the reason on a failure', async () => {
    const { endpoint } = await pushService((res) => {
      res.writeHead(400);
      res.end('missing content-encoding');
    });

    await expect(
      sendPush({
        subscription: subscription(endpoint),
        payload: PAYLOAD,
        urgency: NotificationUrgency.INFORMATIONAL,
        config,
      }),
    ).rejects.toThrow(/HTTP 400.*missing content-encoding/s);
  });

  it('reports a refused connection as a delivery failure', async () => {
    await expect(
      sendPush({
        subscription: subscription('http://127.0.0.1:1/push/x'),
        payload: PAYLOAD,
        urgency: NotificationUrgency.INFORMATIONAL,
        config,
      }),
    ).rejects.toThrow(PushDeliveryError);
  });

  it('does not send at all when the keys cannot work', async () => {
    // Thrown before any request, so a malformed subscription costs nothing and
    // cannot be mistaken for a push service problem.
    const { endpoint, captured } = await pushService((res) => {
      res.writeHead(201);
      res.end();
    });

    await expect(
      sendPush({
        subscription: { endpoint, p256dh: 'too-short', auth: CLIENT_AUTH },
        payload: PAYLOAD,
        urgency: NotificationUrgency.INFORMATIONAL,
        config,
      }),
    ).rejects.toThrow();

    expect(captured()).toBeUndefined();
  });
});

describe('urgency and lifetime', () => {
  it('asks for a wake-up only when somebody is waiting', () => {
    // Marking everything high gets a sender deprioritised by the services that
    // honour the header, which costs the messages that actually matter.
    expect(urgencyHeader(NotificationUrgency.OPERATIONAL)).toBe('high');
    expect(urgencyHeader(NotificationUrgency.INFORMATIONAL)).toBe('normal');
  });

  it('gives an operational message a short life', () => {
    // A dispatch offer that surfaces tomorrow is worse than useless: the
    // partner taps a job that was reassigned last night.
    expect(ttlSeconds(NotificationUrgency.OPERATIONAL)).toBe(4 * 60 * 60);
    expect(ttlSeconds(NotificationUrgency.INFORMATIONAL)).toBe(24 * 60 * 60);
  });
});

describe('what a browser is allowed to register', () => {
  const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: CLIENT_PUBLIC, auth: CLIENT_AUTH };

  it('accepts a real subscription', () => {
    expect(() => validatePushSubscription(valid)).not.toThrow();
  });

  it('REFUSES a non-https endpoint', () => {
    // Otherwise this app is a relay that will POST signed, encrypted bodies at
    // any host a caller names.
    expect(() =>
      validatePushSubscription({ ...valid, endpoint: 'http://attacker.example/collect' }),
    ).toThrow(InvalidPushEndpointError);
  });

  it('refuses something that is not a URL', () => {
    expect(() => validatePushSubscription({ ...valid, endpoint: 'not a url' })).toThrow(
      InvalidPushEndpointError,
    );
  });

  it('refuses an implausibly long endpoint', () => {
    expect(() =>
      validatePushSubscription({
        ...valid,
        endpoint: `https://fcm.googleapis.com/${'x'.repeat(2000)}`,
      }),
    ).toThrow(InvalidPushEndpointError);
  });

  it('refuses keys of the wrong length', () => {
    expect(() => validatePushSubscription({ ...valid, p256dh: 'abc' })).toThrow();
    expect(() => validatePushSubscription({ ...valid, auth: 'abc' })).toThrow();
  });
});
