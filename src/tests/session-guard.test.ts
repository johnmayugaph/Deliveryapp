import { describe, expect, it } from 'vitest';
import { isPlaceholderSessionAllowed } from '@/lib/auth/session';

/**
 * The placeholder session returns the same seeded user to every visitor. On a
 * public URL that makes every visitor the same person, so it must not be
 * possible to ship it to production by forgetting.
 */
describe('placeholder session fails closed', () => {
  it('answers in development', () => {
    expect(isPlaceholderSessionAllowed({ NODE_ENV: 'development' })).toBe(true);
  });

  it('answers in test', () => {
    expect(isPlaceholderSessionAllowed({ NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses in production', () => {
    expect(isPlaceholderSessionAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('refuses in production even with a truthy-looking override', () => {
    // Only the exact string '1' counts. "true", "yes" and "0" must not open it.
    for (const value of ['true', 'yes', 'on', '0', '', 'false']) {
      expect(
        isPlaceholderSessionAllowed({ NODE_ENV: 'production', ALLOW_INSECURE_DEMO_SESSION: value }),
        `"${value}" should not enable the placeholder`,
      ).toBe(false);
    }
  });

  it('opens only on a deliberate override', () => {
    expect(
      isPlaceholderSessionAllowed({ NODE_ENV: 'production', ALLOW_INSECURE_DEMO_SESSION: '1' }),
    ).toBe(true);
  });
});
