import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SemaphoreSmsSender, SmsDeliveryError } from '@/lib/auth/sms';

/**
 * Wire-level tests for the SMS adapter.
 *
 * Distinct from `sms-sender.test.ts`, which substitutes a fake `fetch` and so
 * only proves the adapter calls the function it was handed. These run a real
 * HTTP server on a loopback socket and assert the bytes a gateway would
 * actually receive: the method, the content type, the form field names, and the
 * exact encoding of a `+`-prefixed E.164 number.
 *
 * What this cannot establish is how Semaphore itself behaves — whether it
 * accepts the sender name, what it charges, whether the handset rings. Only a
 * real send answers that, and this environment's network policy blocks every
 * SMS gateway (403 on CONNECT), so it is not answerable from here. See
 * `scripts/send-one-sms.ts`, which is the command for doing it from somewhere
 * with egress and an account.
 */

interface Capture {
  method: string;
  url: string;
  contentType: string | undefined;
  /** Raw request body, before any parsing. */
  raw: string;
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Starts a loopback server that records one request and answers with `reply`. */
async function gateway(
  reply: (res: ServerResponse) => void,
): Promise<{ endpoint: string; captured: () => Capture | undefined }> {
  let capture: Capture | undefined;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      capture = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      reply(res);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/api/v4/messages`,
    captured: () => capture,
  };
}

function json(status: number, payload: unknown) {
  return (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

/** One queued message, in the shape Semaphore's v4 API documents. */
const QUEUED = [
  {
    message_id: 123456789,
    user_id: 42,
    user: 'ops@tara.ph',
    account_id: 7,
    account: 'TARA',
    recipient: '639171234567',
    message: 'Your TARA code is 481920.',
    sender_name: 'TARA',
    network: 'Globe',
    status: 'Queued',
    type: 'Single',
    source: 'Api',
    created_at: '2026-09-07 15:04:05',
    updated_at: '2026-09-07 15:04:05',
  },
];

describe('the request that reaches the gateway', () => {
  it('POSTs form-encoded fields over a real socket', async () => {
    const { endpoint, captured } = await gateway(json(200, QUEUED));
    const sender = new SemaphoreSmsSender('key-abc', 'TARA', endpoint);

    await sender.send({ to: '+639171234567', body: 'Your TARA code is 481920.' });

    const request = captured();
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/v4/messages');
    expect(request?.contentType).toContain('application/x-www-form-urlencoded');

    // Field names are the gateway's contract. A rename here is a silent
    // failure that only a real send would catch, which is why they are
    // asserted literally rather than through a parsed object.
    const fields = new URLSearchParams(request?.raw ?? '');
    expect([...fields.keys()].sort()).toEqual([
      'apikey',
      'message',
      'number',
      'sendername',
    ]);
    expect(fields.get('apikey')).toBe('key-abc');
    expect(fields.get('number')).toBe('+639171234567');
    expect(fields.get('message')).toBe('Your TARA code is 481920.');
    expect(fields.get('sendername')).toBe('TARA');
  });

  it('percent-encodes the leading + rather than sending it raw', async () => {
    // A bare `+` in a form body decodes to a space. Getting this wrong sends
    // to " 639171234567" and the gateway either rejects it or bills for a
    // message to nowhere.
    const { endpoint, captured } = await gateway(json(200, QUEUED));
    await new SemaphoreSmsSender('k', undefined, endpoint).send({
      to: '+639171234567',
      body: 'hi',
    });

    expect(captured()?.raw).toContain('number=%2B639171234567');
    expect(captured()?.raw).not.toContain('number=+639171234567');
  });

  it('omits sendername entirely when none is configured', async () => {
    // Semaphore falls back to the account default. Sending an empty string
    // would be a request to use a sender name of "", which is not the same.
    const { endpoint, captured } = await gateway(json(200, QUEUED));
    await new SemaphoreSmsSender('k', undefined, endpoint).send({
      to: '+639171234567',
      body: 'hi',
    });

    expect([...new URLSearchParams(captured()?.raw ?? '').keys()]).not.toContain(
      'sendername',
    );
  });

  it('keeps a multi-line body intact through form encoding', async () => {
    const { endpoint, captured } = await gateway(json(200, QUEUED));
    const body = 'TARA: order #A1 accepted.\nRider on the way.';

    await new SemaphoreSmsSender('k', 'TARA', endpoint).send({
      to: '+639171234567',
      body,
    });

    expect(new URLSearchParams(captured()?.raw ?? '').get('message')).toBe(body);
  });
});

describe('what comes back', () => {
  it('reads the message id out of the queued array', async () => {
    const { endpoint } = await gateway(json(200, QUEUED));
    const result = await new SemaphoreSmsSender('k', 'TARA', endpoint).send({
      to: '+639171234567',
      body: 'hi',
    });

    expect(result).toEqual({ providerMessageId: '123456789', provider: 'semaphore' });
  });

  it('accepts a bare object instead of an array', async () => {
    const { endpoint } = await gateway(json(200, QUEUED[0]));
    const result = await new SemaphoreSmsSender('k', 'TARA', endpoint).send({
      to: '+639171234567',
      body: 'hi',
    });

    expect(result.providerMessageId).toBe('123456789');
  });

  it('treats accepted-but-unparseable as accepted', async () => {
    // A 200 means the gateway took it. Throwing here would fail a login over
    // a response body we could not read, after the message was already sent.
    const { endpoint } = await gateway((res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>OK</html>');
    });

    const result = await new SemaphoreSmsSender('k', 'TARA', endpoint).send({
      to: '+639171234567',
      body: 'hi',
    });

    expect(result).toEqual({ providerMessageId: null, provider: 'semaphore' });
  });

  it('surfaces the status and the reason on a rejection', async () => {
    const { endpoint } = await gateway(
      json(422, { sendername: ['The selected sendername is invalid.'] }),
    );

    await expect(
      new SemaphoreSmsSender('k', 'NOPE', endpoint).send({
        to: '+639171234567',
        body: 'hi',
      }),
    ).rejects.toThrow(/HTTP 422.*sendername is invalid/s);
  });

  it('reports a refused connection as a delivery failure', async () => {
    // Port 1 on loopback: nothing listens, so this is a real ECONNREFUSED
    // rather than a rejected promise from a fake.
    await expect(
      new SemaphoreSmsSender('k', 'TARA', 'http://127.0.0.1:1/api/v4/messages').send({
        to: '+639171234567',
        body: 'hi',
      }),
    ).rejects.toThrow(SmsDeliveryError);
  });

  it('gives up on a gateway that never answers', async () => {
    // The login screen must not hang. The adapter's own AbortSignal.timeout is
    // 10s; this asserts the abort path produces a delivery error, using a
    // server that accepts the connection and then says nothing.
    const { endpoint } = await gateway(() => {
      /* deliberately never responds */
    });

    const sender = new SemaphoreSmsSender('k', 'TARA', endpoint, (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(150) }),
    );

    await expect(sender.send({ to: '+639171234567', body: 'hi' })).rejects.toThrow(
      /request failed or timed out/,
    );
  }, 10_000);
});
