import { StoreRole } from '@prisma/client';

/**
 * The role ladder, with nothing else in it.
 *
 * Split out of `./access.ts` so the tab bar can ask "may this member open this
 * screen" without importing it. `access.ts` reaches Prisma and the session,
 * and a `'use client'` component that imports either turns into a 500 the
 * moment it renders — a trap this codebase has walked into four times and now
 * has a test guarding.
 *
 * Pure: imports the enum and nothing else.
 */

/** Most-privileged first, so "at least this role" is a simple comparison. */
const ROLE_RANK: Readonly<Record<StoreRole, number>> = {
  [StoreRole.OWNER]: 3,
  [StoreRole.MANAGER]: 2,
  [StoreRole.STAFF]: 1,
};

/** Whether `actual` meets or exceeds `required`. */
export function roleSatisfies(actual: StoreRole, required: StoreRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
