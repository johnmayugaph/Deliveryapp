import { readFileSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StoreRole } from '@prisma/client';
import {
  BACK_OFFICE_AREAS,
  areasAddedBy,
  roleCanHandOverTheShop,
  roleSatisfies,
  roleSeesTakings,
  tabsFor,
} from '@/lib/merchant/roles';
import { canChangeRole, canRemove } from '@/lib/merchant/staff-policy';

/**
 * What a role grants, and the one place that decides it.
 *
 * The sentences an owner reads when handing out access are derived from the
 * same map the tab bar renders from, so the tests that matter are the ones
 * that stop the two drifting apart — a hand-written "managers can see
 * payouts" that rots is a false promise about who can see a shop's takings.
 */

const ALL_ROLES = Object.values(StoreRole);

describe('the back-office map', () => {
  it('names a role every area actually gates on', () => {
    for (const area of BACK_OFFICE_AREAS) {
      expect(ALL_ROLES, area.key).toContain(area.needs);
      expect(area.grants.trim().length, area.key).toBeGreaterThan(10);
      // A sentence, so it reads as one in a list.
      expect(area.grants.trim(), area.key).toMatch(/\.$/);
    }
  });

  it('uses a unique key per area', () => {
    const keys = BACK_OFFICE_AREAS.map((area) => area.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks the takings as the sensitive one, and only it', () => {
    // If a second area ever exposes money, the note under the dropdown says so
    // automatically — but the decision should be deliberate, so it is pinned.
    const sensitive = BACK_OFFICE_AREAS.filter((area) => area.sensitive);
    expect(sensitive.map((area) => area.key)).toEqual(['payouts']);
  });
});

describe('the tabs come from the map', () => {
  it('gives a staff member everything except the money', () => {
    const keys = tabsFor(StoreRole.STAFF).map((tab) => tab.key);
    expect(keys).toContain('queue');
    expect(keys).toContain('menu');
    expect(keys).toContain('staff');
    expect(keys).toContain('settings');
    // Menu, Staff and Settings admit a staff member and degrade to read-only,
    // so hiding them would remove screens that work. Payouts refuses outright.
    expect(keys).not.toContain('payouts');
  });

  it('gives a manager the money too', () => {
    expect(tabsFor(StoreRole.MANAGER).map((tab) => tab.key)).toContain('payouts');
  });

  it('gives an owner everything a manager has', () => {
    const manager = tabsFor(StoreRole.MANAGER).map((tab) => tab.key);
    const owner = tabsFor(StoreRole.OWNER).map((tab) => tab.key);
    for (const key of manager) expect(owner).toContain(key);
  });

  it('lists only real screens, in a stable order', () => {
    for (const tab of tabsFor(StoreRole.OWNER)) {
      const dir =
        tab.path === null
          ? 'src/app/merchant/[storeId]'
          : `src/app/merchant/[storeId]/${tab.path}`;
      // The first draft of a panel like this pointed at two console routes
      // that did not exist. Every path here is walked to a real page.
      expect(
        existsSync(path.join(process.cwd(), dir, 'page.tsx')),
        `${tab.key} has no page at ${dir}`,
      ).toBe(true);
    }
    expect(tabsFor(StoreRole.OWNER)[0]!.key).toBe('queue');
  });

  it('is rendered from the shared map, not a second copy', () => {
    /**
     * The list lived inline in this component. That was fine while its only
     * job was hiding a tab, and stopped being fine when the staff screen had
     * to explain what a role grants: two copies is a screen promising access
     * the gate does not give.
     */
    const tabs = readFileSync(
      path.join(process.cwd(), 'src/components/merchant/MerchantTabs.tsx'),
      'utf8',
    );
    expect(tabs).toMatch(/tabsFor\(role\)/);
    expect(tabs).not.toMatch(/needs: StoreRole\./);
    expect(tabs).not.toMatch(/label: 'Payouts'/);
  });
});

describe('what each rung adds', () => {
  it('tells a staff member what they can do, not what a manager can', () => {
    const keys = areasAddedBy(StoreRole.STAFF).map((area) => area.key);
    expect(keys).toContain('queue');
    expect(keys).not.toContain('payouts');
  });

  it('describes a manager by the difference, not the whole job', () => {
    // Nobody needs telling that a manager can accept orders.
    const keys = areasAddedBy(StoreRole.MANAGER).map((area) => area.key);
    expect(keys).toContain('payouts');
    expect(keys).toContain('menu-edit');
    expect(keys).toContain('staff-invite');
    expect(keys).not.toContain('queue');
  });

  it('does not credit a manager with removing people or changing roles', () => {
    /**
     * The first draft of the manager's sentence said "Invite people, change
     * what they can do, and remove them." Two-thirds false: `canRemove` is
     * `isSelf || actor === OWNER`, and `canChangeRole` needs the actor to be
     * able to grant the CURRENT role too — which caps a manager at moving a
     * staff member to staff. Exactly the false promise this map exists to
     * prevent, so the claim is checked against the policy.
     */
    expect(canRemove(StoreRole.MANAGER, false)).toBe(false);
    expect(canChangeRole(StoreRole.MANAGER, StoreRole.STAFF, StoreRole.MANAGER)).toBe(
      false,
    );
    const sentence = BACK_OFFICE_AREAS.find(
      (area) => area.key === 'staff-invite',
    )!.grants;
    expect(sentence).not.toMatch(/remove/i);
    expect(sentence).toMatch(/withdraw an invitation/i);
  });

  it('gives the owner rung something real to say', () => {
    // It had nothing, so the note read "May-ari — the same as the role below"
    // for the most consequential grant on the screen. Seen in a browser.
    const added = areasAddedBy(StoreRole.OWNER);
    expect(added.length).toBeGreaterThan(0);
    expect(added.map((area) => area.key)).toContain('staff-control');
    // And the claim is true: an owner really can remove somebody else.
    expect(canRemove(StoreRole.OWNER, false)).toBe(true);
    expect(canChangeRole(StoreRole.OWNER, StoreRole.MANAGER, StoreRole.OWNER)).toBe(
      true,
    );
  });

  it('knows which role can hand the shop over, from the ceiling', () => {
    expect(roleCanHandOverTheShop(StoreRole.OWNER)).toBe(true);
    expect(roleCanHandOverTheShop(StoreRole.MANAGER)).toBe(false);
    expect(roleCanHandOverTheShop(StoreRole.STAFF)).toBe(false);
  });

  it('includes the abilities that are not tabs', () => {
    /**
     * From the owner's side of the decision, "can change prices" is as much a
     * grant as "can open Payouts" — and it is gated inside a screen a staff
     * member CAN open, so a tabs-only list would understate a manager badly.
     */
    const notTabs = BACK_OFFICE_AREAS.filter((area) => area.tab === null);
    expect(notTabs.map((area) => area.key).sort()).toEqual([
      'menu-edit',
      'settings-edit',
      'staff-control',
      'staff-invite',
    ]);
  });

  it('accounts for every area across the three rungs', () => {
    // Nothing may be described by no rung, or the note would silently omit it.
    const covered = ALL_ROLES.flatMap((role) =>
      areasAddedBy(role).map((area) => area.key),
    );
    expect(covered.sort()).toEqual(BACK_OFFICE_AREAS.map((a) => a.key).sort());
  });
});

describe('which roles see the money', () => {
  it('is true for a manager and an owner, false for staff', () => {
    expect(roleSeesTakings(StoreRole.STAFF)).toBe(false);
    expect(roleSeesTakings(StoreRole.MANAGER)).toBe(true);
    expect(roleSeesTakings(StoreRole.OWNER)).toBe(true);
  });

  it('agrees with the ladder rather than being a second list', () => {
    for (const role of ALL_ROLES) {
      const byLadder = BACK_OFFICE_AREAS.some(
        (area) => area.sensitive && roleSatisfies(role, area.needs),
      );
      expect(roleSeesTakings(role), role).toBe(byLadder);
    }
  });
});

describe('where the answer is shown', () => {
  const manager = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/StaffManager.tsx'),
    'utf8',
  );
  const note = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/RoleGrantNote.tsx'),
    'utf8',
  );

  it('marks the money role on the option itself, in both dropdowns', () => {
    // The fuller note sits under the invite form; the second place a role is
    // chosen is a row further down, and somebody promoting an existing member
    // may never scroll back to it.
    expect(manager).toMatch(/sees the money/);
    const uses = manager.match(/roleOptionLabel\(role\)/g) ?? [];
    expect(uses.length).toBe(2);
    expect(manager).not.toMatch(/\{STORE_ROLE_LABELS\[role\]\}\s*<\/option>/);
  });

  it('builds every sentence from the map rather than writing its own', () => {
    /**
     * The first version of this assertion searched the whole file for
     * "Payouts" and failed on the module's own doc comment, which explains
     * WHY the sentences are derived. Comments are the place to say that; the
     * thing being tested is the rendered output, so the comments come out
     * first. Caught by the test failing on itself.
     */
    expect(note).toMatch(/areasAddedBy/);
    expect(note).toMatch(/area\.grants/);
    const rendered = note
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    // No hand-written claim about a screen in what a person actually reads:
    // that is the sentence that rots when a gate changes.
    expect(rendered).not.toMatch(/Payouts/);
  });

  it('says that taking a role back does not unsee the takings', () => {
    expect(note).toMatch(/does not unsee/);
  });
});

// --- No second, hand-written answer ---------------------------------------

describe('there is one explanation, not two', () => {
  const manager = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/StaffManager.tsx'),
    'utf8',
  );
  const rendered = manager
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('no longer enumerates the roles in prose beside the derived note', () => {
    /**
     * Found in a browser: a hand-written summary already sat under the roster
     * reading "Staff: queue lang. Manager: menu at settings din, at
     * makakadagdag ng staff." It was wrong — a staff member sees Menu,
     * History, Regulars, Staff and Settings — and it never mentioned Payouts,
     * the money, which is the whole reason this phase exists. Two answers to
     * one question, one of them omitting the takings, is worse than either.
     */
    expect(rendered).not.toMatch(/queue lang/);
    expect(rendered).not.toMatch(/makakadagdag ng/);
    expect(rendered).not.toMatch(/lahat, kasama/);
  });

  it('keeps the last-owner rule, which the note does not carry', () => {
    // A single invariant rather than a list, so it cannot rot the same way.
    expect(rendered).toMatch(/always keeps at least one May-ari/);
  });
});
