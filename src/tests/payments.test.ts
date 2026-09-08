import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OrderStatus,
  PaymentEventType,
  PaymentMethod,
  PaymentStatus,
  ServiceKey,
} from '@prisma/client';
import {
  CREDIT_REFUNDABLE_METHODS,
  EVENT_DIRECTION,
  InvalidPaymentEventError,
  MAX_REFERENCE_LENGTH,
  MIN_REFERENCE_LENGTH,
  PAYMENT_WINDOW_SECONDS,
  PREPAID_METHODS,
  REFUND_DESTINATION,
  cashToCollectCentavos,
  derivePaymentStatus,
  describePaymentWait,
  isPrepaid,
  normaliseReference,
  reasonIsRequired,
  refundDestinationFor,
  signedPaymentAmount,
} from '@/lib/payments/policy';
import { ManualTransferRail, paymentRailStatus, resolvePaymentRail } from '@/lib/payments/rails';
import { PaymentRailNotReadyError } from '@/lib/payments/rails/types';
import { ORDER_LIFECYCLES } from '@/lib/orders/transitions';
import { renderNotification } from '@/lib/notifications/templates';
import { NotificationKind } from '@prisma/client';

/**
 * Taking money.
 *
 * Two rules carry this feature, and most of what follows is about them:
 *
 *   1. Real money never becomes credits. The credits design promises there is
 *      no way to load a balance, and refunding a transfer as credits would be
 *      exactly that with a different name on it.
 *   2. A prepaid order is not an order until the money is confirmed. Nothing
 *      reaches a kitchen on a customer's word that they have paid.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return stripComments(source(relativePath));
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

/**
 * Comments AND string literals removed.
 *
 * The rules below that forbid a word are about what the code does, and three
 * of them failed first time round on this file's own prose — a schema comment
 * saying "note the absence of `updatedAt`" satisfies a grep for `updatedAt`,
 * and a docstring explaining why we never promise "within 24 hours" contains
 * the phrase it forbids. A rule that a comment can break is a rule that gets
 * weakened rather than fixed.
 */
function identifiersOnly(relativePath: string): string {
  return stripComments(source(relativePath))
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const ALL_METHODS = Object.values(PaymentMethod);
const ALL_EVENTS = Object.values(PaymentEventType);

describe('cash never becomes credits', () => {
  it('sends every real-money instrument back to its source', () => {
    // The rule the whole credits design rests on. If a cash method ever maps
    // to the ledger, a customer can pay us ₱500, cancel, and walk away with
    // ₱500 of spendable balance — which is a top-up, and there is not supposed
    // to be one.
    for (const method of ALL_METHODS) {
      if (method === PaymentMethod.WALLET_CREDIT) continue;
      expect(refundDestinationFor(method), method).toBe('SOURCE_OF_FUNDS');
    }
  });

  it('lets exactly one instrument refund into credits, and it is credits', () => {
    expect(CREDIT_REFUNDABLE_METHODS).toEqual([PaymentMethod.WALLET_CREDIT]);
  });

  it('has an answer for every method, so a new one cannot default', () => {
    // A `Partial<Record<...>>` here would make a new instrument silently
    // undefined, and `undefined !== 'SOURCE_OF_FUNDS'` reads as "credits" at
    // every call site that compares.
    for (const method of ALL_METHODS) {
      expect(Object.keys(REFUND_DESTINATION), method).toContain(method);
      expect(REFUND_DESTINATION[method]).toMatch(/^(CREDITS_LEDGER|SOURCE_OF_FUNDS)$/);
    }
  });

  it('says so in the database too, not only in the application', () => {
    // Application code is one deployment away from being bypassed by a script.
    const guards = source('prisma/sql/payment_events_append_only.sql');
    expect(guards).toMatch(/wallet_refund_needs_credits_spent/);
    expect(guards).toMatch(/BEFORE INSERT ON "WalletTransaction"/);
    // The mechanism: a credits refund is only legal for an order that actually
    // spent credits, and a transfer-paid order never has an ORDER_PAYMENT row.
    expect(guards).toMatch(/type" = 'ORDER_PAYMENT'/);
  });

  it('keeps the two ledgers in separate tables', () => {
    // There is no schema path from a confirmed charge to a credits row, which
    // is what makes the rule checkable rather than a convention.
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/model PaymentEvent \{/);
    expect(schema).toMatch(/model WalletTransaction \{/);
    // And the credits ledger still has no way in from outside.
    for (const forbidden of ['TOP_UP', 'TRANSFER_IN', 'TRANSFER_OUT', 'WITHDRAWAL']) {
      expect(schema, forbidden).not.toMatch(new RegExp(`^\\s*${forbidden}\\b`, 'm'));
    }
  });

  it('refuses to route a credits order through the cash refund path', () => {
    const manual = codeOnly('src/lib/payments/manual.ts');
    expect(manual).toMatch(/refundDestinationFor\(order\.paymentMethod\) !== 'SOURCE_OF_FUNDS'/);
  });
});

describe('a prepaid order waits for the money', () => {
  it('knows which instruments are paid up front', () => {
    expect(isPrepaid(PaymentMethod.MANUAL_TRANSFER)).toBe(true);
    // Cash is collected at the door, and credits are spent inside the
    // placement transaction — by the time either order exists, there is
    // nothing left to wait for.
    expect(isPrepaid(PaymentMethod.CASH_ON_DELIVERY)).toBe(false);
    expect(isPrepaid(PaymentMethod.WALLET_CREDIT)).toBe(false);
  });

  it('has an answer for every method', () => {
    // The failure mode of a new method defaulting to "not prepaid" is food
    // cooked for free.
    for (const method of ALL_METHODS) {
      expect(Object.keys(PREPAID_METHODS), method).toContain(method);
      expect(typeof PREPAID_METHODS[method]).toBe('boolean');
    }
  });

  it('can hold an order for payment in every vertical', () => {
    // RIDE could not, and the other four could — a drift nobody would notice
    // until Sakay launched without prepayment. Prepaying matters MOST for a
    // ride, where the alternative is arguing with a passenger at a kerb.
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      const fromDraft = lifecycle.transitions[OrderStatus.DRAFT] ?? [];
      expect(fromDraft, key).toContain(OrderStatus.PENDING_PAYMENT);

      const fromWait = lifecycle.transitions[OrderStatus.PENDING_PAYMENT] ?? [];
      expect(fromWait, key).toContain(lifecycle.submittedStatus);
    }
  });

  it('lets the customer place it and the system release it', () => {
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      const actors = lifecycle.permittedActors[OrderStatus.PENDING_PAYMENT] ?? [];
      expect(actors, key).toContain('CUSTOMER');
      expect(actors, key).toContain('SYSTEM');
      // Not the shop: a store cannot decide whether a customer has paid.
      expect(actors, key).not.toContain('MERCHANT');
    }
  });

  it('never leaves an unpaid order waiting forever, in any vertical', () => {
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      const timeout = lifecycle.timeouts.find(
        (entry) => entry.status === OrderStatus.PENDING_PAYMENT,
      );
      expect(timeout, key).toBeDefined();
      expect(timeout!.afterSeconds, key).toBe(PAYMENT_WINDOW_SECONDS);
      expect(timeout!.to, key).toBe(OrderStatus.CANCELLED_BY_SYSTEM);
    }
  });

  it('only expires a payment nobody has claimed', () => {
    // The one that would be indefensible: a customer sends the money, gives us
    // a reference, and we cancel their order because WE were slow to check it.
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      const timeout = lifecycle.timeouts.find(
        (entry) => entry.status === OrderStatus.PENDING_PAYMENT,
      )!;
      expect(timeout.whilePaymentStatus, key).toEqual([PaymentStatus.PENDING]);
    }
    // And the sweep actually reads it.
    expect(codeOnly('src/lib/orders/maintenance.ts')).toMatch(
      /policy\.whilePaymentStatus/,
    );
  });

  it('gives the customer longer to pay than the shop gets to accept', () => {
    // Their leg involves leaving the app for another one, finding an account
    // number and fumbling a transfer.
    const merchantWait = ORDER_LIFECYCLES[ServiceKey.FOOD].timeouts.find(
      (entry) => entry.status === OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    );
    expect(merchantWait).toBeDefined();
    expect(PAYMENT_WINDOW_SECONDS).toBeGreaterThan(merchantWait!.afterSeconds);
  });

  it('does not hold an order that owes nothing', () => {
    // Credits can cover a total completely. Waiting for a transfer nobody
    // needs to make would wait forever.
    expect(codeOnly('src/lib/orders/place-order.ts')).toMatch(
      /isPrepaid\(input\.paymentMethod\) && quote\.price\.totalCentavos > 0/,
    );
  });
});

describe('the direction of money comes from the event, never the caller', () => {
  it('has a direction for every event type', () => {
    for (const type of ALL_EVENTS) {
      expect(Object.keys(EVENT_DIRECTION), type).toContain(type);
      expect([-1, 0, 1]).toContain(EVENT_DIRECTION[type]);
    }
  });

  it('refuses a signed amount from a caller', () => {
    // A caller who can choose the sign can book a refund as a charge, and that
    // mistake is invisible until somebody adds up a day's takings.
    expect(() =>
      signedPaymentAmount(PaymentEventType.CHARGE_CONFIRMED, -32_400),
    ).toThrow(InvalidPaymentEventError);
  });

  it('makes money in positive and money out negative', () => {
    expect(signedPaymentAmount(PaymentEventType.CHARGE_CONFIRMED, 32_400)).toBe(32_400);
    expect(signedPaymentAmount(PaymentEventType.CASH_COLLECTED, 32_400)).toBe(32_400);
    expect(signedPaymentAmount(PaymentEventType.REFUND_ISSUED, 32_400)).toBe(-32_400);
  });

  it('refuses to attach money to a claim', () => {
    // A customer saying they have paid is not money arriving, and the gap
    // between those two is where a payments bug lives.
    expect(() =>
      signedPaymentAmount(PaymentEventType.CHARGE_SUBMITTED, 32_400),
    ).toThrow(InvalidPaymentEventError);
    expect(signedPaymentAmount(PaymentEventType.CHARGE_SUBMITTED, 0)).toBe(0);
  });

  it('refuses a movement of nothing, and a fraction of a centavo', () => {
    expect(() => signedPaymentAmount(PaymentEventType.CHARGE_CONFIRMED, 0)).toThrow(
      InvalidPaymentEventError,
    );
    expect(() => signedPaymentAmount(PaymentEventType.CHARGE_CONFIRMED, 1.5)).toThrow(
      InvalidPaymentEventError,
    );
  });

  it('agrees with the database CHECK constraint', () => {
    // The two say the same thing in two languages, so they have to be read
    // together when either changes.
    const guards = source('prisma/sql/payment_events_append_only.sql');
    for (const type of ALL_EVENTS) {
      expect(guards, type).toContain(type);
    }
    expect(guards).toMatch(/'CHARGE_CONFIRMED', 'CASH_COLLECTED'\) AND "amountCentavos" > 0/);
    expect(guards).toMatch(/'REFUND_ISSUED' AND "amountCentavos" < 0/);
  });

  it('demands a reason for the two events a customer reads', () => {
    expect(reasonIsRequired(PaymentEventType.CHARGE_REFUSED)).toBe(true);
    expect(reasonIsRequired(PaymentEventType.REFUND_ISSUED)).toBe(true);
    expect(reasonIsRequired(PaymentEventType.CHARGE_CONFIRMED)).toBe(false);
    // In the database as well as in the code.
    expect(source('prisma/sql/payment_events_append_only.sql')).toMatch(
      /payment_event_reason_required/,
    );
  });
});

describe('the status is derived from the events', () => {
  const owed = 32_400;

  it('is pending when nothing has happened', () => {
    expect(derivePaymentStatus([], owed)).toBe(PaymentStatus.PENDING);
  });

  it('is paid when an order owes nothing at all', () => {
    // Credits covered the whole total, so there are no events and never will
    // be.
    expect(derivePaymentStatus([], 0)).toBe(PaymentStatus.PAID);
  });

  it('treats a claim as a claim: neither paid nor pending', () => {
    const claimed = [
      { type: PaymentEventType.CHARGE_REQUESTED, amountCentavos: 0 },
      { type: PaymentEventType.CHARGE_SUBMITTED, amountCentavos: 0 },
    ];
    // CLAIMED has to be its own state, and the reason is the expiry sweep.
    // While a claim derived as PENDING, the sweep — which cancels unpaid
    // orders after twenty minutes — cancelled orders where the customer HAD
    // paid and was waiting on us to check. Found against the real database,
    // not here: this file happily asserted PENDING while the queue and the
    // sweep were built assuming otherwise.
    expect(derivePaymentStatus(claimed, owed)).toBe(PaymentStatus.CLAIMED);
    expect(derivePaymentStatus(claimed, owed)).not.toBe(PaymentStatus.PAID);
  });

  it('is claimed again after a refusal is corrected', () => {
    // Newest-first, so somebody who mistypes, is refused, and re-sends is
    // back in the queue rather than stuck at FAILED.
    expect(
      derivePaymentStatus(
        [
          { type: PaymentEventType.CHARGE_SUBMITTED, amountCentavos: 0 },
          { type: PaymentEventType.CHARGE_REFUSED, amountCentavos: 0 },
          { type: PaymentEventType.CHARGE_SUBMITTED, amountCentavos: 0 },
        ],
        owed,
      ),
    ).toBe(PaymentStatus.CLAIMED);
  });

  it('never lets a claim look like money to the expiry sweep', () => {
    // The invariant behind the state, stated where it will be read: the
    // payment timeout fires only on PENDING, so CLAIMED must not be PENDING.
    const claimed = derivePaymentStatus(
      [{ type: PaymentEventType.CHARGE_SUBMITTED, amountCentavos: 0 }],
      owed,
    );
    for (const [key, lifecycle] of Object.entries(ORDER_LIFECYCLES)) {
      const timeout = lifecycle.timeouts.find(
        (entry) => entry.status === OrderStatus.PENDING_PAYMENT,
      )!;
      expect(timeout.whilePaymentStatus, key).not.toContain(claimed);
    }
  });

  it('is paid once the money is confirmed in full', () => {
    expect(
      derivePaymentStatus(
        [{ type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: owed }],
        owed,
      ),
    ).toBe(PaymentStatus.PAID);
  });

  it('does not call a short payment paid', () => {
    // The commonest way a manual rail goes wrong: ₱300 sent for a ₱324 order.
    // Calling that PAID is how a shop ends up out of pocket, and how a rider
    // collects nothing on an order that still owes ₱24.
    expect(
      derivePaymentStatus(
        [{ type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: 30_000 }],
        owed,
      ),
    ).toBe(PaymentStatus.AUTHORIZED);
  });

  it('counts an overpayment as paid', () => {
    expect(
      derivePaymentStatus(
        [{ type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: 40_000 }],
        owed,
      ),
    ).toBe(PaymentStatus.PAID);
  });

  it('is failed after a refusal, and recovers on a good one', () => {
    const refused = [
      { type: PaymentEventType.CHARGE_SUBMITTED, amountCentavos: 0 },
      { type: PaymentEventType.CHARGE_REFUSED, amountCentavos: 0 },
    ];
    expect(derivePaymentStatus(refused, owed)).toBe(PaymentStatus.FAILED);

    // A refusal is not the end: they re-send a corrected reference and it
    // checks out. Money outranks the newest verdict, because money is a fact
    // and a verdict is an opinion about one.
    expect(
      derivePaymentStatus(
        [...refused, { type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: owed }],
        owed,
      ),
    ).toBe(PaymentStatus.PAID);
  });

  it('is failed once the window closes on an unpaid order', () => {
    expect(
      derivePaymentStatus(
        [{ type: PaymentEventType.CHARGE_EXPIRED, amountCentavos: 0 }],
        owed,
      ),
    ).toBe(PaymentStatus.FAILED);
  });

  it('separates a partial refund from a full one', () => {
    const paid = { type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: owed };
    expect(
      derivePaymentStatus(
        [paid, { type: PaymentEventType.REFUND_ISSUED, amountCentavos: -10_000 }],
        owed,
      ),
    ).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(
      derivePaymentStatus(
        [paid, { type: PaymentEventType.REFUND_ISSUED, amountCentavos: -owed }],
        owed,
      ),
    ).toBe(PaymentStatus.REFUNDED);
  });

  it('sums several refunds rather than reading only the last', () => {
    expect(
      derivePaymentStatus(
        [
          { type: PaymentEventType.CHARGE_CONFIRMED, amountCentavos: owed },
          { type: PaymentEventType.REFUND_ISSUED, amountCentavos: -20_000 },
          { type: PaymentEventType.REFUND_ISSUED, amountCentavos: -12_400 },
        ],
        owed,
      ),
    ).toBe(PaymentStatus.REFUNDED);
  });

  it('separates "claimed" from "arrived but short"', () => {
    // Two different people are waiting in these two states: CLAIMED waits on
    // us to look, AUTHORIZED waits on the customer to send the rest. The
    // console queue only shows the first.
    expect(describePaymentWait(PaymentStatus.CLAIMED)).toMatch(/checking/i);
    expect(describePaymentWait(PaymentStatus.AUTHORIZED)).toMatch(/send the rest/i);
  });

  it('has words for every status a customer can be shown', () => {
    for (const status of Object.values(PaymentStatus)) {
      expect(describePaymentWait(status), status).toBeTruthy();
    }
  });
});

describe('what the rider is told to collect', () => {
  const total = 32_400;

  it('asks for the money on an unpaid cash order', () => {
    expect(
      cashToCollectCentavos(PaymentMethod.CASH_ON_DELIVERY, PaymentStatus.PENDING, total),
    ).toBe(total);
  });

  it('asks for nothing on a confirmed prepaid order', () => {
    // A rider asking here is a rider asking somebody to pay twice.
    expect(
      cashToCollectCentavos(PaymentMethod.MANUAL_TRANSFER, PaymentStatus.PAID, total),
    ).toBe(0);
  });

  it('STILL asks on a prepaid order that was never confirmed', () => {
    // The case that costs real money. A transfer nobody confirmed is not a
    // payment, and handing over food on the strength of the method the
    // customer selected at checkout is handing over food for nothing.
    expect(
      cashToCollectCentavos(PaymentMethod.MANUAL_TRANSFER, PaymentStatus.PENDING, total),
    ).toBe(total);
    expect(
      cashToCollectCentavos(
        PaymentMethod.MANUAL_TRANSFER,
        PaymentStatus.AUTHORIZED,
        total,
      ),
    ).toBe(total);
  });

  it('never asks for credits at the door', () => {
    // There is no way to hand over credits, and nothing to collect: they were
    // spent when the order was placed.
    for (const status of Object.values(PaymentStatus)) {
      expect(
        cashToCollectCentavos(PaymentMethod.WALLET_CREDIT, status, total),
        status,
      ).toBe(0);
    }
  });

  it('asks for nothing on an order that owes nothing', () => {
    expect(
      cashToCollectCentavos(PaymentMethod.CASH_ON_DELIVERY, PaymentStatus.PENDING, 0),
    ).toBe(0);
  });

  it('puts the answer on the rider’s screen, with the amount', () => {
    const screen = source('src/app/fleet/job/page.tsx');
    expect(screen).toMatch(/Collect at the door/);
    expect(screen).toMatch(/Do not ask for money/);
    // The amount, not just the fact: a rider holding out a hand needs the
    // number.
    expect(screen).toMatch(/formatCentavos\(job\.cashToCollectCentavos\)/);
  });
});

describe('a reference number as typed by somebody on a phone', () => {
  it('accepts a GCash reference', () => {
    expect(normaliseReference('1234567890123')).toBe('1234567890123');
  });

  it('forgives the noise a copy-paste brings', () => {
    // Refusing a reference for having a space in it teaches people the app is
    // broken.
    expect(normaliseReference('  1234 5678 90123 ')).toBe('1234567890123');
    expect(normaliseReference('abc-123-def')).toBe('ABC123DEF');
  });

  it('refuses what cannot be a reference', () => {
    expect(normaliseReference('')).toBeNull();
    expect(normaliseReference('12345')).toBeNull();
    expect(normaliseReference('1'.repeat(MAX_REFERENCE_LENGTH + 1))).toBeNull();
    // Not a digit-only rule: Maya and the banks use letters. But a sentence is
    // not a reference.
    expect(normaliseReference('I paid it already!')).toBeNull();
  });

  it('never throws, because it runs on customer input', () => {
    for (const input of ['', ' ', '---', '₱324.00', '🙂🙂🙂🙂🙂🙂']) {
      expect(() => normaliseReference(input)).not.toThrow();
    }
  });

  it('has a floor low enough for a short bank reference', () => {
    expect(MIN_REFERENCE_LENGTH).toBeLessThanOrEqual(6);
  });
});

describe('the rail, and refusing to half-configure it', () => {
  const complete = {
    PAYMENT_TRANSFER_LABEL: 'GCash',
    PAYMENT_TRANSFER_ACCOUNT_NAME: 'Juan Dela Cruz',
    PAYMENT_TRANSFER_ACCOUNT_NUMBER: '0917 123 4567',
  };

  it('resolves a rail when it has somewhere to send money', () => {
    const rail = resolvePaymentRail(complete);
    expect(rail).not.toBeNull();
    expect(rail!.customerLabel).toBe('GCash');
    expect(rail!.confirmation).toBe('HUMAN');
    expect(rail!.method).toBe(PaymentMethod.MANUAL_TRANSFER);
  });

  it('switches off entirely when any part is missing', () => {
    // A checkout that offers a transfer without an account to send it to takes
    // an order nobody can pay — worse than not offering it.
    for (const key of Object.keys(complete)) {
      const partial = { ...complete, [key]: '' };
      expect(resolvePaymentRail(partial), key).toBeNull();
    }
    expect(resolvePaymentRail({})).toBeNull();
  });

  it('says which part is missing, for the health screen', () => {
    const status = paymentRailStatus({
      ...complete,
      PAYMENT_TRANSFER_ACCOUNT_NUMBER: '',
    });
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(['PAYMENT_TRANSFER_ACCOUNT_NUMBER']);
  });

  it('treats whitespace as missing', () => {
    expect(resolvePaymentRail({ ...complete, PAYMENT_TRANSFER_LABEL: '   ' })).toBeNull();
  });

  it('does not throw in production the way the SMS sender does', async () => {
    // Deliberately unlike `resolveSmsSender`. No SMS means nobody can log in,
    // so that one must fail loudly. The app is fully usable on cash, so
    // refusing to boot over a missing account number would be theatre.
    expect(resolvePaymentRail({ NODE_ENV: 'production' })).toBeNull();
  });

  it('tells the customer the amount, the account and our reference', async () => {
    const rail = new ManualTransferRail({
      label: 'GCash',
      accountName: 'Juan Dela Cruz',
      accountNumber: '0917 123 4567',
    });
    const start = await rail.begin({ orderNumber: 'DA-20260908-ABCDE', amountCentavos: 32_400 });
    expect(start.kind).toBe('INSTRUCTIONS');
    expect(start).toMatchObject({
      accountNumber: '0917 123 4567',
      amountCentavos: 32_400,
      // Ours, in the transfer note — what makes an unmatched payment findable.
      ourReference: 'DA-20260908-ABCDE',
    });
  });

  it('refuses to ask for nothing', async () => {
    const rail = new ManualTransferRail({
      label: 'GCash',
      accountName: 'Juan Dela Cruz',
      accountNumber: '0917 123 4567',
    });
    await expect(rail.begin({ orderNumber: 'DA-1', amountCentavos: 0 })).rejects.toThrow(
      PaymentRailNotReadyError,
    );
  });

  it('keeps the brand out of the type system', () => {
    // "GCash" is a label in the environment, so the same build serves a Maya
    // deployment. The instrument is MANUAL_TRANSFER, not MANUAL_GCASH.
    const schema = source('prisma/schema.prisma');
    expect(schema).not.toMatch(/GCASH/);
    expect(codeOnly('src/lib/payments/rails/manual-transfer.ts')).not.toMatch(/GCash/);
  });
});

describe('the ledger is append-only and idempotent', () => {
  it('refuses UPDATE and DELETE with a trigger', () => {
    const guards = source('prisma/sql/payment_events_append_only.sql');
    expect(guards).toMatch(/payment_event_no_update/);
    expect(guards).toMatch(/payment_event_no_delete/);
    // The same transaction-scoped escape hatch the credits ledger has, so a
    // test database can still be reset and a lawful erasure can still happen.
    expect(guards).toMatch(/tara\.allow_purge/);
  });

  it('has no updatedAt on the payment ledger', () => {
    const schema = stripComments(source('prisma/schema.prisma'));
    const model = schema.slice(
      schema.indexOf('model PaymentEvent {'),
      schema.indexOf('}', schema.indexOf('model PaymentEvent {')),
    );
    expect(model).toMatch(/createdAt/);
    expect(model).not.toMatch(/updatedAt/);
  });

  it('makes a confirmation idempotent by the order', () => {
    // An administrator double-tapping Confirm, or a provider retrying a
    // webhook, must not take the money twice.
    const manual = codeOnly('src/lib/payments/manual.ts');
    expect(manual).toMatch(/idempotencyKey: `charge-confirmed:\$\{order\.id\}`/);
    expect(codeOnly('src/lib/payments/events.ts')).toMatch(/replayed: true/);
  });

  it('writes the derived status from the events, in one place', () => {
    const events = codeOnly('src/lib/payments/events.ts');
    expect(events).toMatch(/derivePaymentStatus\(events, order\.totalCentavos\)/);
    expect(events).toMatch(/data: \{ paymentStatus: status \}/);
  });

  it('runs at serializable isolation, like the credits ledger', () => {
    // Two events on one order must not both read the same prior state and
    // both decide the order is now fully paid.
    expect(codeOnly('src/lib/payments/events.ts')).toMatch(
      /TransactionIsolationLevel\.Serializable/,
    );
  });
});

describe('the money is not on the client', () => {
  it('keeps the payment policy free of server-only imports', () => {
    // Five features have now had a page 500 by reaching `next/headers` through
    // a chain that started in a module a client component imports. This module
    // is imported by the checkout form and the payment panel.
    const policy = codeOnly('src/lib/payments/policy.ts');
    expect(policy).not.toMatch(/next\/headers/);
    expect(policy).not.toMatch(/from '@\/lib\/prisma'/);
    expect(policy).not.toMatch(/from '@\/lib\/auth\//);
    // Types only, from the generated client.
    expect(policy).toMatch(/from '@prisma\/client'/);
  });

  it('never sends the account details to a checkout page', () => {
    // The account number belongs on the payment screen of an order that
    // exists, not in the bundle of every checkout view. The page reduces the
    // rail to a label before it crosses the boundary.
    const checkout = codeOnly('src/app/checkout/page.tsx');
    expect(checkout).toMatch(/transferLabel=\{rail\?\.customerLabel \?\? null\}/);
    expect(checkout).not.toMatch(/accountNumber/);
    expect(codeOnly('src/components/cart/CheckoutForm.tsx')).not.toMatch(/accountNumber/);
  });

  it('resolves the instructions only after the ownership check', () => {
    // An order id is not an access token, and the instructions name the
    // account money goes to.
    const page = source('src/app/orders/[orderId]/page.tsx');
    const ownership = page.indexOf('order.customerId !== user.id');
    const instructions = page.indexOf('await transferDetailsFor(');
    expect(ownership).toBeGreaterThan(-1);
    expect(instructions).toBeGreaterThan(ownership);
  });
});

describe('the console’s payment controls', () => {
  const actions = codeOnly('src/lib/actions/admin-actions.ts');

  it('lives in the file with the reason-and-audit invariant', () => {
    // Confirming a payment moves money on one person's word, which is exactly
    // what a dispute months later needs a record of. `admin-access.test.ts`
    // asserts requireAdmin, normaliseReason and recordAdminAction on every
    // action in this file, so being here IS the guarantee.
    for (const name of [
      'confirmPaymentAction',
      'refusePaymentAction',
      'recordRefundSentAction',
    ]) {
      expect(actions, name).toContain(`export async function ${name}(`);
    }
  });

  it('keeps the credits top-up words out of that file', () => {
    // The invariant test forbids them in code there, and one of them collides
    // with the name of a payment instrument — so the instrument is read off
    // the order rather than named. Asserted here so a later edit that spells
    // it out fails with an explanation rather than a puzzle.
    const identifiers = identifiersOnly('src/lib/actions/admin-actions.ts').toLowerCase();
    for (const forbidden of ['topup', 'withdraw', 'cashout', 'transfer']) {
      expect(identifiers, forbidden).not.toContain(forbidden);
    }
  });

  it('records a refund rather than claiming to have sent one', () => {
    // Nothing in this codebase can push money into somebody's wallet. The row
    // is a person saying they did it, with their name against it.
    const manual = source('src/lib/payments/manual.ts');
    expect(manual).toMatch(/Records that a refund was made; it does not make one/);
    expect(source('src/app/admin/payments/page.tsx')).toMatch(/Send the money first/);
  });

  it('does not cancel an order over one bad reference', () => {
    // A mistyped digit is the likeliest explanation and the money may well be
    // in the account. Cancelling on the first refusal would strand real
    // payments.
    const manual = codeOnly('src/lib/payments/manual.ts');
    const refuse = manual.slice(manual.indexOf('export async function refusePayment'));
    expect(refuse).not.toMatch(/transitionOrder|cancellationStatusForActor/);
  });

  it('only releases an order to the shop when it is fully paid', () => {
    expect(codeOnly('src/lib/payments/manual.ts')).toMatch(
      /paymentStatus === PaymentStatus\.PAID &&\s*order\.status === OrderStatus\.PENDING_PAYMENT/,
    );
  });
});

describe('an order that dies gives the money back', () => {
  it('settles both halves from one place', () => {
    // The bug this replaced: three call sites each refunded credits, and none
    // noticed that a transfer-paid order has no credits to refund — so the
    // cash stayed with us, silently, on every cancelled prepaid order.
    for (const file of [
      'src/lib/actions/checkout-actions.ts',
      'src/lib/actions/merchant-actions.ts',
      'src/lib/orders/maintenance.ts',
    ]) {
      expect(codeOnly(file), file).toMatch(/settleCancelledOrder\(/);
    }
  });

  it('tells the customer money is coming without inventing a deadline', () => {
    const maintenance = source('src/lib/orders/maintenance.ts');
    expect(maintenance).toMatch(/PAYMENT_REFUND_DUE/);
    // "Refund sent" at cancellation time would be a lie with a number on it,
    // and a promise of a date we cannot keep is a complaint we invented. Read
    // off the RENDERED message rather than the file, so the docstring
    // explaining the rule cannot satisfy it.
    const rendered = renderNotification(NotificationKind.PAYMENT_REFUND_DUE, {
      orderNumber: 'DA-20260908-ABCDE',
      amountCentavos: 32_400,
      paymentLabel: 'GCash',
    });
    expect(rendered.title).toMatch(/Refund on the way/);
    expect(`${rendered.title} ${rendered.body} ${rendered.sms}`).toMatch(/₱324\.00/);
    for (const promise of ['24 hours', '48 hours', 'business day', 'within a day']) {
      expect(`${rendered.body} ${rendered.sms}`, promise).not.toContain(promise);
    }
  });

  it('does not write a refund row for money nobody has sent', () => {
    const maintenance = codeOnly('src/lib/orders/maintenance.ts');
    const settle = maintenance.slice(maintenance.indexOf('export async function settleCancelledOrder'));
    const body = settle.slice(0, settle.indexOf('\nexport '));
    expect(body).not.toMatch(/REFUND_ISSUED/);
  });
});
