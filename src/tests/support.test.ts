import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NotificationChannel,
  NotificationKind,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@prisma/client';
import { parse } from 'yaml';
import {
  MAX_MESSAGE_LENGTH,
  MAX_SUBJECT_LENGTH,
  MessageTooShortError,
  PRIORITY_RANK,
  QUEUE_STATUSES,
  SUPPORT_RESPONSE_TARGET_MINUTES,
  TICKET_STATUS_POLICY,
  WAITING_STATUSES,
  customerMayReply,
  describeWait,
  needsChasing,
  normaliseMessage,
  normaliseSubject,
  priorityForNewTicket,
  statusAfterCustomerMessage,
  statusAfterSupportMessage,
  waitingMinutes,
} from '@/lib/support/policy';
import {
  contactDetails,
  contactPosture,
  describeContactPosture,
} from '@/lib/support/contact';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';
import { isPublicPath } from '@/middleware';

/**
 * Support: the ticket thread, and the path for somebody who cannot sign in.
 *
 * The property this whole feature exists for is the one at the bottom of this
 * file: a customer who has lost their number cannot raise a ticket, so the
 * ticket system alone leaves them with nothing. Everything above is the
 * machinery that makes the signed-in half not quietly lose people.
 */

function source(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

/** Comments blanked, so a docstring explaining a rule does not satisfy a grep for it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

// -----------------------------------------------------------------------------
// What a ticket's state means
// -----------------------------------------------------------------------------

describe('the status policy', () => {
  it('covers every status the database can hold', () => {
    // The map is typed `Record<SupportTicketStatus, …>`, so a missing key is a
    // compile error. This catches the other direction: a key that is no longer
    // a status, which would sit there unused and misleading.
    expect(Object.keys(TICKET_STATUS_POLICY).sort()).toEqual(
      Object.values(SupportTicketStatus).sort(),
    );
  });

  it('does not count a ticket waiting on the CUSTOMER as waiting on us', () => {
    // The whole point of the queue number. Counting these would make it
    // permanently red and teach whoever reads it to ignore it.
    expect(WAITING_STATUSES).not.toContain(SupportTicketStatus.AWAITING_CUSTOMER);
    expect(WAITING_STATUSES).toContain(SupportTicketStatus.OPEN);
    expect(WAITING_STATUSES).toContain(SupportTicketStatus.ESCALATED);
  });

  it('keeps finished tickets out of the queue', () => {
    expect(QUEUE_STATUSES).not.toContain(SupportTicketStatus.RESOLVED);
    expect(QUEUE_STATUSES).not.toContain(SupportTicketStatus.CLOSED);
    expect(QUEUE_STATUSES).toContain(SupportTicketStatus.OPEN);
  });

  it('lets somebody say "this did not actually fix it"', () => {
    // A resolved ticket still accepts a reply, and that reply puts it back in
    // the queue. Making somebody open a second ticket to report that the fix
    // failed is how the report gets lost.
    expect(customerMayReply(SupportTicketStatus.RESOLVED)).toBe(true);
    expect(statusAfterCustomerMessage(SupportTicketStatus.RESOLVED)).toBe(
      SupportTicketStatus.OPEN,
    );
  });

  it('takes a ticket out of AWAITING_CUSTOMER the moment they answer', () => {
    // Exactly the state in which tickets are forgotten: the agent is waiting
    // on the customer, the customer has already replied, and nothing moved.
    expect(statusAfterCustomerMessage(SupportTicketStatus.AWAITING_CUSTOMER)).toBe(
      SupportTicketStatus.OPEN,
    );
  });

  it('refuses to reopen a closed one', () => {
    expect(customerMayReply(SupportTicketStatus.CLOSED)).toBe(false);
    expect(statusAfterCustomerMessage(SupportTicketStatus.CLOSED)).toBe(
      SupportTicketStatus.CLOSED,
    );
  });

  it('does not let a support reply resolve or de-escalate anything by itself', () => {
    // Marking something fixed is a judgement somebody makes on purpose. An
    // escalated ticket that quietly de-escalated because an agent sent a
    // holding message is how a hard problem gets dropped.
    expect(statusAfterSupportMessage(SupportTicketStatus.OPEN)).toBe(
      SupportTicketStatus.AWAITING_CUSTOMER,
    );
    expect(statusAfterSupportMessage(SupportTicketStatus.ESCALATED)).toBe(
      SupportTicketStatus.ESCALATED,
    );
    expect(statusAfterSupportMessage(SupportTicketStatus.RESOLVED)).toBe(
      SupportTicketStatus.RESOLVED,
    );
  });
});

// -----------------------------------------------------------------------------
// Priority
// -----------------------------------------------------------------------------

describe('priority', () => {
  it('is about time, not about the vertical', () => {
    expect(priorityForNewTicket({ aboutLiveOrder: true })).toBe(
      SupportTicketPriority.HIGH,
    );
    expect(priorityForNewTicket({ aboutLiveOrder: false })).toBe(
      SupportTicketPriority.NORMAL,
    );
  });

  it('never hands out URGENT from a form', () => {
    // A priority a customer can select is a priority every customer selects.
    for (const aboutLiveOrder of [true, false]) {
      expect(priorityForNewTicket({ aboutLiveOrder })).not.toBe(
        SupportTicketPriority.URGENT,
      );
    }
  });

  it('ranks urgent above high above normal above low', () => {
    // The queue sorts on this rather than on Postgres's enum order, so that
    // reordering the enum cannot silently reorder the queue.
    expect(PRIORITY_RANK[SupportTicketPriority.URGENT]).toBeLessThan(
      PRIORITY_RANK[SupportTicketPriority.HIGH],
    );
    expect(PRIORITY_RANK[SupportTicketPriority.HIGH]).toBeLessThan(
      PRIORITY_RANK[SupportTicketPriority.NORMAL],
    );
    expect(PRIORITY_RANK[SupportTicketPriority.NORMAL]).toBeLessThan(
      PRIORITY_RANK[SupportTicketPriority.LOW],
    );
  });

  it('does not sort the queue by the enum order in SQL', () => {
    // Postgres sorts an enum by declaration order, so `orderBy: { priority:
    // 'desc' }` happens to work today and would reorder everything the day
    // somebody tidies the enum.
    expect(codeOnly(source('src/lib/support/queries.ts'))).not.toMatch(
      /priority:\s*'(a|de)sc'/,
    );
  });
});

// -----------------------------------------------------------------------------
// Ageing
// -----------------------------------------------------------------------------

describe('chasing a ticket nobody has answered', () => {
  const createdAt = new Date('2026-09-07T02:00:00Z');
  const past = new Date(createdAt.getTime() + (SUPPORT_RESPONSE_TARGET_MINUTES + 1) * 60_000);
  const within = new Date(createdAt.getTime() + 10 * 60_000);

  it('chases one that is past the target and never answered', () => {
    expect(
      needsChasing({
        status: SupportTicketStatus.OPEN,
        firstRespondedAt: null,
        createdAt,
        now: past,
      }),
    ).toBe(true);
  });

  it('does not chase one still inside the target', () => {
    expect(
      needsChasing({
        status: SupportTicketStatus.OPEN,
        firstRespondedAt: null,
        createdAt,
        now: within,
      }),
    ).toBe(false);
  });

  it('stops chasing once a human has said anything at all', () => {
    // Answered-then-quiet is a conversation. It is the FIRST silence — where
    // the customer has no acknowledgement whatsoever — that this protects
    // against.
    expect(
      needsChasing({
        status: SupportTicketStatus.OPEN,
        firstRespondedAt: within,
        createdAt,
        now: past,
      }),
    ).toBe(false);
  });

  it('never chases a ticket the customer owes us an answer on', () => {
    expect(
      needsChasing({
        status: SupportTicketStatus.AWAITING_CUSTOMER,
        firstRespondedAt: null,
        createdAt,
        now: past,
      }),
    ).toBe(false);
  });

  it('gives a person a plausible amount of time before nagging', () => {
    // Not fifteen minutes. This is one person answering tickets between other
    // work, and an alert that fires before a human could have got to it is an
    // alert that gets muted.
    expect(SUPPORT_RESPONSE_TARGET_MINUTES).toBeGreaterThanOrEqual(60);
  });
});

describe('describing a wait', () => {
  it('reads the way a person would say it', () => {
    expect(describeWait(0)).toBe('just now');
    expect(describeWait(1)).toBe('1 minute');
    expect(describeWait(59)).toBe('59 minutes');
    expect(describeWait(60)).toBe('1 hour');
    expect(describeWait(90)).toBe('1 hour');
    expect(describeWait(1439)).toBe('23 hours');
    expect(describeWait(1440)).toBe('1 day');
    expect(describeWait(2880)).toBe('2 days');
  });

  it('never reports a negative wait', () => {
    // Clocks disagree, and a row written a second in the future would
    // otherwise render as "-1 minutes".
    const now = new Date('2026-09-07T02:00:00Z');
    const future = new Date(now.getTime() + 5_000);
    expect(waitingMinutes({ since: future, now })).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// What somebody may write
// -----------------------------------------------------------------------------

describe('the message itself', () => {
  it('refuses an empty or one-word submission', () => {
    expect(() => normaliseMessage('')).toThrow(MessageTooShortError);
    expect(() => normaliseMessage('   ')).toThrow(MessageTooShortError);
    expect(() => normaliseMessage('ab')).toThrow(MessageTooShortError);
    expect(() => normaliseMessage(null)).toThrow(MessageTooShortError);
    expect(() => normaliseMessage(undefined)).toThrow(MessageTooShortError);
  });

  it('trims and caps rather than rejecting a long one', () => {
    // Somebody who pastes a wall of text has still told us something. Losing
    // it entirely because it was 4001 characters would be absurd.
    expect(normaliseMessage('  hello there  ')).toBe('hello there');
    expect(normaliseMessage('x'.repeat(MAX_MESSAGE_LENGTH + 500))).toHaveLength(
      MAX_MESSAGE_LENGTH,
    );
  });

  it('derives a subject when nobody wrote one', () => {
    // A required subject field is a form people abandon; a ticket with no
    // subject is a queue row nobody can triage.
    expect(normaliseSubject('', 'Rider never arrived\nI waited an hour')).toBe(
      'Rider never arrived',
    );
    expect(normaliseSubject('   ', 'The app crashed')).toBe('The app crashed');
  });

  it('keeps a subject somebody did write', () => {
    expect(normaliseSubject('Refund please', 'Long story below')).toBe('Refund please');
  });

  it('truncates a derived subject that is a whole paragraph', () => {
    const derived = normaliseSubject('', 'y'.repeat(MAX_SUBJECT_LENGTH + 200));
    expect(derived).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(derived.endsWith('…')).toBe(true);
  });

  it('caps a subject somebody wrote too', () => {
    expect(normaliseSubject('z'.repeat(MAX_SUBJECT_LENGTH + 50), 'body')).toHaveLength(
      MAX_SUBJECT_LENGTH,
    );
  });
});

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

describe('who gets told', () => {
  it('has a policy for both new kinds', () => {
    expect(KIND_POLICY[NotificationKind.SUPPORT_TICKET_WAITING]).toBeDefined();
    expect(KIND_POLICY[NotificationKind.SUPPORT_REPLY]).toBeDefined();
  });

  it('never texts an administrator about a queue', () => {
    // The volume of this kind is bounded by how many customers have a problem,
    // which is exactly the number that spikes on the worst day.
    expect(
      KIND_POLICY[NotificationKind.SUPPORT_TICKET_WAITING].channels,
    ).not.toContain(NotificationChannel.SMS);
  });

  it('does text the customer when a human answers', () => {
    // A person typed it, so the rate is bounded by staff time. An answer
    // nobody reads is a ticket raised a second time.
    expect(KIND_POLICY[NotificationKind.SUPPORT_REPLY].channels).toContain(
      NotificationChannel.SMS,
    );
  });

  it('keeps neither of them mutable-proof', () => {
    // `unmutable` is for the security alert and nothing else. The moment a
    // second kind ignores the switch, the switch means nothing.
    expect(KIND_POLICY[NotificationKind.SUPPORT_TICKET_WAITING].unmutable).toBeUndefined();
    expect(KIND_POLICY[NotificationKind.SUPPORT_REPLY].unmutable).toBeUndefined();
  });

  it('never puts the customer’s own words in a text message', () => {
    // The subject is text a customer typed and the SMS is delivered to
    // whoever is holding the phone — which, on the account-recovery tickets
    // this feature exists to serve, may not be them.
    const rendered = renderNotification(NotificationKind.SUPPORT_REPLY, {
      ticketNumber: 'TKT-1234',
      ticketSubject: 'MY-PRIVATE-SUBJECT',
    });
    expect(rendered.sms).not.toContain('MY-PRIVATE-SUBJECT');
    expect(rendered.sms).toContain('TKT-1234');
  });

  it('never carries the reply text at all', () => {
    // Not truncated, not redacted: the body of a support message is simply
    // never handed to the notification layer. Nothing in the context can hold
    // it, so nothing downstream can leak it.
    const code = codeOnly(source('src/lib/support/tickets.ts'));
    const enqueue = code.slice(code.indexOf('NotificationKind.SUPPORT_REPLY'));
    const contextBlock = enqueue.slice(0, enqueue.indexOf('dedupeKey'));
    expect(contextBlock).not.toMatch(/\bbody\b/);
  });

  it('tells the three ticket events apart', () => {
    // A customer's reply announced as "New support ticket" is how an
    // administrator learns to stop reading the title. All three go out on the
    // same kind, so the copy is the only thing distinguishing them.
    const base = { ticketNumber: 'TKT-1', ticketSubject: 'Missing order' };
    const raised = renderNotification(NotificationKind.SUPPORT_TICKET_WAITING, {
      ...base,
      ticketEvent: 'NEW',
    });
    const replied = renderNotification(NotificationKind.SUPPORT_TICKET_WAITING, {
      ...base,
      ticketEvent: 'CUSTOMER_REPLIED',
    });
    const chased = renderNotification(NotificationKind.SUPPORT_TICKET_WAITING, {
      ...base,
      ticketEvent: 'STILL_WAITING',
      waitLabel: '4 hours',
    });

    expect(new Set([raised.title, replied.title, chased.title]).size).toBe(3);
    expect(raised.title).toContain('New');
    expect(replied.title).toContain('replied');
    expect(chased.title).toContain('4 hours');
  });

  it('reads as a new ticket when nobody said which event it was', () => {
    // The default matters: an unlabelled alert must not claim a wait that did
    // not happen.
    const rendered = renderNotification(NotificationKind.SUPPORT_TICKET_WAITING, {
      ticketNumber: 'TKT-2',
    });
    expect(rendered.title).toContain('New support ticket');
  });

  it('gives each customer reply its own alert', () => {
    // Keyed on the message rather than the ticket: two messages a day apart
    // are two things to know about, and a ticket-keyed dedupe would silently
    // swallow the second.
    const code = codeOnly(source('src/lib/support/tickets.ts'));
    expect(code).toMatch(/dedupeKey: `support-reopened:\$\{message\.id\}`/);
  });
});

describe('the sweep', () => {
  it('is actually wired into the cron pass', () => {
    // A sweep that exists and is never called is the failure mode this whole
    // feature is guarding against, one level up.
    const maintenance = codeOnly(source('src/lib/orders/maintenance.ts'));
    expect(maintenance).toMatch(/const supportChases = await chaseWaitingTickets\(\)/);
  });

  it('reports what it did, so a silent cron is visibly silent', () => {
    expect(codeOnly(source('scripts/run-order-maintenance.ts'))).toMatch(
      /supportChases\.chased/,
    );
  });

  it('marks a ticket chased so it does not alert on every pass', () => {
    const maintenance = codeOnly(source('src/lib/orders/maintenance.ts'));
    expect(maintenance).toMatch(/markTicketChased/);
  });
});

// -----------------------------------------------------------------------------
// The half that matters: somebody who cannot sign in
// -----------------------------------------------------------------------------

describe('reaching a person without an account', () => {
  it('invents nothing when nothing is configured', () => {
    // A hardcoded number nobody answers is worse than no number: somebody
    // will ring it during the one hour they needed help.
    expect(contactDetails({}).channels).toEqual([]);
    expect(contactPosture({})).toBe('none');
  });

  it('says plainly what is missing, and what to set', () => {
    const described = describeContactPosture({});
    expect(described).toMatch(/SUPPORT_PHONE/);
    expect(described).toMatch(/cannot sign in/);
  });

  it('normalises and formats a phone number', () => {
    const { channels } = contactDetails({ SUPPORT_PHONE: '09171234567' });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.kind).toBe('phone');
    expect(channels[0]!.href).toBe('tel:+639171234567');
  });

  it('refuses a phone number that is not one', () => {
    // A mistyped number renders as a `tel:` link that silently dials nothing,
    // and nobody testing the happy path would ever notice.
    expect(contactDetails({ SUPPORT_PHONE: 'call us maybe' }).channels).toEqual([]);
    expect(contactDetails({ SUPPORT_PHONE: '12345' }).channels).toEqual([]);
    expect(contactDetails({ SUPPORT_PHONE: '' }).channels).toEqual([]);
  });

  it('takes an email address and rejects a placeholder', () => {
    expect(contactDetails({ SUPPORT_EMAIL: 'help@tara.ph' }).channels[0]?.href).toBe(
      'mailto:help@tara.ph',
    );
    expect(contactDetails({ SUPPORT_EMAIL: 'tbd' }).channels).toEqual([]);
    expect(contactDetails({ SUPPORT_EMAIL: 'help @tara.ph' }).channels).toEqual([]);
  });

  it('takes a Facebook page over https only', () => {
    // It is rendered as a link somebody taps. A Page inbox is how most people
    // in the Philippines expect to reach a business.
    expect(
      contactDetails({ SUPPORT_FACEBOOK: 'https://facebook.com/tara' }).channels[0]?.label,
    ).toBe('facebook.com/tara');
    expect(contactDetails({ SUPPORT_FACEBOOK: 'http://facebook.com/tara' }).channels).toEqual(
      [],
    );
    expect(contactDetails({ SUPPORT_FACEBOOK: 'facebook.com/tara' }).channels).toEqual([]);
  });

  it('carries opening hours only when somebody wrote some', () => {
    expect(contactDetails({ SUPPORT_HOURS: '  ' }).hours).toBeNull();
    expect(contactDetails({ SUPPORT_HOURS: '9am-9pm' }).hours).toBe('9am-9pm');
  });

  it('counts one configured channel as reachable', () => {
    expect(contactPosture({ SUPPORT_EMAIL: 'help@tara.ph' })).toBe('configured');
  });

  it('is shown on the two screens a locked-out person can actually open', () => {
    // /help and /recover are both public, and the panel is on both. Without
    // this the ticket form is the only support channel, and the person who
    // needs support most cannot reach it.
    expect(isPublicPath('/help')).toBe(true);
    expect(isPublicPath('/recover')).toBe(true);
    expect(codeOnly(source('src/app/help/page.tsx'))).toMatch(/<ContactPanel/);
    expect(codeOnly(source('src/app/recover/page.tsx'))).toMatch(/<ContactPanel/);
  });

  it('keeps the ticket screens behind the login wall', () => {
    // They need an account — there is nowhere to put the reply otherwise —
    // and `/help` being public must not drag them out with it. This is the
    // boundary-matching rule in the middleware doing its job.
    expect(isPublicPath('/help/contact')).toBe(false);
    expect(isPublicPath('/help/tickets')).toBe(false);
    expect(isPublicPath('/help/tickets/abc123')).toBe(false);
  });

  it('is passed through to the container', () => {
    const compose = parse(source('docker-compose.yml')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const web = compose.services.web!.environment!;
    expect(Object.keys(web)).toContain('SUPPORT_PHONE');
    expect(Object.keys(web)).toContain('SUPPORT_EMAIL');
  });
});

// -----------------------------------------------------------------------------
// Demo data
// -----------------------------------------------------------------------------

describe('the seeded threads', () => {
  it('do not enqueue a notification to every administrator', () => {
    // A seed run should not fill the outbox. The threads are written straight
    // to the table rather than through `createSupportTicket`, which alerts.
    const seed = codeOnly(source('prisma/seed.ts'));
    expect(seed).toMatch(/supportTicket\.upsert/);
    expect(seed).not.toMatch(/createSupportTicket/);
  });

  it('are named in the purge report before they are deleted', () => {
    // They cascade with the demo account either way. A report that does not
    // mention data it is about to remove understates what it does — and a
    // support thread is a conversation somebody had.
    const purge = codeOnly(source('scripts/purge-demo.ts'));
    expect(purge).toMatch(/supportTickets: true/);
    expect(purge).toMatch(/support thread\(s\)/);
  });
});

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

describe('a thread belongs to exactly one customer', () => {
  it('filters on the user id inside the query, not after it', () => {
    // An ownership check that happens after the row is loaded is one somebody
    // later moves or forgets. Every customer-facing read here puts `userId`
    // in the WHERE.
    const code = codeOnly(source('src/lib/support/tickets.ts'));
    expect(code).toMatch(/findFirst\(\{\s*where: \{ id: ticketId, userId \}/);
    expect(code).toMatch(/where: \{ id: input\.ticketId, userId: input\.userId \}/);
  });

  it('answers a stranger with a 404 rather than a 403', () => {
    // There is nothing to learn from the difference, and one of the two
    // answers confirms that a given id is real.
    expect(codeOnly(source('src/app/help/tickets/[id]/page.tsx'))).toMatch(
      /notFound\(\)/,
    );
  });

  it('checks the administrator on every console action', () => {
    // A server action is its own entry point. The layout's check does not
    // cover it.
    const actions = codeOnly(source('src/lib/actions/support-console-actions.ts'));
    for (const name of [
      'replyToTicketAsSupportAction',
      'setTicketStatusAction',
      'assignTicketToMeAction',
    ]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      expect(body.slice(0, 600), `${name} does not call requireAdmin`).toMatch(
        /requireAdmin\(\)/,
      );
    }
  });

  it('refuses a status that is not a status', () => {
    // The value arrives from a select in a form, which is to say from
    // anybody who can post to the action.
    const actions = codeOnly(source('src/lib/actions/support-console-actions.ts'));
    expect(actions).toMatch(/if \(!\(status in TICKET_STATUS_POLICY\)\)/);
  });

  it('never leaves a dead submit button when the bundle has not arrived', () => {
    // MEASURED, not assumed: a pre-hydration form post arrives as a plain
    // POST that Next runs with no request scope, so `cookies()` throws — and
    // every action here needs the session cookie. `LoginFlow` reached the same
    // conclusion for its code step. So each form waits for hydration rather
    // than posting into a 500.
    for (const file of [
      'src/components/support/NewTicketForm.tsx',
      'src/components/support/ReplyForm.tsx',
      'src/components/admin/TicketConsole.tsx',
    ]) {
      const code = codeOnly(source(file));
      expect(code, `${file} does not use useActionState`).toMatch(/useActionState\(/);
      expect(code, `${file} does not wait for hydration`).toMatch(
        /setHydrated\(true\)/,
      );
      expect(code, `${file} has a submit that ignores hydration`).not.toMatch(
        /disabled=\{(busy|replying|moving)\}/,
      );
    }
  });

  it('tells a customer with no JavaScript what does work', () => {
    // The fallback for "the bundle failed" is the same as the fallback for
    // "I cannot sign in", and it is the reason the contact panel is on these
    // screens: a phone number is plain HTML.
    for (const file of [
      'src/components/support/NewTicketForm.tsx',
      'src/components/support/ReplyForm.tsx',
    ]) {
      expect(source(file), `${file} has no noscript note`).toMatch(/<noscript>/);
    }
    expect(codeOnly(source('src/app/help/contact/page.tsx'))).toMatch(/<ContactPanel/);
  });

  it('redirects from the server after opening a ticket', () => {
    // So the new thread is a real navigation with its own URL — shareable,
    // and correct on the back button.
    expect(codeOnly(source('src/lib/actions/support-actions.ts'))).toMatch(
      /redirect\(`\/help\/tickets\/\$\{ticketId\}`\)/,
    );
  });

  it('does not redirect from inside the catch that reports faults', () => {
    // `redirect` works by throwing. Called inside the try, a successful
    // submission would be caught, reported as an internal error, and shown to
    // the customer as a failure.
    const code = codeOnly(source('src/lib/actions/support-actions.ts'));
    const openAction = code.slice(code.indexOf('export async function openTicketAction'));
    const body = openAction.slice(0, openAction.indexOf('export async function replyTo'));
    expect(body.indexOf('redirect(')).toBeGreaterThan(body.indexOf('} catch (error)'));
  });

  it('stays out of the file whose every action needs a reason and an audit row', () => {
    // Not an exemption list on that invariant: a separate module. The moment
    // a support control touches a balance, a role or a phone number it moves
    // back and takes the reason with it.
    const admin = codeOnly(source('src/lib/actions/admin-actions.ts'));
    expect(admin).not.toMatch(/addSupportReply|setTicketStatus\(/);
  });
});
