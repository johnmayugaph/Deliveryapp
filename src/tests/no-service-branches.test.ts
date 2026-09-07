import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { isOrderableIn } from '@/lib/services/registry';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ServiceKey } from '@prisma/client';

/**
 * Enforces the architectural rule from docs/architecture.md § Service registry:
 *
 *   Nowhere in the codebase should there be a hardcoded list of services, or an
 *   `if (serviceType === 'FOOD')` branch in shared logic. Read from the
 *   registry.
 *
 * Two files are legitimately exempt, and both are the exceptions the rule
 * itself names:
 *   - prisma/seed.ts            — the seed IS the data; the list lives here.
 *   - src/lib/orders/*.ts       — the per-service config maps. These are keyed
 *                                 by EVERY ServiceKey (so a new vertical is a
 *                                 compile error), which is the sanctioned way
 *                                 to express per-vertical behaviour.
 *
 * A grep-based test is unusual, but the rule is about the shape of the code
 * rather than its behaviour, so a grep is exactly the right instrument.
 */

const SRC_ROOT = path.resolve(__dirname, '..');

/** Files allowed to enumerate service keys, with the reason each is exempt. */
const EXEMPT = new Map<string, string>([
  ['lib/orders/transitions.ts', 'per-service lifecycle config map, keyed by every ServiceKey'],
  ['lib/orders/details.ts', 'per-service details shapes, keyed by every ServiceKey'],
  ['tests/no-service-branches.test.ts', 'this test'],
  ['tests/order-transitions.test.ts', 'asserts the config maps themselves'],
  ['tests/pricing-benefits.test.ts', 'asserts that benefit scoping works per service key'],
]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectSourceFiles(full);
      }
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

const SERVICE_KEYS = Object.values(ServiceKey);

/**
 * Blanks out comments while preserving line numbering, so the docstrings that
 * STATE this rule are not themselves reported as breaking it. Handles block
 * comments spanning lines, which a per-line regex cannot.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

describe('no hardcoded service branches', () => {
  it('never compares a value against a service key literal', async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offences: string[] = [];

    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file);
      if (EXEMPT.has(relative)) continue;

      const source = stripComments(readFileSync(file, 'utf8'));
      source.split('\n').forEach((line, index) => {
        const code = line;
        for (const key of SERVICE_KEYS) {
          const comparison = new RegExp(
            `[=!]==?\\s*(['"\`])${key}\\1|(['"\`])${key}\\2\\s*[=!]==?`,
          );
          if (comparison.test(code)) {
            offences.push(`${relative}:${index + 1}  ${line.trim()}`);
          }
        }
      });
    }

    expect(
      offences,
      `Branch on the Service registry instead:\n${offences.join('\n')}`,
    ).toEqual([]);
  });

  it('never enumerates every service key outside the sanctioned config maps', async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offences: string[] = [];

    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file);
      if (EXEMPT.has(relative)) continue;

      const source = readFileSync(file, 'utf8');
      // A file naming three or more service keys is almost certainly keeping a
      // second copy of the registry.
      const named = SERVICE_KEYS.filter((key) =>
        new RegExp(`ServiceKey\\.${key}\\b|(['"\`])${key}\\1`).test(source),
      );
      if (named.length >= 3) {
        offences.push(`${relative} names ${named.length} service keys: ${named.join(', ')}`);
      }
    }

    expect(
      offences,
      `Read the list from getAllServices() instead:\n${offences.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the seed as the single place the five services are written down', () => {
    const seed = readFileSync(path.resolve(SRC_ROOT, '../prisma/seed.ts'), 'utf8');
    for (const key of SERVICE_KEYS) {
      expect(seed, `seed is missing ${key}`).toContain(`ServiceKey.${key}`);
    }
    // Exactly one active service at launch.
    expect(seed.match(/isActive: true/g) ?? []).toHaveLength(1);
  });
});

describe('per-service config maps stay exhaustive', () => {
  it('covers every service key in the lifecycle map', async () => {
    const { ORDER_LIFECYCLES } = await import('@/lib/orders/transitions');
    expect(Object.keys(ORDER_LIFECYCLES).sort()).toEqual([...SERVICE_KEYS].sort());
  });

  it('covers every service key in the order-details map', async () => {
    const { ORDER_DETAILS_SPECS } = await import('@/lib/orders/details');
    expect(Object.keys(ORDER_DETAILS_SPECS).sort()).toEqual([...SERVICE_KEYS].sort());
  });

  it('implements only the FOOD details shape for now', async () => {
    const { ORDER_DETAILS_SPECS, isDetailsShapeImplemented } = await import(
      '@/lib/orders/details'
    );
    const implemented = Object.entries(ORDER_DETAILS_SPECS)
      .filter(([, spec]) => spec.status === 'IMPLEMENTED')
      .map(([key]) => key);
    expect(implemented).toEqual([ServiceKey.FOOD]);

    // The other four fail loudly rather than accepting an undesigned payload.
    const { parseOrderDetails, ServiceDetailsNotImplementedError } = await import(
      '@/lib/orders/details'
    );
    for (const key of SERVICE_KEYS.filter((k) => k !== ServiceKey.FOOD)) {
      expect(isDetailsShapeImplemented(key)).toBe(false);
      expect(() => parseOrderDetails(key, {})).toThrow(ServiceDetailsNotImplementedError);
    }
  });
});

// -----------------------------------------------------------------------------
// City availability
// -----------------------------------------------------------------------------

describe('live somewhere is not live here', () => {
  const mart = { isActive: true, availableCityIds: ['city_cebu'] };
  const food = { isActive: true, availableCityIds: ['city_manila', 'city_cebu'] };
  const parcel = { isActive: false, availableCityIds: [] };

  it('is orderable in a city it launched in', () => {
    expect(isOrderableIn(mart, 'city_cebu')).toBe(true);
    expect(isOrderableIn(food, 'city_manila')).toBe(true);
  });

  it('is NOT orderable in a city it has not launched in', () => {
    // The mistake this prevents: a tile tappable in Manila for a vertical that
    // only operates in Cebu, which fails at checkout rather than at the tile.
    expect(isOrderableIn(mart, 'city_manila')).toBe(false);
  });

  it('is never orderable while switched off', () => {
    expect(isOrderableIn(parcel, 'city_manila')).toBe(false);
    // Not even in a city somebody has listed by mistake.
    expect(isOrderableIn({ isActive: false, availableCityIds: ['city_manila'] }, 'city_manila')).toBe(
      false,
    );
  });

  it('falls back to "live at all" when we do not know the city', () => {
    // A visitor who has told us nothing sees the live tiles and resolves the
    // city at checkout, which is better than seeing nothing.
    expect(isOrderableIn(mart, undefined)).toBe(true);
    expect(isOrderableIn(parcel, undefined)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 'use server' modules
// -----------------------------------------------------------------------------

describe("a 'use server' file exports only async functions", () => {
  /**
   * Next.js enforces this, and only at build or request time — `tsc` and
   * ESLint both pass a file that breaks it, so the first sign is a 500 in the
   * browser. It has now cost this codebase two debugging rounds: a constant
   * and an enum re-export, both of which looked completely ordinary.
   *
   * The fix in both cases was to move the value somewhere else, so the rule
   * this asserts is not a style preference — it is the difference between a
   * working page and one that throws.
   */
  const actionFiles = readdirSync(path.join(process.cwd(), 'src/lib/actions'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('src/lib/actions', name));

  it('finds the action modules', () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of actionFiles) {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    if (!/^\s*['"]use server['"]/m.test(source)) continue;

    it(`${path.basename(file)} exports nothing but async functions`, () => {
      // Types are erased before Next.js sees the module, so `export type` and
      // `export interface` are fine. Everything else must be an async
      // function declaration.
      const offenders: string[] = [];
      for (const match of source.matchAll(/^export\s+(?!type\b|interface\b)(.+)$/gm)) {
        const declaration = match[1]!.trim();
        if (declaration.startsWith('async function')) continue;
        offenders.push(declaration.slice(0, 70));
      }
      expect(offenders, `${file} — move these out of the 'use server' module`).toEqual([]);
    });
  }
});
