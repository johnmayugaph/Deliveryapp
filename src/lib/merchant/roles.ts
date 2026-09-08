import { StoreRole } from '@prisma/client';
import { HIGHEST_GRANTABLE } from '@/lib/merchant/staff-policy';

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

/**
 * The back office, as one list: what each area is, which role reaches it, and
 * what holding that role therefore exposes.
 *
 * This existed as an inline array inside `MerchantTabs.tsx`, which was fine
 * while its only job was to hide a tab. It stopped being fine when the staff
 * screen needed to tell an owner what a role GRANTS: a hand-written sentence
 * saying "managers can see payouts" rots silently the first time somebody
 * changes a gate, and the sentence it rots into is a promise about who can see
 * a shop's takings.
 *
 * So the tab bar renders from this and the explanation is derived from it.
 * Adding a screen is one decision in one place, and the words an owner reads
 * cannot disagree with the gate that actually runs.
 *
 * What it does NOT model is the finer gating inside a screen — `canEdit` on
 * the menu, `canRevoke` on this very list. Those are captured as their own
 * entries with no path, because from the owner's side of the decision "can
 * change prices" is exactly as much a grant as "can open Payouts", and a list
 * that mentioned only tabs would understate what a manager can do.
 */
export interface BackOfficeArea {
  /** Stable key, used for React keys and tests rather than the label. */
  key: string;
  /** Tab label, or null when this is an ability rather than a screen. */
  tab: string | null;
  /** Path under `/merchant/<storeId>`, or null for the queue and abilities. */
  path: string | null;
  needs: StoreRole;
  /**
   * What somebody holding this role can then do, addressed to the person
   * deciding whether to grant it.
   */
  grants: string;
  /**
   * Money, or a figure a shop owner may not want known to whoever is on the
   * counter. Called out separately rather than left in the prose, because it
   * is the half of this decision that is hard to undo.
   */
  sensitive: boolean;
}

export const BACK_OFFICE_AREAS: readonly BackOfficeArea[] = [
  {
    key: 'queue',
    tab: 'Queue',
    path: null,
    needs: StoreRole.STAFF,
    grants: 'Accept and reject orders, and mark them ready.',
    sensitive: false,
  },
  {
    key: 'menu',
    tab: 'Menu',
    path: 'menu',
    needs: StoreRole.STAFF,
    grants: 'See the menu and mark a dish sold out for the night.',
    sensitive: false,
  },
  {
    key: 'menu-edit',
    tab: null,
    path: null,
    needs: StoreRole.MANAGER,
    grants: 'Change prices, add and remove dishes, and edit the sections.',
    sensitive: false,
  },
  {
    key: 'history',
    tab: 'History',
    path: 'history',
    needs: StoreRole.STAFF,
    grants:
      'See finished orders, what each one was worth, and what customers said.',
    sensitive: false,
  },
  {
    key: 'regulars',
    tab: 'Regulars',
    path: 'regulars',
    needs: StoreRole.STAFF,
    grants: 'See which customers are regulars, and what their status changes.',
    sensitive: false,
  },
  {
    key: 'payouts',
    tab: 'Payouts',
    path: 'payouts',
    needs: StoreRole.MANAGER,
    grants:
      'See what TARA owes the shop, every payout received, and the commission taken on each order.',
    sensitive: true,
  },
  {
    key: 'staff',
    tab: 'Staff',
    path: 'staff',
    needs: StoreRole.STAFF,
    grants: 'See who works here.',
    sensitive: false,
  },
  {
    key: 'staff-invite',
    tab: null,
    path: null,
    needs: StoreRole.MANAGER,
    /**
     * NOT "and remove them". `canRemove` is `isSelf || actor === OWNER`, so a
     * manager cannot remove anybody but themselves, and `canChangeRole`
     * requires being able to grant the CURRENT role as well as the next one —
     * which caps a manager at moving a staff member to staff, i.e. nothing.
     *
     * The first draft of this line said a manager could change roles and
     * remove people. It was caught by reading the policy while writing the
     * owner's entry below, and it is exactly the false promise this map exists
     * to prevent: prose about who can do what, written next to the gate
     * instead of derived from it.
     */
    grants:
      'Invite staff, and withdraw an invitation that has not been used yet.',
    sensitive: false,
  },
  {
    key: 'staff-control',
    tab: null,
    path: null,
    needs: StoreRole.OWNER,
    /**
     * The owner rung had nothing at all, so the note read "May-ari — the same
     * as the role below", which is the worst available sentence for the most
     * consequential grant on the screen. Seen in a browser.
     */
    grants:
      'Remove anybody, change what anybody can do, and appoint another owner.',
    sensitive: false,
  },
  {
    key: 'settings',
    tab: 'Settings',
    path: 'settings',
    needs: StoreRole.STAFF,
    grants: 'See the shop’s details and opening state.',
    sensitive: false,
  },
  {
    key: 'settings-edit',
    tab: null,
    path: null,
    needs: StoreRole.MANAGER,
    grants: 'Change the shop’s name, address, map pin and preparation time.',
    sensitive: false,
  },
];

/** The tabs a member of this role may open, in order. */
export function tabsFor(
  role: StoreRole,
): { key: string; tab: string; path: string | null }[] {
  return BACK_OFFICE_AREAS.filter(
    (area) => area.tab !== null && roleSatisfies(role, area.needs),
  ).map((area) => ({ key: area.key, tab: area.tab!, path: area.path }));
}

/**
 * What this rung adds over the one below it.
 *
 * The useful framing when choosing a role from a dropdown: nobody needs to be
 * told that a manager can accept orders, they need to be told what changes.
 */
export function areasAddedBy(role: StoreRole): BackOfficeArea[] {
  return BACK_OFFICE_AREAS.filter((area) => area.needs === role);
}

/**
 * True when this role can appoint another owner — which is how the shop is
 * handed over, and which also lets them remove the person who appointed them.
 *
 * Read off `HIGHEST_GRANTABLE` rather than stated, so it stays true if the
 * grant ceiling ever changes.
 */
export function roleCanHandOverTheShop(role: StoreRole): boolean {
  return HIGHEST_GRANTABLE[role] === StoreRole.OWNER;
}

/** True when granting this role exposes something the owner may want kept in. */
export function roleSeesTakings(role: StoreRole): boolean {
  return BACK_OFFICE_AREAS.some(
    (area) => area.sensitive && roleSatisfies(role, area.needs),
  );
}
