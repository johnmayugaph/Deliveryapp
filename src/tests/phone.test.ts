import { describe, expect, it } from 'vitest';
import {
  formatPhilippineMobile,
  InvalidPhoneNumberError,
  isValidPhilippineMobile,
  maskPhilippineMobile,
  normalisePhilippineMobile,
  tryNormalisePhilippineMobile,
} from '@/lib/auth/phone';

/**
 * `User.phone` is the login identity, so a number that normalises two ways is
 * two accounts for one person — and a number that normalises WRONG sends a
 * login code to a stranger. Hence the paranoia below.
 */

const CANONICAL = '+639171234567';

describe('the same number, written the way people actually write it', () => {
  const equivalents = [
    '+639171234567',
    '639171234567',
    '09171234567',
    '9171234567',
    '0917 123 4567',
    '+63 917 123 4567',
    '0917-123-4567',
    '0917.123.4567',
    '(0917) 1234567',
    '  09171234567  ',
    '+63 (917) 123-4567',
    '63 917 123 4567',
  ];

  it.each(equivalents)('normalises %s', (input) => {
    expect(normalisePhilippineMobile(input)).toBe(CANONICAL);
  });

  it('collapses every form to exactly one identity', () => {
    const results = new Set(equivalents.map(normalisePhilippineMobile));
    expect(results.size).toBe(1);
  });
});

describe('other valid networks normalise too', () => {
  it.each([
    ['09051234567', '+639051234567'],
    ['09991234567', '+639991234567'],
    ['0919 000 0000', '+639190000000'],
  ])('%s -> %s', (input, expected) => {
    expect(normalisePhilippineMobile(input)).toBe(expected);
  });
});

describe('rejections', () => {
  const rejected: [string, string][] = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['abc', 'letters'],
    ['0917 123 456a', 'a letter hiding at the end'],
    ['0281234567', 'Metro Manila landline — cannot receive a gateway SMS'],
    ['0321234567', 'Cebu landline'],
    ['091712345', 'too short'],
    ['091712345678', 'too long'],
    ['+14155551234', 'a US number is out of scope, not to be mangled'],
    ['+441632960000', 'a UK number'],
    ['639', 'country code alone'],
    ['0', 'a lone trunk prefix'],
    ['+63', 'country code with nothing after it'],
    ['00639171234567', 'double-zero international prefix, not handled'],
    ['8171234567', 'starts 8, not a mobile'],
  ];

  it.each(rejected)('rejects %s (%s)', (input) => {
    expect(isValidPhilippineMobile(input)).toBe(false);
    expect(tryNormalisePhilippineMobile(input)).toBeNull();
    expect(() => normalisePhilippineMobile(input)).toThrow(InvalidPhoneNumberError);
  });

  it('explains why, so the form can say something useful', () => {
    expect(() => normalisePhilippineMobile('')).toThrow(/no digits/);
    expect(() => normalisePhilippineMobile('0917abc4567')).toThrow(/not digits/);
    expect(() => normalisePhilippineMobile('0281234567')).toThrow(/09xx xxx xxxx/);
  });

  it('never silently strips a letter into a valid number', () => {
    // "0917x1234567" has ten digits after the zero; if the stripper were greedy
    // it would become a valid number belonging to somebody else.
    expect(tryNormalisePhilippineMobile('0917x1234567')).toBeNull();
  });
});

describe('normalisation is idempotent', () => {
  it('re-normalising its own output changes nothing', () => {
    const once = normalisePhilippineMobile('0917 123 4567');
    expect(normalisePhilippineMobile(once)).toBe(once);
    expect(normalisePhilippineMobile(normalisePhilippineMobile(once))).toBe(once);
  });
});

describe('display forms', () => {
  it('shows the local form a Filipino expects to read back', () => {
    expect(formatPhilippineMobile(CANONICAL)).toBe('0917 123 4567');
  });

  it('masks the middle for confirmation screens', () => {
    expect(maskPhilippineMobile(CANONICAL)).toBe('0917 ••• 4567');
  });

  it('keeps the last four digits, which is what people recognise', () => {
    expect(maskPhilippineMobile(CANONICAL)).toContain('4567');
    expect(maskPhilippineMobile(CANONICAL)).not.toContain('123');
  });

  it('passes through anything it cannot parse rather than throwing in a view', () => {
    expect(formatPhilippineMobile('not a number')).toBe('not a number');
    expect(maskPhilippineMobile('not a number')).toBe('not a number');
  });
});
