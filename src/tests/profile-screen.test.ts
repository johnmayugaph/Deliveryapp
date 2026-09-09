import { readFileSync } from 'node:fs';
import { SubscriptionStatus, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  BENEFIT_CONFERRING_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
  benefitsAreOn,
  planRow,
  planStanding,
  type PlanStanding,
  type SubscriptionTerm,
} from '@/lib/subscriptions/billing-policy';
import {
  BENEFIT_CONFERRING_STATUSES as REEXPORTED_CONFERRING,
  LIVE_SUBSCRIPTION_STATUSES as REEXPORTED_LIVE,
} from '@/lib/subscriptions/enrollment';
import { fleetRow, fleetStanding, type FleetFacts } from '@/lib/fleet/standing';
import { permitsWorkOn } from '@/lib/fleet/verification-policy';
import {
  DEVICE_LIST_LIMIT,
  LAST_SEEN_LAG_DAYS,
  REFRESH_WHEN_REMAINING_DAYS,
  SESSION_TTL_DAYS,
  describeLastUse,
  describeLastUsePrecision,
  describeRevoke,
  deviceRows,
  lastUseOf,
  notListedCount,
} from '@/lib/auth/devices';
import { countOf } from '@/lib/text/count';
import { formatCentavos } from '@/lib/money';
import { formatFullDayIn } from '@/lib/time/manila';

/**
 * The profile screen made claims about three subsystems it does not own, and
 * had drifted from all three. Every test here is one of those claims.
 */

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = new Date('2026-09-09T06:00:00.000Z'); // 2pm Manila
const LATER = new Date('2026-10-09T06:00:00.000Z');
const EARLIER = new Date('2026-09-01T06:00:00.000Z');

const day = formatFullDayIn;

// -----------------------------------------------------------------------------
// The plan row
// -----------------------------------------------------------------------------

type Term = SubscriptionTerm & { planName: string };

const term = (over: Partial<Term> = {}): Term => ({
  status: SubscriptionStatus.ACTIVE,
  renewsAt: LATER,
  endedAt: null,
  planIsLaunched: true,
  planName: 'TARA Plus',
  ...over,
});

const standingFor = (over: Partial<Term> = {}): PlanStanding =>
  planStanding({ launchedPlanName: 'TARA Plus', subscription: term(over), now: NOW })!;

describe('whether a subscription confers anything', () => {
  it('says yes only for a paid, in-term, launched, ACTIVE enrolment', () => {
    expect(benefitsAreOn(term(), NOW)).toBe(true);
  });

  it.each([
    ['not yet paid', { status: SubscriptionStatus.PENDING_PAYMENT }],
    ['a bill went unpaid', { status: SubscriptionStatus.PAST_DUE }],
    ['the term ran out', { renewsAt: EARLIER }],
    ['the enrolment is over', { endedAt: EARLIER }],
    ['the plan was pulled', { planIsLaunched: false }],
  ])('says no when %s', (_why, over) => {
    expect(benefitsAreOn(term(over), NOW)).toBe(false);
  });

  it('agrees with the status list, for every status in the enum', () => {
    /**
     * Not a list of cases: the loop covers the whole enum, so a sixth status
     * cannot be added and silently confer benefits — or silently stop.
     */
    for (const status of Object.values(SubscriptionStatus)) {
      expect(benefitsAreOn(term({ status }), NOW)).toBe(
        BENEFIT_CONFERRING_STATUSES.includes(status),
      );
    }
  });

  it('exactly one status confers, and three hold the live slot', () => {
    // Guards against the loop above being vacuous by agreeing with an empty
    // or an all-inclusive list.
    expect(BENEFIT_CONFERRING_STATUSES).toEqual([SubscriptionStatus.ACTIVE]);
    expect(LIVE_SUBSCRIPTION_STATUSES).toHaveLength(3);
    expect(LIVE_SUBSCRIPTION_STATUSES).toContain(SubscriptionStatus.PENDING_PAYMENT);
  });

  it('is still reachable from where it used to live', () => {
    // The constants moved into the pure module so a screen could ask the
    // question without importing the enrolment writer. Every existing caller
    // reads them from `enrollment.ts`, so the re-export is load-bearing.
    expect(REEXPORTED_LIVE).toBe(LIVE_SUBSCRIPTION_STATUSES);
    expect(REEXPORTED_CONFERRING).toBe(BENEFIT_CONFERRING_STATUSES);
  });

  it('checks every condition the pricing engine filters on', () => {
    /**
     * The four are copied off `getActiveSubscription`'s `where` clause, which
     * is what actually stands between a customer and a discount. `/plus`
     * checked two of them.
     */
    const engine = codeOnly('src/lib/pricing/checkout.ts');
    const gate = engine.slice(engine.indexOf('getActiveSubscription'));
    expect(gate).toMatch(/status: SubscriptionStatus\.ACTIVE/);
    expect(gate).toMatch(/renewsAt: \{ gt: new Date\(\) \}/);
    expect(gate).toMatch(/endedAt: null/);
    expect(gate).toMatch(/plan: \{ isActive: true \}/);
  });
});

describe('where somebody stands with the plan', () => {
  it('is nothing at all when no plan is open and nobody is enrolled', () => {
    expect(planStanding({ launchedPlanName: null, subscription: null, now: NOW })).toBeNull();
  });

  it('is an invitation when a plan is open and they are not on it', () => {
    expect(
      planStanding({ launchedPlanName: 'TARA Plus', subscription: null, now: NOW }),
    ).toEqual({ kind: 'OPEN', name: 'TARA Plus' });
  });

  it('is ON for a paid, in-term enrolment', () => {
    expect(standingFor()).toEqual({ kind: 'ON', name: 'TARA Plus', paidUntil: LATER });
  });

  it('is UNPAID_FIRST before the first transfer lands', () => {
    // THE defect. `/plus` labels this "Waiting for payment" with a comment
    // saying it is deliberately not "Active". `/profile` said "Aktibo".
    expect(standingFor({ status: SubscriptionStatus.PENDING_PAYMENT }).kind).toBe(
      'UNPAID_FIRST',
    );
  });

  it('is UNPAID once a bill has gone unpaid', () => {
    expect(standingFor({ status: SubscriptionStatus.PAST_DUE }).kind).toBe('UNPAID');
  });

  it('is ENDED for an ACTIVE row whose paid month has run out', () => {
    // The reading no screen caught: benefits end with the term, not with the
    // sweep that tidies up after it.
    expect(standingFor({ renewsAt: EARLIER })).toEqual({
      kind: 'ENDED',
      name: 'TARA Plus',
      endedOn: EARLIER,
    });
    expect(standingFor({ endedAt: EARLIER }).kind).toBe('ENDED');
  });

  it('is PAUSED when the plan behind it was withdrawn, whatever the status', () => {
    expect(standingFor({ planIsLaunched: false })).toEqual({
      kind: 'PAUSED',
      name: 'TARA Plus',
    });
    // Outranks an otherwise perfectly active enrolment.
    expect(standingFor({ planIsLaunched: false, status: SubscriptionStatus.ACTIVE }).kind).toBe(
      'PAUSED',
    );
  });

  it('names the plan the person is ON, not the one that happens to be open', () => {
    const standing = planStanding({
      launchedPlanName: 'TARA Plus',
      subscription: term({ planName: 'TARA Plus Legacy' }),
      now: NOW,
    });
    expect(standing).toMatchObject({ name: 'TARA Plus Legacy' });
  });
});

describe('what the plan row says', () => {
  const row = (over: Partial<Term> = {}) =>
    planRow({
      standing: standingFor(over),
      bill: null,
      formatMoney: formatCentavos,
      formatDay: day,
    });

  it('says "Aktibo hanggang" for the one reading where it is true', () => {
    expect(row().note).toBe(`Aktibo hanggang ${day(LATER)}`);
  });

  it('never says it for any reading where it is not', () => {
    /**
     * The whole point, as an invariant over the union rather than a list: if a
     * seventh standing is added and it reuses the reassuring word, this fails.
     */
    const others: PlanStanding[] = [
      { kind: 'OPEN', name: 'P' },
      { kind: 'UNPAID_FIRST', name: 'P' },
      { kind: 'UNPAID', name: 'P' },
      { kind: 'ENDED', name: 'P', endedOn: EARLIER },
      { kind: 'PAUSED', name: 'P' },
    ];
    for (const standing of others) {
      const note = planRow({
        standing,
        bill: null,
        formatMoney: formatCentavos,
        formatDay: day,
      }).note;
      expect(note.toLowerCase()).not.toContain('aktibo hanggang');
    }
  });

  it('marks the two unpaid readings as needing attention, and not the others', () => {
    expect(row({ status: SubscriptionStatus.PENDING_PAYMENT }).needsAttention).toBe(true);
    expect(row({ status: SubscriptionStatus.PAST_DUE }).needsAttention).toBe(true);
    expect(row({ renewsAt: EARLIER }).needsAttention).toBe(true);
    expect(row().needsAttention).toBe(false);
    // Withdrawing a plan is ours to answer for, not theirs to act on.
    expect(row({ planIsLaunched: false }).needsAttention).toBe(false);
  });

  it('says a paused plan is not being billed for', () => {
    expect(row({ planIsLaunched: false }).note).toMatch(/not billed/i);
  });

  it('has no bill line when nothing is owed', () => {
    expect(row().bill).toBeNull();
  });

  it('names an amount AND a date when something is owed', () => {
    // An amount with no date is not something anybody can act on — the same
    // reason `manilaDateLabel` exists rather than "in 7 days".
    const line = planRow({
      standing: standingFor({ status: SubscriptionStatus.PAST_DUE }),
      bill: { amountCentavos: 9_900, dueAt: LATER, state: 'OVERDUE' },
      formatMoney: formatCentavos,
      formatDay: day,
    }).bill;
    expect(line).toContain('₱99.00');
    expect(line).toContain('Overdue');
    expect(line).toMatch(/October/);
  });
});

describe('the two screens that render a plan', () => {
  const profile = codeOnly('src/app/profile/page.tsx');
  const plus = codeOnly('src/app/plus/page.tsx');

  it('the profile row goes through the rule', () => {
    expect(profile).toMatch(/planStanding\(/);
    expect(profile).toMatch(/planRow\(/);
  });

  it('the profile row no longer spells the reassurance by hand', () => {
    // The exact string that was true of one live status out of three.
    expect(profile).not.toMatch(/Aktibo hanggang \$\{/);
  });

  it('/plus reads the same predicate rather than its own two conditions', () => {
    expect(plus).toMatch(/benefitsAreOn\(/);
    expect(plus).not.toMatch(/BENEFIT_CONFERRING_STATUSES\.includes/);
    // And the paused banner is about THIS subscription's plan, not about
    // whether any plan happens to be launched.
    expect(plus).toMatch(/benefitsPaused = subscription !== null && !subscription\.plan\.isActive/);
  });

  it('resolves the clock once for the whole render', () => {
    expect(profile).toMatch(/const renderedAt = new Date\(\);/);
    expect(profile).not.toMatch(/planStanding\([^)]*new Date\(\)/);
  });
});

// -----------------------------------------------------------------------------
// The fleet row
// -----------------------------------------------------------------------------

const approved = (expiresAt: Date | null = null) => ({
  status: VerificationStatus.APPROVED,
  expiresAt,
});
const pending = { status: VerificationStatus.PENDING, expiresAt: null };
const rejected = { status: VerificationStatus.REJECTED, expiresAt: null };

const partner = (over: Partial<FleetFacts> = {}): FleetFacts => ({
  isSuspended: false,
  isOnline: false,
  serviceVerifications: [],
  ...over,
});

describe('where a fleet partner stands', () => {
  it('is an invitation when there is no partner record', () => {
    expect(fleetStanding(null, NOW)).toEqual({ kind: 'NOT_A_PARTNER' });
    expect(fleetRow(fleetStanding(null, NOW)).href).toBe('/fleet/apply');
  });

  it('is SUSPENDED whatever the approvals say', () => {
    /**
     * THE defect. Suspension deliberately leaves every approval intact, so
     * `enabledServices` stays populated — and the row counted that array.
     * `setPartnerSuspended`'s own comment names this failure.
     */
    const standing = fleetStanding(
      partner({ isSuspended: true, serviceVerifications: [approved(), approved()] }),
      NOW,
    );
    expect(standing).toEqual({ kind: 'SUSPENDED' });
    expect(fleetRow(standing).note).not.toMatch(/Approved/);
    expect(fleetRow(standing).needsAttention).toBe(true);
  });

  it('is WORKING with a count when an approval is in force', () => {
    expect(fleetStanding(partner({ serviceVerifications: [approved()] }), NOW)).toEqual({
      kind: 'WORKING',
      approved: 1,
      waiting: 0,
      isOnline: false,
    });
  });

  it('is EXPIRED, not WORKING, once the documents run out', () => {
    // `enabledServices` is resynced only when somebody decides something, so
    // the copy outlives the licence. Reading the row asks the live question.
    const standing = fleetStanding(
      partner({ serviceVerifications: [approved(EARLIER)] }),
      NOW,
    );
    expect(standing).toEqual({ kind: 'EXPIRED' });
    expect(fleetRow(standing).note).toMatch(/expired/i);
    expect(fleetRow(standing).needsAttention).toBe(true);
  });

  it('is WAITING when an application is with us', () => {
    expect(fleetStanding(partner({ serviceVerifications: [pending] }), NOW)).toEqual({
      kind: 'WAITING',
      waiting: 1,
    });
  });

  it('is REFUSED once a decision has gone against them', () => {
    /**
     * The second defect: a refused applicant read "Awaiting approval", because
     * nothing distinguishes PENDING from REJECTED in a count of zero. Being
     * told to keep waiting for a decision that has already been taken is
     * worse than being told nothing.
     */
    const standing = fleetStanding(partner({ serviceVerifications: [rejected] }), NOW);
    expect(standing).toEqual({ kind: 'REFUSED' });
    expect(fleetRow(standing).note).not.toMatch(/wait|pending/i);
    // And it points at the screen carrying the reason, not at the offers board.
    expect(fleetRow(standing).href).toBe('/fleet/profile');
  });

  it('reads a suspended approval as refused rather than as approved', () => {
    // A per-service SUSPENDED is a decision, distinct from the partner-level
    // suspension above.
    expect(
      fleetStanding(
        partner({
          serviceVerifications: [{ status: VerificationStatus.SUSPENDED, expiresAt: null }],
        }),
        NOW,
      ).kind,
    ).toBe('REFUSED');
  });

  it('is NOT_APPLIED for a partner with nothing submitted', () => {
    expect(
      fleetStanding(
        partner({
          serviceVerifications: [{ status: VerificationStatus.NOT_SUBMITTED, expiresAt: null }],
        }),
        NOW,
      ).kind,
    ).toBe('NOT_APPLIED');
  });

  it('mentions a pending application beside a working approval', () => {
    // "we have it" rather than "we forgot you", on the row that would
    // otherwise say only that one service is approved.
    const standing = fleetStanding(
      partner({ serviceVerifications: [approved(), pending] }),
      NOW,
    );
    expect(standing).toMatchObject({ kind: 'WORKING', approved: 1, waiting: 1 });
    expect(fleetRow(standing).note).toContain('1 pending');
  });

  it('counts approvals the way the sync does, and no other way', () => {
    /**
     * The agreement that makes reading the rows safe. `syncEnabledServices`
     * builds the array dispatch queries from; if this counted differently the
     * screen would be a second truth about who can work.
     */
    const rows = [
      approved(),
      approved(LATER),
      approved(EARLIER),
      pending,
      rejected,
      { status: VerificationStatus.NOT_SUBMITTED, expiresAt: null },
    ];
    const bySync = rows.filter((row) => permitsWorkOn(row, NOW)).length;
    expect(bySync).toBe(2); // not vacuous: two in force, one expired
    expect(fleetStanding(partner({ serviceVerifications: rows }), NOW)).toMatchObject({
      kind: 'WORKING',
      approved: bySync,
    });
  });

  it('says online only when they are', () => {
    const on = fleetStanding(
      partner({ isOnline: true, serviceVerifications: [approved()] }),
      NOW,
    );
    expect(fleetRow(on).note).toContain('online');
    expect(fleetRow(fleetStanding(partner({ serviceVerifications: [approved()] }), NOW)).note)
      .not.toContain('online');
  });

  it('counts in words that agree with the number', () => {
    const one = fleetRow(fleetStanding(partner({ serviceVerifications: [approved()] }), NOW));
    const two = fleetRow(
      fleetStanding(partner({ serviceVerifications: [approved(), approved()] }), NOW),
    );
    expect(one.note).toContain('1 service');
    expect(one.note).not.toContain('1 services');
    expect(two.note).toContain('2 services');
  });
});

describe('the one predicate for "can work today"', () => {
  it('needs the status AND the expiry', () => {
    expect(permitsWorkOn(approved(), NOW)).toBe(true);
    expect(permitsWorkOn(approved(LATER), NOW)).toBe(true);
    expect(permitsWorkOn(approved(EARLIER), NOW)).toBe(false);
    expect(permitsWorkOn(pending, NOW)).toBe(false);
  });

  it('treats the exact expiry moment as over', () => {
    expect(permitsWorkOn(approved(NOW), NOW)).toBe(false);
  });

  it('is what the sync filters on, rather than a where clause plus a filter', () => {
    const dispatch = codeOnly('src/lib/fleet/dispatch.ts');
    const sync = dispatch.slice(dispatch.indexOf('export async function syncEnabledServices'));
    expect(sync).toMatch(/permitsWorkOn\(row, now\)/);
    // The split that made the expiry rule real in one place and invisible
    // everywhere else.
    expect(sync).not.toMatch(/status: VerificationStatus\.APPROVED/);
    expect(sync).not.toMatch(/row\.expiresAt === null \|\| row\.expiresAt > now/);
  });

  it('the profile row reads the rows, not the denormalised copy', () => {
    const profile = codeOnly('src/app/profile/page.tsx');
    expect(profile).toMatch(/fleetStanding\(fleetPartner, renderedAt\)/);
    expect(profile).not.toMatch(/enabledServices/);
    // The nested join that was loaded to render a number, gone with it.
    expect(profile).not.toMatch(/serviceVerifications: \{ include:/);
  });
});

// -----------------------------------------------------------------------------
// The device list
// -----------------------------------------------------------------------------

describe('how stale "last used" can be', () => {
  it('is derived from the window, not chosen', () => {
    expect(LAST_SEEN_LAG_DAYS).toBe(SESSION_TTL_DAYS - REFRESH_WHEN_REMAINING_DAYS);
    expect(LAST_SEEN_LAG_DAYS).toBe(5);
  });

  it('is stated to the reader, in that derived number', () => {
    expect(describeLastUsePrecision()).toContain(String(LAST_SEEN_LAG_DAYS));
  });

  it('has no hand-typed count in the sentence to rot', () => {
    /**
     * Prose about a gate outliving the gate is the fourth instance of this in
     * the project. Moving the refresh threshold has to move the copy.
     */
    const source = readFileSync('src/lib/auth/devices.ts', 'utf8');
    const sentence = source.slice(source.indexOf('export function describeLastUsePrecision'));
    expect(sentence).toMatch(/\$\{LAST_SEEN_LAG_DAYS\}/);
    expect(sentence).not.toMatch(/every 5 days/);
  });

  it('session.ts keeps no second copy of the two numbers', () => {
    const session = readFileSync('src/lib/auth/session.ts', 'utf8');
    expect(session).toMatch(/from '@\/lib\/auth\/devices'/);
    expect(session).not.toMatch(/const SESSION_TTL_DAYS = /);
    expect(session).not.toMatch(/const REFRESH_WHEN_REMAINING_DAYS = /);
  });

  it('the module stays pure — a client component imports it', () => {
    const source = readFileSync('src/lib/auth/devices.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});

describe('what a row says about last use', () => {
  const STALE = new Date('2026-09-04T06:00:00.000Z'); // five days before NOW

  it('says the current session is in use now, whatever the column says', () => {
    /**
     * THE test. `lastSeenAt` is bumped at most once every
     * LAST_SEEN_LAG_DAYS days, so the row for the session RENDERING THE
     * SCREEN read "Last used Sep 4" while somebody was looking at it.
     */
    const state = lastUseOf({ lastSeenAt: STALE, isCurrent: true });
    expect(state).toEqual({ kind: 'NOW' });
    const text = describeLastUse(state, day);
    expect(text).toBe('In use now');
    expect(text).not.toContain(day(STALE));
  });

  it('states a lower bound for every other session', () => {
    const state = lastUseOf({ lastSeenAt: STALE, isCurrent: false });
    expect(state).toEqual({ kind: 'SINCE', at: STALE });
    // "since", not "on": used at least this recently, and possibly since.
    expect(describeLastUse(state, day)).toBe(`Used since ${day(STALE)}`);
  });

  it('never claims a session has not been used', () => {
    /**
     * There is arithmetic that bounds last use from above — a use after
     * `lastSeenAt + LAST_SEEN_LAG_DAYS` would have refreshed the row — and it
     * is deliberately not rendered. It rests on a fire-and-forget write, and
     * the direction it would be wrong in is the one that makes a live intruder
     * look dormant.
     */
    for (const isCurrent of [true, false]) {
      const text = describeLastUse(lastUseOf({ lastSeenAt: STALE, isCurrent }), day);
      expect(text).not.toMatch(/not used|dormant|inactive/i);
    }
  });

  it('puts the exact date on the row: when the session started', () => {
    // `createdAt` was in the summary, returned by the query, and rendered
    // nowhere — and it is the fact the screen is for.
    const [row] = deviceRows([
      {
        id: 's1',
        createdAt: EARLIER,
        lastSeenAt: STALE,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
        isCurrent: true,
      },
    ]);
    expect(row!.signedInAt).toBe(EARLIER);
    expect(row!.device).toBe('iPhone o iPad');
    expect(row!.isCurrent).toBe(true);
  });
});

describe('the revoke control', () => {
  it('is absent when there is nothing else to sign out', () => {
    expect(describeRevoke(0, countOf)).toBeNull();
  });

  it('counts in words that agree with the number', () => {
    expect(describeRevoke(1, countOf)).toBe('Sign out of 1 other device');
    expect(describeRevoke(3, countOf)).toBe('Sign out of 3 other devices');
  });

  it('reports what the list is hiding', () => {
    // The cap was a display limit read as a promise about what the tap did.
    expect(notListedCount(DEVICE_LIST_LIMIT, 25)).toBe(6);
    expect(notListedCount(3, 2)).toBe(0);
    // Never negative: the count and the page are read a moment apart.
    expect(notListedCount(5, 0)).toBe(0);
  });

  it('counts and revokes through one predicate', () => {
    /**
     * The button said "Sign out of 2 other devices" off a live count while
     * `revokeOtherSessions` reported everything it touched, expired rows
     * included — so the confirmation could say seven.
     */
    const session = codeOnly('src/lib/auth/session.ts');
    expect(session).toMatch(/where: await otherLiveSessions\(userId\)/);
    expect(session).toMatch(/count\(\{ where: await otherLiveSessions\(userId\) \}\)/);
    const predicate = session.slice(session.indexOf('async function otherLiveSessions'));
    expect(predicate).toMatch(/expiresAt: \{ gt: new Date\(\) \}/);
  });

  it('lists sessions by when they started, so the current one cannot fall off', () => {
    // Ordering on the lazily-bumped column put a session in constant use
    // below one abandoned a week ago.
    const session = codeOnly('src/lib/auth/session.ts');
    expect(session).toMatch(/orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/);
    expect(session).toMatch(/take: DEVICE_LIST_LIMIT/);
  });
});

describe('the device list renders through the rule', () => {
  const component = codeOnly('src/components/auth/ActiveSessions.tsx');

  it('reaches every date and count through the module', () => {
    expect(component).toMatch(/deviceRows\(/);
    expect(component).toMatch(/describeLastUse\(/);
    expect(component).toMatch(/describeRevoke\(/);
    expect(component).toMatch(/describeLastUsePrecision\(\)/);
  });

  it('no longer prints the label that was wrong', () => {
    expect(component).not.toMatch(/Last used/);
  });

  it('holds no second copy of the device sniffing', () => {
    expect(component).not.toMatch(/function describeDevice/);
  });
});

// -----------------------------------------------------------------------------
// Counting things out loud
// -----------------------------------------------------------------------------

describe('counting out loud', () => {
  it.each([
    [0, '0 services'],
    [1, '1 service'],
    [2, '2 services'],
  ])('%i → %s', (n, expected) => {
    expect(countOf(n, 'service')).toBe(expected);
  });

  it('takes an irregular plural where English needs one', () => {
    expect(countOf(2, 'entry', 'entries')).toBe('2 entries');
    expect(countOf(1, 'entry', 'entries')).toBe('1 entry');
  });

  it('pluralises the head of a phrase, not the tail', () => {
    // "other device" → "other devices", which is why the singular is passed
    // whole rather than assembled at the call site.
    expect(countOf(2, 'other device')).toBe('2 other devices');
  });

  it('imports nothing at all', () => {
    expect(readFileSync('src/lib/text/count.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
