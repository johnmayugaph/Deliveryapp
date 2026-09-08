import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdminAction,
  NotificationChannel,
  NotificationKind,
  ServiceKey,
  VerificationStatus,
} from '@prisma/client';
import {
  DECIDABLE_STATUSES,
  VERIFICATION_STATUS_CLASSES,
  VERIFICATION_STATUS_LABEL,
  canDecide,
  describeDecision,
  describeWait,
  isDecision,
  isWaitingOnUs,
  permitsWork,
  queueRank,
  reasonReachesThePartner,
} from '@/lib/fleet/verification-policy';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Rider approval, decided in the console.
 *
 * The rule every test here circles is the one the data model already states
 * and a screen can quietly break: **approval is per service.** Cleared to
 * carry food is not cleared to carry a passenger, and the console must not be
 * able to say otherwise — not by approving two verticals at once, and not by
 * approving one nobody applied for.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

describe('every status has a word and a colour', () => {
  it('labels all of them, so a sixth status is a compile error', () => {
    for (const status of Object.values(VerificationStatus)) {
      expect(VERIFICATION_STATUS_LABEL[status]).toBeTruthy();
      expect(VERIFICATION_STATUS_LABEL[status]).not.toBe(status);
      expect(VERIFICATION_STATUS_CLASSES[status]).toBeTruthy();
    }
  });

  it('is the only place those words live', () => {
    // They used to be declared in the rider's own screen. A console showing a
    // different word for the same row is how a support call starts.
    const profile = codeOnly('src/app/fleet/profile/page.tsx');
    expect(profile).not.toMatch(/const STATUS_LABELS/);
    expect(profile).toContain('VERIFICATION_STATUS_LABEL');
  });
});

describe('what the console may decide', () => {
  it('offers approve, refuse and suspend — and nothing else', () => {
    expect([...DECIDABLE_STATUSES].sort()).toEqual(
      [
        VerificationStatus.APPROVED,
        VerificationStatus.REJECTED,
        VerificationStatus.SUSPENDED,
      ].sort(),
    );
  });

  it('refuses a decision that is not one of those', () => {
    // PENDING is the partner's own act and NOT_SUBMITTED is the absence of an
    // application; neither is something the console gets to assert.
    expect(isDecision(VerificationStatus.PENDING)).toBe(false);
    expect(isDecision(VerificationStatus.NOT_SUBMITTED)).toBe(false);
    expect(isDecision('DEFINITELY_FINE')).toBe(false);
    for (const status of DECIDABLE_STATUSES) {
      expect(isDecision(status)).toBe(true);
    }
  });

  it('will not decide an application nobody made', () => {
    expect(canDecide(VerificationStatus.NOT_SUBMITTED)).toBe(false);
    // Everything else can be revisited: an approval withdrawn and a refusal
    // reconsidered are both real, and both leave an audit row.
    for (const status of Object.values(VerificationStatus)) {
      if (status !== VerificationStatus.NOT_SUBMITTED) {
        expect(canDecide(status), status).toBe(true);
      }
    }
  });

  it('lets exactly one status permit work', () => {
    const permitted = Object.values(VerificationStatus).filter(permitsWork);
    expect(permitted).toEqual([VerificationStatus.APPROVED]);
  });

  it('demands a reason for the two that are bad news', () => {
    // The reason is shown to the applicant — it is the only thing that tells
    // them what to fix, so a refusal without one is a dead end.
    expect(reasonReachesThePartner(VerificationStatus.REJECTED)).toBe(true);
    expect(reasonReachesThePartner(VerificationStatus.SUSPENDED)).toBe(true);
    expect(reasonReachesThePartner(VerificationStatus.APPROVED)).toBe(false);
  });
});

describe('the queue', () => {
  const base = { submittedAt: null, createdAt: new Date('2026-01-01T00:00:00Z') };

  it('puts the people waiting on us first', () => {
    const pending = queueRank({ ...base, status: VerificationStatus.PENDING });
    const decided = queueRank({ ...base, status: VerificationStatus.APPROVED });
    expect(pending).toBeLessThan(decided);
  });

  it('works the oldest application first', () => {
    // A queue sorted newest-first is how somebody who applied on Monday is
    // still waiting on Friday.
    const monday = queueRank({
      status: VerificationStatus.PENDING,
      submittedAt: new Date('2026-01-05T08:00:00Z'),
      createdAt: new Date('2026-01-05T08:00:00Z'),
    });
    const friday = queueRank({
      status: VerificationStatus.PENDING,
      submittedAt: new Date('2026-01-09T08:00:00Z'),
      createdAt: new Date('2026-01-09T08:00:00Z'),
    });
    expect(monday).toBeLessThan(friday);
  });

  it('falls back to when the row appeared if nothing was submitted', () => {
    const withSubmission = queueRank({
      status: VerificationStatus.PENDING,
      submittedAt: new Date('2026-01-02T00:00:00Z'),
      createdAt: new Date('2026-01-09T00:00:00Z'),
    });
    const withoutSubmission = queueRank({
      status: VerificationStatus.PENDING,
      submittedAt: null,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    expect(withSubmission).toBeLessThan(withoutSubmission);
  });

  it('counts only PENDING as waiting on us', () => {
    const waiting = Object.values(VerificationStatus).filter(isWaitingOnUs);
    expect(waiting).toEqual([VerificationStatus.PENDING]);
  });
});

describe('how long somebody has been waiting', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('reads in minutes, then hours, then days', () => {
    expect(describeWait(ago(5), now)).toBe('5m');
    expect(describeWait(ago(90), now)).toBe('1h');
    expect(describeWait(ago(60 * 47), now)).toBe('47h');
    expect(describeWait(ago(60 * 72), now)).toBe('3d');
  });

  it('never reads as negative on a clock that disagrees', () => {
    expect(describeWait(new Date(now.getTime() + 60_000), now)).toBe('0m');
  });
});

describe('what the partner is told', () => {
  it('names the service, because "approved" alone is not actionable', () => {
    // A partner can hold three applications at three different stages.
    const message = describeDecision({
      status: VerificationStatus.APPROVED,
      serviceName: 'Kainan',
    });
    expect(message).toContain('Kainan');
  });

  it('carries a refusal reason verbatim', () => {
    const message = describeDecision({
      status: VerificationStatus.REJECTED,
      serviceName: 'Kainan',
      reason: 'The licence photo is expired',
    });
    expect(message).toContain('The licence photo is expired');
  });

  it('still says something useful with no reason', () => {
    const message = describeDecision({
      status: VerificationStatus.REJECTED,
      serviceName: 'Kainan',
      reason: null,
    });
    expect(message).toContain('Kainan');
    expect(message).not.toMatch(/null|undefined/);
  });

  it('answers every status, so a new one cannot fall through', () => {
    for (const status of Object.values(VerificationStatus)) {
      const message = describeDecision({ status, serviceName: 'Kainan' });
      expect(message, status).toBeTruthy();
    }
  });
});

describe('the notification', () => {
  it('reaches the inbox and a closed tab, and never costs a peso', () => {
    const policy = KIND_POLICY[NotificationKind.FLEET_VERIFICATION_DECIDED];
    expect(policy.channels).toContain(NotificationChannel.IN_APP);
    expect(policy.channels).toContain(NotificationChannel.PUSH);
    // Arguable — it unlocks somebody's income — but they applied from inside
    // this app, so the free channels reach them.
    expect(policy.channels).not.toContain(NotificationChannel.SMS);
  });

  it('names the service in the title either way', () => {
    for (const approved of [true, false]) {
      const rendered = renderNotification(NotificationKind.FLEET_VERIFICATION_DECIDED, {
        serviceName: 'Kainan',
        verificationApproved: approved,
      });
      expect(rendered.title).toContain('Kainan');
      expect(rendered.body).not.toMatch(/undefined|null/);
    }
  });

  it('tells a refused partner why', () => {
    const rendered = renderNotification(NotificationKind.FLEET_VERIFICATION_DECIDED, {
      serviceName: 'Kainan',
      verificationApproved: false,
      reason: 'Unreadable photo',
    });
    expect(rendered.body).toContain('Unreadable photo');
  });

  it('reads sensibly when the service name is missing', () => {
    const rendered = renderNotification(NotificationKind.FLEET_VERIFICATION_DECIDED, {
      verificationApproved: true,
    });
    expect(rendered.body).not.toMatch(/undefined|null/);
  });
});

describe('the audit trail', () => {
  it('has a label for both new actions', () => {
    expect(ADMIN_ACTION_LABEL[AdminAction.FLEET_VERIFICATION_CHANGED]).toBeTruthy();
    expect(ADMIN_ACTION_LABEL[AdminAction.FLEET_SUSPENSION_CHANGED]).toBeTruthy();
  });

  it('separates a per-service decision from a blanket suspension', () => {
    // They are different judgements: whether the documents are good, and
    // whether somebody should be working at all today.
    expect(AdminAction.FLEET_VERIFICATION_CHANGED).not.toBe(
      AdminAction.FLEET_SUSPENSION_CHANGED,
    );
  });
});

describe('the decision layer', () => {
  const decisions = codeOnly('src/lib/fleet/verification.ts');

  it('reads the row instead of upserting one', () => {
    // An upsert is what the CLI does, and it is how you approve a vertical
    // nobody submitted documents for.
    expect(decisions).not.toMatch(/upsert/);
    expect(decisions).toMatch(/NotAnApplicationError/);
  });

  it('recalculates enabledServices rather than assigning it', () => {
    // Dispatch reads that array on every candidate query, so a value written
    // from what the caller intended is a quiet misroute.
    expect(decisions).toMatch(/syncEnabledServices\(/);
    expect(decisions).not.toMatch(/enabledServices:\s*\[/);
  });

  it('does all of it in one transaction, notification included', () => {
    expect(decisions).toMatch(/prisma\.\$transaction/);
    const body = decisions.slice(decisions.indexOf('$transaction'));
    expect(body).toMatch(/enqueueNotification\(/);
    expect(body).toMatch(/tx,/);
  });

  it('records who decided, on the row itself', () => {
    // The CLI never could: a shell has no identity. This is the difference
    // that matters when somebody asks who approved a rider.
    expect(decisions).toMatch(/decidedByUserId: input\.decidedByUserId/);
  });

  it('clears a stale refusal reason when approving', () => {
    // Otherwise the partner's screen shows last month's rejection text beside
    // the word "Approved".
    expect(decisions).toMatch(/rejectionReason: reasonReachesThePartner\(/);
  });

  it('takes a suspended partner offline', () => {
    // Left online, dispatch keeps considering and skipping them while their
    // own screen says they are working.
    const suspend = decisions.slice(decisions.indexOf('setPartnerSuspended'));
    expect(suspend).toMatch(/isOnline: false/);
  });
});

describe('the console actions', () => {
  const actions = codeOnly('src/lib/actions/admin-actions.ts');

  function body(name: string): string {
    const start = actions.indexOf(`export async function ${name}`);
    expect(start, `${name} is missing`).toBeGreaterThan(-1);
    const next = actions.indexOf('export async function', start + 1);
    return actions.slice(start, next === -1 ? undefined : next);
  }

  it('decides ONE service per submission', () => {
    // Not a list. A form that could send "approve" without naming a single
    // service is a form that will eventually approve the wrong one.
    const decide = body('decideFleetApplicationAction');
    expect(decide).toMatch(/serviceType/);
    expect(decide).not.toMatch(/serviceTypes|getAll\(/);
  });

  it('keeps this file’s two invariants: a reason and an audit row', () => {
    for (const name of ['decideFleetApplicationAction', 'setFleetSuspensionAction']) {
      const code = body(name);
      expect(code, name).toMatch(/requireAdmin\(\)/);
      expect(code, name).toMatch(/normaliseReason\(/);
      expect(code, name).toMatch(/recordAdminAction\(/);
    }
  });

  it('validates the service against the enum rather than trusting the form', () => {
    expect(body('decideFleetApplicationAction')).toMatch(/in ServiceKey/);
    expect(Object.keys(ServiceKey).length).toBeGreaterThan(1);
  });
});

describe('the screens', () => {
  it('has a fleet link in the console nav', () => {
    expect(source('src/app/admin/layout.tsx')).toContain('/admin/fleet');
  });

  it('shows the waiting count on the overview, including as a zero', () => {
    // A number that only appears when it is bad is one nobody learns to read.
    const overview = source('src/app/admin/page.tsx');
    expect(overview).toContain('countPendingApplications');
    expect(overview).toMatch(/waiting on approval/);
  });

  it('claims the partner was told only where a decider is recorded', () => {
    // A row decided by `npm run fleet:approve` has no decider and sent no
    // message. Saying "they were told" on it is a comfortable lie about
    // somebody who is still waiting to hear.
    const page = source('src/app/admin/fleet/[partnerId]/page.tsx');
    expect(page).toMatch(/application\.decidedBy\s*\n?\s*\?\s*` by \$\{application\.decidedBy\} · they were told`/);
    expect(page).toMatch(/nobody told them/);
  });

  it('names approved services from the registry, not the enum', () => {
    const page = source('src/app/admin/fleet/[partnerId]/page.tsx');
    expect(page).not.toMatch(/partner\.enabledServices\.join/);
    expect(page).toMatch(/application\.serviceName/);
  });

  it('refreshes the console after a decision', () => {
    // `revalidatePath` invalidates the SERVER's copy; the page the operator is
    // looking at was rendered before the click and a server action called from
    // a client function is not a navigation. Without this the row still says
    // "Pending" after being decided — found in a browser, and it applied to
    // every control in the console.
    const form = codeOnly('src/components/admin/ReasonForm.tsx');
    expect(form).toMatch(/router\.refresh\(\)/);
    expect(form).toMatch(/if \(result\?\.ok\)/);
  });

  it('says on the refusal form that the applicant reads it', () => {
    const page = source('src/app/admin/fleet/[partnerId]/page.tsx');
    expect(page).toMatch(/applicant is shown this reason/i);
  });

  it('never nests a table inside TableScroll', () => {
    // TableScroll renders the <table> itself; a second one inside it is
    // invalid nesting the browser silently relocates.
    for (const file of ['src/app/admin/fleet/page.tsx']) {
      const code = source(file);
      const inside = code.slice(code.indexOf('<TableScroll>'));
      expect(inside.slice(0, inside.indexOf('</TableScroll>'))).not.toContain('<table');
    }
  });

  it('points the CLI at the console rather than claiming there is none', () => {
    const script = source('scripts/approve-fleet-partner.ts');
    expect(script).toContain('/admin/fleet');
    expect(script).not.toMatch(/There is no admin UI/);
  });
});
