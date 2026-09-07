import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AdminAction, UserRole, type User } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTION_LABEL,
  AuditReasonRequiredError,
  MAX_ADJUSTMENT_CENTAVOS,
  MIN_AUDIT_REASON_LENGTH,
  isAdmin,
  normaliseReason,
} from '@/lib/admin/access';
import { startOfManilaDay } from '@/lib/admin/queries';

/** Just the fields `isAdmin` reads. */
function withRoles(roles: UserRole[]): Pick<User, 'roles'> {
  return { roles };
}

describe('who counts as an administrator', () => {
  it('requires the ADMIN role', () => {
    expect(isAdmin(withRoles([UserRole.ADMIN]))).toBe(true);
    expect(isAdmin(withRoles([UserRole.CUSTOMER]))).toBe(false);
  });

  it('does NOT accept SUPPORT_AGENT on its own', () => {
    // Support agents answer tickets. The console can move money and block
    // accounts, and those are not the same permission.
    expect(isAdmin(withRoles([UserRole.SUPPORT_AGENT]))).toBe(false);
  });

  it('accepts an admin who is also something else', () => {
    // Roles are an array precisely because one person is several things.
    expect(isAdmin(withRoles([UserRole.CUSTOMER, UserRole.ADMIN]))).toBe(true);
  });

  it('rejects nobody', () => {
    expect(isAdmin(null)).toBe(false);
  });
});

describe('the reason on an audit entry', () => {
  it('accepts something that could mean anything at all', () => {
    expect(normaliseReason('tkt 4821')).toBe('tkt 4821');
  });

  it('refuses a reason shorter than the minimum', () => {
    expect(() => normaliseReason('oops')).toThrow(AuditReasonRequiredError);
    expect(MIN_AUDIT_REASON_LENGTH).toBe(8);
  });

  it('refuses whitespace dressed up as a reason', () => {
    // "        " is eight characters and answers nothing. Trimming first is
    // what makes the length check mean something.
    expect(() => normaliseReason('        ')).toThrow(AuditReasonRequiredError);
    expect(() => normaliseReason('   .   ')).toThrow(AuditReasonRequiredError);
  });

  it('refuses a missing reason rather than storing an empty one', () => {
    expect(() => normaliseReason(undefined)).toThrow(AuditReasonRequiredError);
    expect(() => normaliseReason(null)).toThrow(AuditReasonRequiredError);
  });

  it('says what a useful reason looks like', () => {
    // The error is read by somebody who just had a form rejected, so it names
    // the three things that would satisfy it.
    expect(() => normaliseReason('')).toThrow(/ticket/);
  });

  it('trims, and caps at a length a column can hold', () => {
    expect(normaliseReason('  tkt 4821  ')).toBe('tkt 4821');
    expect(normaliseReason('x'.repeat(900))).toHaveLength(500);
  });
});

describe('every action kind has English', () => {
  it('labels all of them', () => {
    // Keyed by the whole enum, so a new privileged action cannot ship without
    // somebody writing the line the audit log will show.
    for (const action of Object.values(AdminAction)) {
      expect(ADMIN_ACTION_LABEL[action], action).toBeTruthy();
    }
  });
});

describe('the ceiling on a credits correction', () => {
  it('is ₱500, which is a correction rather than a promotion', () => {
    expect(MAX_ADJUSTMENT_CENTAVOS).toBe(50_000);
  });
});

describe('the console day starts at Manila midnight', () => {
  it('is 16:00 UTC the previous day', () => {
    // Everything on the overview is "today", and today in Manila is not today
    // in UTC for eight hours of every day. Getting this wrong makes the
    // morning numbers look like a crash.
    expect(startOfManilaDay(new Date('2026-09-07T03:00:00.000Z')).toISOString()).toBe(
      '2026-09-06T16:00:00.000Z',
    );
  });

  it('does not roll over early for a late-evening Manila time', () => {
    // 23:30 Manila on the 7th is 15:30 UTC on the 7th; the day still started
    // at 16:00 UTC on the 6th.
    expect(startOfManilaDay(new Date('2026-09-07T15:30:00.000Z')).toISOString()).toBe(
      '2026-09-06T16:00:00.000Z',
    );
  });

  it('rolls over at 16:00 UTC exactly', () => {
    expect(startOfManilaDay(new Date('2026-09-07T16:00:00.000Z')).toISOString()).toBe(
      '2026-09-07T16:00:00.000Z',
    );
  });
});

// -----------------------------------------------------------------------------
// Grep tests. These assert properties of the source that no unit test reaches:
// that authorisation is on every action, and that the audit trail cannot be
// bypassed. They are the kind of rule that is easy to break by adding one
// function that looks like the others.
// -----------------------------------------------------------------------------

const actionsSource = readFileSync(
  path.join(process.cwd(), 'src/lib/actions/admin-actions.ts'),
  'utf8',
);

/**
 * The source with comments and string literals removed.
 *
 * The grep rules below are about what the code DOES, so prose and user-facing
 * copy have to come out first — otherwise a rule against `withdraw` fires on a
 * comment explaining that withdrawing a service from a city switches it off.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Each exported action, with its body. */
function exportedActions(): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const pattern = /export async function (\w+Action)\(/g;
  for (const match of actionsSource.matchAll(pattern)) {
    const start = match.index ?? 0;
    const next = actionsSource.indexOf('\nexport async function', start + 1);
    found.push({
      name: match[1]!,
      body: actionsSource.slice(start, next === -1 ? undefined : next),
    });
  }
  return found;
}

describe('every console action is authorised and recorded', () => {
  const actions = exportedActions();

  it('finds the actions to check', () => {
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, body } of exportedActions()) {
    it(`${name} calls requireAdmin`, () => {
      // A server action is its own entry point. The layout's check does not
      // cover it and neither does middleware.
      expect(body).toMatch(/requireAdmin\(\)/);
    });

    it(`${name} demands a reason`, () => {
      expect(body).toMatch(/normaliseReason\(/);
    });

    it(`${name} writes an audit row`, () => {
      expect(body).toMatch(/recordAdminAction\(/);
    });
  }
});

describe('the console cannot touch a balance directly', () => {
  it('never writes balanceCentavos', () => {
    // The rule the whole credits design rests on: the ledger is the truth and
    // the balance is derived. One admin form that set a balance would break
    // reconciliation silently and permanently.
    expect(actionsSource).not.toMatch(/balanceCentavos\s*:/);
  });

  it('goes through recordAdjustment rather than the ledger table', () => {
    expect(actionsSource).toMatch(/recordAdjustment\(/);
    expect(actionsSource).not.toMatch(/walletTransaction\.(create|update|delete)/);
  });

  it('has no top-up, transfer or withdrawal', () => {
    // Checked against CODE, not prose: "withdraw a service from a city" is a
    // legitimate sentence in this file, and a grep that cannot tell it from
    // `withdrawCredits()` is a test that has to be weakened the first time
    // somebody writes a comment.
    for (const forbidden of ['topup', 'withdraw', 'cashout', 'transfer']) {
      expect(codeOnly(actionsSource).toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

describe('the audit trail is append-only in the database', () => {
  const guards = readFileSync(
    path.join(process.cwd(), 'prisma/sql/admin_audit.sql'),
    'utf8',
  );

  it('refuses UPDATE and DELETE with a trigger', () => {
    // Not a convention: an audit trail the people it describes can edit
    // answers no question worth asking.
    expect(guards).toMatch(/BEFORE UPDATE ON "AdminAuditEvent"/);
    expect(guards).toMatch(/BEFORE DELETE ON "AdminAuditEvent"/);
  });

  it('insists on a substantive reason at the table level', () => {
    expect(guards).toMatch(/char_length\(btrim\("reason"\)\) >= 8/);
  });

  it('is applied by the guard runner', () => {
    // The file is only worth anything if `npm run prisma:guards` picks it up,
    // which it does by reading the directory — so this checks it is there.
    expect(guards.length).toBeGreaterThan(0);
  });
});
