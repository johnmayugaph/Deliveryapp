import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tabsFor } from '@/lib/merchant/roles';
import {
  NotificationChannel,
  NotificationKind,
  StoreRole,
} from '@prisma/client';
import {
  CannotChangeRoleError,
  CannotGrantRoleError,
  HIGHEST_GRANTABLE,
  INVITE_VALID_DAYS,
  STORE_ROLE_LABELS,
  assertCanChangeRole,
  assertCanGrant,
  canChangeRole,
  canGrant,
  canRemove,
  describeInviteWindow,
  grantableRoles,
  inviteExpiry,
  inviteIsLive,
  wouldStrandStore,
} from '@/lib/merchant/staff-policy';
import { slugify } from '@/lib/admin/stores';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Store staff: who may hand out access, and to whom.
 *
 * Two properties matter more than the rest. A store must never be left with
 * nobody in charge, and nobody must be able to promote themselves past the
 * person whose business it is. Both are enforced twice — here and in
 * `prisma/sql/store_members.sql` — and the last test in this file is the one
 * that checks the two have not drifted apart.
 */

function source(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

/** Comments blanked, so a docstring stating a rule cannot satisfy a grep for it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('--'))
    .join('\n');
}

const ALL_ROLES = Object.values(StoreRole);

// -----------------------------------------------------------------------------
// Who may grant what
// -----------------------------------------------------------------------------

describe('handing out access', () => {
  it('has a rule for every role, so adding one is a decision', () => {
    expect(Object.keys(HIGHEST_GRANTABLE).sort()).toEqual([...ALL_ROLES].sort());
    expect(Object.keys(STORE_ROLE_LABELS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it('lets an owner appoint anybody, including another owner', () => {
    // Ownership has to be transferable by the person holding it. Otherwise
    // handing a shop to a new proprietor needs a support ticket, and what
    // people do when a screen will not let them is share the login.
    for (const role of ALL_ROLES) {
      expect(canGrant(StoreRole.OWNER, role), role).toBe(true);
    }
  });

  it('lets a manager add staff and nobody else', () => {
    // A manager who could appoint peers could build a majority that outvotes
    // the person whose business it is.
    expect(canGrant(StoreRole.MANAGER, StoreRole.STAFF)).toBe(true);
    expect(canGrant(StoreRole.MANAGER, StoreRole.MANAGER)).toBe(false);
    expect(canGrant(StoreRole.MANAGER, StoreRole.OWNER)).toBe(false);
  });

  it('lets staff add nobody at all', () => {
    for (const role of ALL_ROLES) {
      expect(canGrant(StoreRole.STAFF, role), role).toBe(false);
    }
    expect(grantableRoles(StoreRole.STAFF)).toEqual([]);
  });

  it('offers exactly the roles the form should show', () => {
    expect(grantableRoles(StoreRole.OWNER).sort()).toEqual([...ALL_ROLES].sort());
    expect(grantableRoles(StoreRole.MANAGER)).toEqual([StoreRole.STAFF]);
  });

  it('throws a sentence a person can act on', () => {
    expect(() => assertCanGrant(StoreRole.STAFF, StoreRole.STAFF)).toThrow(
      CannotGrantRoleError,
    );
    expect(() => assertCanGrant(StoreRole.MANAGER, StoreRole.OWNER)).toThrow(
      /only the owner/i,
    );
  });
});

describe('changing an existing role', () => {
  it('is judged on the role somebody HOLDS as well as the one they are given', () => {
    // The escalation this stops: a manager cannot grant OWNER, but without
    // this check they could still "change the role" of the owner to staff and
    // take the shop over.
    expect(canChangeRole(StoreRole.MANAGER, StoreRole.OWNER, StoreRole.STAFF)).toBe(
      false,
    );
    expect(() =>
      assertCanChangeRole(StoreRole.MANAGER, StoreRole.OWNER, StoreRole.STAFF),
    ).toThrow(CannotChangeRoleError);
  });

  it('says which half of the check failed', () => {
    // A manager demoting the owner used to be told "only a manager or the owner
    // can add staff" — true, and not the problem, because the role they
    // REQUESTED was staff. A misleading refusal sends somebody to ask for the
    // wrong permission.
    expect(() =>
      assertCanChangeRole(StoreRole.MANAGER, StoreRole.OWNER, StoreRole.STAFF),
    ).toThrow(/only the owner can change/i);
    expect(() =>
      assertCanChangeRole(StoreRole.STAFF, StoreRole.STAFF, StoreRole.STAFF),
    ).toThrow(/only a manager or the owner can change/i);
    // And when the role being handed out IS the problem, it says that instead.
    expect(() =>
      assertCanChangeRole(StoreRole.MANAGER, StoreRole.STAFF, StoreRole.OWNER),
    ).toThrow(/only the owner can make somebody/i);
  });

  it('lets a manager move staff around', () => {
    expect(canChangeRole(StoreRole.MANAGER, StoreRole.STAFF, StoreRole.STAFF)).toBe(
      true,
    );
  });

  it('lets an owner do anything', () => {
    expect(canChangeRole(StoreRole.OWNER, StoreRole.OWNER, StoreRole.MANAGER)).toBe(
      true,
    );
  });
});

describe('removing somebody', () => {
  it('is the owner’s call for other people', () => {
    expect(canRemove(StoreRole.OWNER, false)).toBe(true);
    expect(canRemove(StoreRole.MANAGER, false)).toBe(false);
    expect(canRemove(StoreRole.STAFF, false)).toBe(false);
  });

  it('always lets a person leave', () => {
    // Somebody who has stopped working at a shop should not need the owner's
    // cooperation to stop appearing in its staff list.
    for (const role of ALL_ROLES) {
      expect(canRemove(role, true), role).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// The invariant
// -----------------------------------------------------------------------------

describe('a store always keeps an owner', () => {
  const owner = { userId: 'u1', role: StoreRole.OWNER };
  const manager = { userId: 'u2', role: StoreRole.MANAGER };
  const secondOwner = { userId: 'u3', role: StoreRole.OWNER };

  it('refuses to remove the last one', () => {
    expect(
      wouldStrandStore({ members: [owner, manager], userId: 'u1', nextRole: null }),
    ).toBe(true);
  });

  it('refuses to demote the last one', () => {
    expect(
      wouldStrandStore({
        members: [owner, manager],
        userId: 'u1',
        nextRole: StoreRole.MANAGER,
      }),
    ).toBe(true);
  });

  it('allows it once there are two', () => {
    expect(
      wouldStrandStore({
        members: [owner, secondOwner],
        userId: 'u1',
        nextRole: null,
      }),
    ).toBe(false);
  });

  it('does not care about anybody who is not an owner', () => {
    expect(
      wouldStrandStore({ members: [owner, manager], userId: 'u2', nextRole: null }),
    ).toBe(false);
  });

  it('is fine with an owner staying an owner', () => {
    // Re-saving the same role must not be rejected as "stranding" the store.
    expect(
      wouldStrandStore({
        members: [owner],
        userId: 'u1',
        nextRole: StoreRole.OWNER,
      }),
    ).toBe(false);
  });

  it('is enforced by the database as well, not only here', () => {
    // This is the enforcement that counts, because it holds for code paths
    // that do not exist yet — a console action, a future script, a hand-written
    // UPDATE at 2am. The TypeScript version exists so a person gets a sentence
    // instead of a Postgres error.
    const guard = codeOnly(source('prisma/sql/store_members.sql'));
    expect(guard).toMatch(/CREATE CONSTRAINT TRIGGER/);
    expect(guard).toMatch(/AFTER UPDATE OR DELETE ON "StoreMember"/);
    expect(guard).toMatch(/role = 'OWNER'/);
    expect(guard).toMatch(/RAISE EXCEPTION/);
  });

  it('checks at COMMIT, so handing ownership over is possible', () => {
    // Promoting the new owner and demoting the old one are two statements. A
    // non-deferred check would reject whichever order they were written in.
    expect(codeOnly(source('prisma/sql/store_members.sql'))).toMatch(
      /DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it('does not make a store undeletable', () => {
    // Deleting a Store cascades to its members. Complaining that a store being
    // deleted has no owner would mean no store could ever be removed.
    expect(codeOnly(source('prisma/sql/store_members.sql'))).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "Store"/,
    );
  });

  it('lets a lawful purge through, the same way the ledger does', () => {
    expect(codeOnly(source('prisma/sql/store_members.sql'))).toMatch(
      /tara\.allow_purge/,
    );
  });

  it('does not guard INSERT, because a store’s first member predates its owner', () => {
    const guard = codeOnly(source('prisma/sql/store_members.sql'));
    expect(guard).not.toMatch(/AFTER INSERT/);
  });
});

// -----------------------------------------------------------------------------
// Invitations
// -----------------------------------------------------------------------------

describe('inviting a number that has no account', () => {
  it('expires, because Philippine numbers are recycled', () => {
    // An invite is a grant to whoever can receive a code on that number. A
    // forgotten one must not hand a stranger the order queue two years later.
    expect(INVITE_VALID_DAYS).toBeGreaterThan(0);
    expect(INVITE_VALID_DAYS).toBeLessThanOrEqual(30);
    const now = new Date('2026-09-07T00:00:00Z');
    expect(inviteExpiry(now).getTime() - now.getTime()).toBe(
      INVITE_VALID_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('is live only while it is unaccepted, unrevoked and unexpired', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    const later = new Date('2026-09-14T00:00:00Z');
    const base = { acceptedAt: null, revokedAt: null, expiresAt: later };

    expect(inviteIsLive(base, now)).toBe(true);
    expect(inviteIsLive({ ...base, acceptedAt: now }, now)).toBe(false);
    expect(inviteIsLive({ ...base, revokedAt: now }, now)).toBe(false);
    expect(inviteIsLive({ ...base, expiresAt: now }, now)).toBe(false);
  });

  it('says how long is left in words a person reads', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
    expect(describeInviteWindow(days(14), now)).toBe('14 days left');
    expect(describeInviteWindow(days(1), now)).toBe('1 day left');
    expect(describeInviteWindow(new Date(now.getTime() + 3 * 3600_000), now)).toBe(
      '3 hours left',
    );
    expect(describeInviteWindow(new Date(now.getTime() - 1000), now)).toBe('expired');
  });

  it('NEVER texts the number', () => {
    // The decision this test exists to protect. An invite form that sent an
    // SMS would be a way for any shop owner to message strangers at our
    // expense, from our sender name — and the invited person hears about it
    // from whoever is hiring them anyway.
    const code = codeOnly(source('src/lib/merchant/staff.ts'));
    expect(code).not.toMatch(/sms|sendSms|Semaphore/i);
    const actions = codeOnly(source('src/lib/actions/staff-actions.ts'));
    expect(actions).not.toMatch(/sms|sendSms|Semaphore/i);
  });

  it('is redeemed at the moment the number is proved, not before', () => {
    // Sign-in, right after the OTP was verified. That is the only point at
    // which anybody has demonstrated they hold the SIM.
    const login = codeOnly(source('src/lib/auth/login.ts'));
    expect(login).toMatch(/redeemStoreInvites\(\{ userId: user\.id, phone \}\)/);
    // After the refusal check, or a blocked account would collect memberships.
    expect(login.indexOf('redeemStoreInvites')).toBeGreaterThan(
      login.indexOf('signInIsPermitted'),
    );
  });

  it('cannot break a login', () => {
    // A sign-in that failed because of a shop invitation would be baffling to
    // the person it happened to and unfixable by them.
    const staff = source('src/lib/merchant/staff.ts');
    const fn = staff.slice(staff.indexOf('export async function redeemStoreInvites'));
    const body = fn.slice(0, fn.indexOf('export async function pruneExpiredInvites'));
    expect(body).toMatch(/} catch \{/);
  });

  it('never lets an invite overwrite a membership somebody already has', () => {
    // The existing membership is the more recent decision. An invite that
    // quietly restored an old role would undo a demotion.
    const staff = codeOnly(source('src/lib/merchant/staff.ts'));
    expect(staff).toMatch(/if \(!existing\) \{/);
  });
});

// -----------------------------------------------------------------------------
// Telling people
// -----------------------------------------------------------------------------

describe('the notification', () => {
  it('exists and does not cost a peso', () => {
    const policy = KIND_POLICY[NotificationKind.STORE_ACCESS_CHANGED];
    expect(policy).toBeDefined();
    expect(policy.channels).toContain(NotificationChannel.IN_APP);
    // It is a privilege the person now HOLDS, not a threat to their account,
    // and the volume is staff churn across every store on the platform.
    expect(policy.channels).not.toContain(NotificationChannel.SMS);
    expect(policy.unmutable).toBeUndefined();
  });

  it('never announces a removal as an addition', () => {
    const granted = renderNotification(NotificationKind.STORE_ACCESS_CHANGED, {
      storeName: 'Kuya Ben',
      storeRoleLabel: 'Staff',
      storeAccessEvent: 'GRANTED',
    });
    const removed = renderNotification(NotificationKind.STORE_ACCESS_CHANGED, {
      storeName: 'Kuya Ben',
      storeRoleLabel: 'Staff',
      storeAccessEvent: 'REMOVED',
    });
    const changed = renderNotification(NotificationKind.STORE_ACCESS_CHANGED, {
      storeName: 'Kuya Ben',
      storeRoleLabel: 'Manager',
      storeAccessEvent: 'ROLE_CHANGED',
    });

    expect(new Set([granted.title, removed.title, changed.title]).size).toBe(3);
    expect(removed.title).toMatch(/no longer/i);
    expect(removed.body).not.toMatch(/added/i);
    // And it says what is NOT affected, because "removed" about a delivery app
    // reads as "my account is gone".
    expect(removed.body).toMatch(/credits are untouched/i);
  });

  it('does not link a removed person into a store they cannot open', () => {
    const staff = codeOnly(source('src/lib/merchant/staff.ts'));
    expect(staff).toMatch(/event === 'REMOVED' \? \{\} : \{ href:/);
  });
});

// -----------------------------------------------------------------------------
// The console's half
// -----------------------------------------------------------------------------

describe('creating a partner store', () => {
  it('creates it hidden from customers', () => {
    // A shop with no menu that customers can find is worse than one they
    // cannot: they open it, see nothing, and conclude the app is broken.
    const actions = codeOnly(source('src/lib/actions/admin-actions.ts'));
    const create = actions.slice(actions.indexOf('export async function createStoreAction'));
    expect(create.slice(0, create.indexOf('export async function', 10))).toMatch(
      /isVisible: false/,
    );
  });

  it('refuses to make a menuless store visible', () => {
    const actions = codeOnly(source('src/lib/actions/admin-actions.ts'));
    expect(actions).toMatch(/menuItems === 0/);
  });

  it('rejects coordinates that are not in the Philippines', () => {
    // A store at 0,0 is in the Atlantic, and every delivery fee from it would
    // be computed from the Gulf of Guinea. Swapped latitude and longitude is
    // the mistake this actually catches.
    //
    // Checked against the SHARED bounds rather than a second copy of the
    // numbers: the map picker validates with the same module, and a picker
    // that lets somebody drop a pin the server then rejects is worse than no
    // picker. `geo.test.ts` asserts the literals are gone from here.
    const actions = codeOnly(source('src/lib/actions/admin-actions.ts'));
    expect(actions).toMatch(/isInPhilippines\(\{ latitude, longitude \}\)/);
    expect(actions).toMatch(/looksSwapped\(/);
  });

  it('names an owner in the same transaction as the store', () => {
    // A store with no owner cannot be opened by anybody, so creating one
    // without an owner just moves the hand-editing somewhere else.
    const actions = source('src/lib/actions/admin-actions.ts');
    const create = actions.slice(actions.indexOf('export async function createStoreAction'));
    const body = create.slice(0, create.indexOf('export async function', 10));
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/grantStoreAccessAsAdmin/);
    expect(body).toMatch(/StoreRole\.OWNER/);
  });

  it('records the store actions in the audit log, unlike the support ones', () => {
    // These move ACCESS — the power to change prices and accept orders in a
    // real business — which is squarely what the audit log is for.
    const actions = source('src/lib/actions/admin-actions.ts');
    for (const name of [
      'createStoreAction',
      'setStoreVisibilityAction',
      'grantStoreAccessAction',
      'revokeStoreAccessAction',
    ]) {
      const start = actions.indexOf(`export async function ${name}`);
      const body = actions.slice(start, actions.indexOf('export async function', start + 10));
      expect(body, `${name} does not audit`).toMatch(/recordAdminAction/);
      expect(body, `${name} does not demand a reason`).toMatch(/normaliseReason/);
      expect(body, `${name} does not use the store action`).toMatch(
        /STORE_MEMBERSHIP_CHANGED/,
      );
    }
  });

  /*
   * THE EXCEPTIONS, and the rule behind them.
   *
   * Most console actions are judgement calls — suspending a shop, moving a
   * phone number, adjusting credits — and for those the typed reason IS the
   * record: the row is worthless without knowing who asked and why.
   *
   * A few are not. A switch, or a form filled in from a partner reading
   * details down the phone, has no "why" beyond the act itself, and demanding
   * a sentence in front of each one buys a log that says "logo" four hundred
   * times while slowing down the common case. Those compose their reason from
   * what actually happened, which says MORE than a typed one would.
   *
   * The test is the fence: the composing set has to be exactly this list, so a
   * new one cannot join by imitation. Adding to it is a decision somebody
   * makes here, in the open, against the rule above — not something that
   * happens because a new action looked like an old one.
   *
   * An earlier version checked only names beginning `set` or `grant`, and the
   * store form slipped past it unnoticed because it begins `update`. A guard
   * that cannot fail is worse than no guard: it reports a safety it does not
   * provide. It now walks every exported action.
   */
  const SYSTEM_WRITTEN_REASONS = [
    // A switch in the page header. It cannot stop to ask.
    'setStoreVisibilityAction',
    // The store edit form. Reason box removed on request.
    'updateStoreProfileAction',
    // Adding a dish: the reason is the dish, and it is already in the row.
    'addStoreMenuItemAction',
    // A photo on a dish. Same case as the dish itself — a file picker has
    // nothing to justify beyond the file.
    'uploadStoreMenuItemImageAction',
  ];

  it('composes its own reason in exactly the places that are allowed to', () => {
    const actions = source('src/lib/actions/admin-actions.ts');
    const chunks = actions.split('export async function ').slice(1);

    const composed: string[] = [];
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf('('));
      if (!chunk.includes('normaliseReason')) continue;
      if (!chunk.includes('normaliseReason(formData')) composed.push(name);
    }

    // Sorted so the failure message reads as a list rather than as an order.
    expect([...composed].sort()).toEqual([...SYSTEM_WRITTEN_REASONS].sort());
  });

  it('still finds enough actions for that check to mean anything', () => {
    // Without this, deleting every action would make the test above pass.
    const actions = source('src/lib/actions/admin-actions.ts');
    const askers = actions
      .split('export async function ')
      .slice(1)
      .filter((chunk) => chunk.includes('normaliseReason(formData'));
    // If this ever approaches the composing set's size, the exception has
    // become the rule and the list above needs arguing about, not extending.
    expect(askers.length).toBeGreaterThan(10);
    expect(askers.length).toBeGreaterThan(SYSTEM_WRITTEN_REASONS.length * 5);
  });

  it('masks the phone number it writes into the audit detail', () => {
    // The audit log is read by more people than the account record is.
    const actions = codeOnly(source('src/lib/actions/admin-actions.ts'));
    const create = actions.slice(actions.indexOf('createStoreAction'));
    expect(create.slice(0, 4000)).toMatch(/maskPhilippineMobile/);
  });

  it('cannot strand a store from the console either', () => {
    const staff = codeOnly(source('src/lib/merchant/staff.ts'));
    const revoke = staff.slice(staff.indexOf('revokeStoreAccessAsAdmin'));
    expect(revoke).toMatch(/wouldStrandStore/);
  });
});

describe('slugs', () => {
  it('survives the punctuation real shop names have', () => {
    expect(slugify("Kuya Ben's Grill")).toBe('kuya-bens-grill');
    expect(slugify('Rice & Sisig')).toBe('rice-and-sisig');
    expect(slugify('  Aling Nena  ')).toBe('aling-nena');
    expect(slugify('Café Niño')).toBe('cafe-nino');
  });

  it('never produces something unusable in a URL', () => {
    for (const name of ['!!!', '   ', '///', '???']) {
      expect(slugify(name)).not.toMatch(/[^a-z0-9-]/);
    }
  });
});

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

describe('the wiring', () => {
  it('keeps the policy free of anything server-only', () => {
    // The reason this is a test: `STORE_ROLE_LABELS` used to live in
    // `merchant/access.ts`, which reaches for the session, which reaches for
    // `next/headers`. A client component importing one label pulled the whole
    // chain into the browser bundle and broke the production build.
    // Comments stripped first: the module EXPLAINS this rule, and a plain grep
    // finds the explanation.
    const policy = codeOnly(source('src/lib/merchant/staff-policy.ts'));
    expect(policy).not.toMatch(/next\/headers|@\/lib\/prisma|lib\/auth\/session/);
  });

  it('keeps client components off the server-only access module', () => {
    for (const file of ['src/components/merchant/StaffManager.tsx']) {
      const code = source(file);
      expect(code).toMatch(/^'use client';/);
      expect(code, `${file} imports the server-only access module`).not.toMatch(
        /from '@\/lib\/merchant\/access'/,
      );
    }
  });

  it('resolves the actor’s role from the session, never from the form', () => {
    // The store id arrives in a form field and is used only to LOOK UP the
    // caller's own membership. A field cannot buy access to a store somebody
    // is not in.
    const actions = codeOnly(source('src/lib/actions/staff-actions.ts'));
    for (const name of [
      'inviteStaffAction',
      'changeStaffRoleAction',
      'removeStaffAction',
      'revokeStaffInviteAction',
    ]) {
      const start = actions.indexOf(`export async function ${name}`);
      const body = actions.slice(start, start + 900);
      expect(body, `${name} does not resolve access`).toMatch(/requireStoreAccess\(/);
      expect(body, `${name} trusts a role from the form`).not.toMatch(
        /actorRole: [^a]/,
      );
    }
  });

  it('prunes lapsed invitations from the sweep', () => {
    const maintenance = codeOnly(source('src/lib/orders/maintenance.ts'));
    expect(maintenance).toMatch(/await pruneExpiredInvites\(\)/);
  });

  it('never nests a table inside the console’s table wrapper', () => {
    // `TableScroll` renders the `<table>` itself. Putting another one inside is
    // invalid nesting, and the browser relocates it — which shows up as a
    // hydration mismatch and a table that ignores the console's own sizing.
    // Both of the pages added with this feature had it, and nothing but a real
    // browser found it.
    const pages = globSync('src/app/admin/**/page.tsx');
    expect(pages.length).toBeGreaterThan(4);
    for (const file of pages) {
      const code = codeOnly(source(file));
      const wrapped = code.split('<TableScroll>').slice(1);
      for (const section of wrapped) {
        const upToClose = section.slice(0, section.indexOf('</TableScroll>'));
        expect(upToClose, `${file} nests a <table> inside TableScroll`).not.toMatch(
          /<table/,
        );
      }
    }
  });

  it('shows the staff screen in the shop’s own tabs', () => {
    // Asked of the map the tab bar renders from, rather than of a template
    // literal inside the component — the list moved to `merchant/roles.ts` so
    // one place decides which role reaches which screen, and this broke for no
    // behavioural reason.
    expect(tabsFor(StoreRole.STAFF).map((tab) => tab.path)).toContain('staff');
  });
});
