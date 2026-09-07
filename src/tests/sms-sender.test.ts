import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleSmsSender,
  NoSmsSenderError,
  resolveSmsSender,
  SemaphoreSmsSender,
  SmsDeliveryError,
  type SmsEnv,
} from '@/lib/auth/sms';

describe('sender selection', () => {
  it('uses the console sender in development', () => {
    const sender = resolveSmsSender({ NODE_ENV: 'development' } as SmsEnv);
    expect(sender).toBeInstanceOf(ConsoleSmsSender);
  });

  it('REFUSES the console sender in production', () => {
    // The worst failure mode in this system: a "sender" that writes to a
    // terminal nobody reads would make every login report success while no
    // code ever arrives.
    expect(() => resolveSmsSender({ NODE_ENV: 'production' } as SmsEnv)).toThrow(
      NoSmsSenderError,
    );
  });

  it('explains what to configure', () => {
    expect(() => resolveSmsSender({ NODE_ENV: 'production' } as SmsEnv)).toThrow(
      /SEMAPHORE_API_KEY/,
    );
  });

  it('uses a configured gateway in production', () => {
    const sender = resolveSmsSender({
      NODE_ENV: 'production',
      SEMAPHORE_API_KEY: 'key',
    } as SmsEnv);
    expect(sender).toBeInstanceOf(SemaphoreSmsSender);
  });

  it('prefers a configured gateway over the console, even in development', () => {
    const sender = resolveSmsSender({
      NODE_ENV: 'development',
      SEMAPHORE_API_KEY: 'key',
    } as SmsEnv);
    expect(sender).toBeInstanceOf(SemaphoreSmsSender);
  });
});

describe('the Semaphore adapter', () => {
  const message = { to: '+639171234567', body: '123456 is your code.' };

  /**
   * A stub `fetch` whose parameters are declared, so the recorded calls are
   * typed. `vi.fn(async () => …)` infers an empty argument tuple and makes
   * every `mock.calls[0][1]` a type error.
   */
  function stubFetch(respond: () => Response) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  }

  it('posts the number, message and key as form fields', async () => {
    const fetchImpl = stubFetch(
      () => new Response(JSON.stringify([{ message_id: 42 }]), { status: 200 }),
    );
    const sender = new SemaphoreSmsSender('secret-key', 'DELIVERYAPP', 'https://example.test', fetchImpl as unknown as typeof fetch);

    const result = await sender.send(message);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test');
    const body = new URLSearchParams(String(init!.body));
    expect(body.get('apikey')).toBe('secret-key');
    expect(body.get('number')).toBe('+639171234567');
    expect(body.get('message')).toBe(message.body);
    expect(body.get('sendername')).toBe('DELIVERYAPP');
    expect(result).toEqual({ providerMessageId: '42', provider: 'semaphore' });
  });

  it('omits the sender name when none is registered', async () => {
    const fetchImpl = stubFetch(() => new Response('[]', { status: 200 }));
    const sender = new SemaphoreSmsSender('k', undefined, 'https://example.test', fetchImpl as unknown as typeof fetch);
    await sender.send(message);
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.has('sendername')).toBe(false);
  });

  it('raises a delivery error on a rejected request', async () => {
    const fetchImpl = stubFetch(() => new Response('bad key', { status: 401 }));
    const sender = new SemaphoreSmsSender('k', undefined, 'https://example.test', fetchImpl as unknown as typeof fetch);
    await expect(sender.send(message)).rejects.toThrow(SmsDeliveryError);
    await expect(sender.send(message)).rejects.toThrow(/HTTP 401/);
  });

  it('raises a delivery error when the request itself fails', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('ECONNRESET');
    });
    const sender = new SemaphoreSmsSender('k', undefined, 'https://example.test', fetchImpl as unknown as typeof fetch);
    await expect(sender.send(message)).rejects.toThrow(/timed out|request failed/);
  });

  it('treats an accepted-but-unparseable response as accepted', async () => {
    // The message is queued; failing the login over a response body we could
    // not read would be the wrong call.
    const fetchImpl = stubFetch(() => new Response('not json', { status: 200 }));
    const sender = new SemaphoreSmsSender('k', undefined, 'https://example.test', fetchImpl as unknown as typeof fetch);
    await expect(sender.send(message)).resolves.toEqual({
      providerMessageId: null,
      provider: 'semaphore',
    });
  });

  it('never puts the API key in the URL, where it would land in logs', async () => {
    const fetchImpl = stubFetch(() => new Response('[]', { status: 200 }));
    const sender = new SemaphoreSmsSender('secret-key', undefined, 'https://example.test', fetchImpl as unknown as typeof fetch);
    await sender.send(message);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain('secret-key');
  });
});

describe('the console sender', () => {
  it('reports itself, so a log line names where a code went', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const sender = new ConsoleSmsSender();
    const result = await sender.send({ to: '+639171234567', body: '123456' });
    expect(result.provider).toBe('console');
    expect(info).toHaveBeenCalledOnce();
    info.mockRestore();
  });
});
