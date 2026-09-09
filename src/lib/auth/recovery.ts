import { EmailCodePurpose, RecoveryMethod, type AccountRecovery } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { normalisePhilippineMobile, maskPhilippineMobile } from '@/lib/auth/phone';
import { normaliseEmail } from '@/lib/auth/email/address';
import { sendEmailCode, verifyEmailCode } from '@/lib/auth/email-codes';
import { isEmailConfigured } from '@/lib/auth/email';
import { formatDayIn } from '@/lib/time/manila';

/**
 * Moving an account to a new phone number.
 *
 * The phone number IS the identity here, so this is the most dangerous
 * operation in the system: whoever holds it holds the credits balance, the
 * order history and every saved address. Everything below is arranged around
 * one idea — **make a successful takeover worthless rather than merely
 * difficult**, because "difficult" is a bet against an attacker's patience and
 * "worthless" is not.
 *
 * Four controls do that, and each one matters on its own:
 *
 *  1. **Two channels, not one.** A code to an address that was verified BEFORE
 *     the number was lost, and then a code to the new number. Email alone
 *     never grants a session and never moves anything; it only earns the right
 *     to prove control of a new number. Somebody who reads one inbox has not
 *     got in.
 *  2. **The credits balance is frozen for three days.** This is the control
 *     that removes the prize. Taking over an account buys a balance that
 *     cannot be spent until long after the alert has landed.
 *  3. **The old number is told.** Sent to `previousPhone`, which after the
 *     change survives nowhere else — which is precisely why the recovery row
 *     keeps it.
 *  4. **Every session dies.** Including the attacker's, if they had one.
 *
 * The remaining hole is honest and worth writing down: somebody who controls
 * both the old email and the new phone can do this, and no amount of
 * cleverness here changes that. What the freeze and the alert buy is time for
 * the real owner to notice.
 */

/**
 * How long credits are held after the identity moves.
 *
 * Three days is chosen against the alert, not against the attacker: it is long
 * enough that an SMS to the old number, an email, and a push have all had time
 * to be read even by somebody who was travelling. Shortening it is the single
 * easiest way to make this feature dangerous.
 */
export const RECOVERY_CREDIT_FREEZE_DAYS = 3;

export const RECOVERY_FREEZE_REASON =
  'Cooling-off period after the sign-in number for this account was changed. ' +
  'Credits become spendable again automatically.';

export class RecoveryUnavailableError extends Error {
  constructor() {
    super(
      'Recovery by email is not available: no email provider is configured. ' +
        'Somebody who has lost their number needs support to move it.',
    );
    this.name = 'RecoveryUnavailableError';
  }
}

export class PhoneAlreadyInUseError extends Error {
  constructor() {
    // Deliberately says "already in use" and not whose. An error naming the
    // owner turns this form into a way to check whether a number has an
    // account.
    super('That number already belongs to an account. Sign in with it instead.');
    this.name = 'PhoneAlreadyInUseError';
  }
}

export class RecoveryNotStartedError extends Error {
  constructor() {
    super('Start again — the emailed code has expired or was already used.');
    this.name = 'RecoveryNotStartedError';
  }
}

export class SamePhoneError extends Error {
  constructor() {
    super('That is already the number on this account.');
    this.name = 'SamePhoneError';
  }
}

export function recoveryFreezeEnd(from: Date): Date {
  return new Date(from.getTime() + RECOVERY_CREDIT_FREEZE_DAYS * 24 * 60 * 60 * 1000);
}

// -----------------------------------------------------------------------------
// Step 1 — prove the email
// -----------------------------------------------------------------------------

/**
 * Sends a recovery code, if that address is a verified one on some account.
 *
 * Returns the same thing either way. A caller that reported "no account with
 * that address" would let anybody test a list of email addresses against the
 * customer base, and the person who genuinely mistyped their own address is
 * helped by "check your inbox" plus a working resend, not by confirmation that
 * they are a stranger here.
 */
export async function requestRecoveryCode(input: {
  email: string;
  requestIp?: string | undefined;
  now?: Date;
}): Promise<void> {
  if (!isEmailConfigured()) throw new RecoveryUnavailableError();

  const email = normaliseEmail(input.email);
  const user = await prisma.user.findFirst({
    // BOTH conditions. An address somebody typed and never confirmed proves
    // nothing about who holds it, so it cannot start a recovery.
    where: { email, emailVerifiedAt: { not: null } },
    select: { id: true },
  });

  if (!user) {
    // Nothing sent, nothing said. The timing difference between this branch
    // and the one below is real and not worth closing here — an attacker who
    // can measure it learns one bit, and the freeze is what protects the
    // account either way.
    return;
  }

  await sendEmailCode({
    email,
    purpose: EmailCodePurpose.ACCOUNT_RECOVERY,
    ...(input.requestIp === undefined ? {} : { requestIp: input.requestIp }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/**
 * Checks the emailed code and reports which account it unlocks.
 *
 * Consumes the code, so this is called once — the caller holds the resulting
 * `userId` for the phone-proving step. It does NOT create a session and does
 * not change anything: at this point the person has proved they hold an old
 * address, which is half of what is needed.
 */
export async function verifyRecoveryEmail(input: {
  email: string;
  code: string;
  now?: Date;
}): Promise<
  | { ok: true; userId: string; currentPhone: string }
  | { ok: false; message: string }
> {
  const email = normaliseEmail(input.email);
  const result = await verifyEmailCode({
    email,
    purpose: EmailCodePurpose.ACCOUNT_RECOVERY,
    code: input.code,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  if (!result.ok) return { ok: false, message: result.message };

  const user = await prisma.user.findFirst({
    where: { email, emailVerifiedAt: { not: null } },
    select: { id: true, phone: true },
  });
  if (!user) {
    // The address was verified when the code was minted and is not now — the
    // owner changed or removed it in the last five minutes. Refusing is
    // correct: the thing that was proved no longer identifies an account.
    return { ok: false, message: 'That address is no longer set up for recovery.' };
  }

  return { ok: true, userId: user.id, currentPhone: user.phone };
}

// -----------------------------------------------------------------------------
// Step 2 — prove the new number, and move
// -----------------------------------------------------------------------------

export interface CompleteRecoveryInput {
  userId: string;
  /** Already proved by an OTP to that number — see `movePhoneNumber`. */
  newPhone: string;
  /** The address that proved step 1, for the record. */
  viaEmail: string;
  now?: Date;
}

/**
 * The move itself, for self-service recovery.
 *
 * Everything in one transaction, because a half-applied identity change is the
 * worst possible state: a number moved with no freeze is a stolen balance, and
 * a freeze with no move is a customer locked out of their own credits.
 */
export async function completeRecovery(
  input: CompleteRecoveryInput,
): Promise<AccountRecovery> {
  const now = input.now ?? new Date();
  const newPhone = normalisePhilippineMobile(input.newPhone);

  return prisma.$transaction(async (tx) =>
    movePhoneNumber(
      {
        userId: input.userId,
        newPhone,
        method: RecoveryMethod.VERIFIED_EMAIL,
        viaEmail: normaliseEmail(input.viaEmail),
        now,
      },
      tx,
    ),
  );
}

export interface MovePhoneInput {
  userId: string;
  /** E.164, already normalised. */
  newPhone: string;
  method: RecoveryMethod;
  /** Set for VERIFIED_EMAIL. */
  viaEmail?: string;
  /** Set for SUPPORT_ASSISTED. */
  assistedByUserId?: string;
  reason?: string;
  now: Date;
}

/**
 * The one function that moves an account's phone number.
 *
 * Both routes go through here — self-service and support-assisted — so the
 * four safety controls cannot be forgotten by one caller. It takes a
 * transaction client and expects to be inside one.
 *
 * Deliberately does NOT enqueue the alert to the old number. That message goes
 * to a number this account no longer has, and the notification outbox resolves
 * every recipient from the user row, so it would be sent to the NEW number —
 * to the attacker. The recovery row carries `previousPhone` and the
 * maintenance sweep sends it from there.
 */
export async function movePhoneNumber(
  input: MovePhoneInput,
  tx: PrismaTransactionClient,
): Promise<AccountRecovery> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { id: true, phone: true },
  });

  if (user.phone === input.newPhone) throw new SamePhoneError();

  // Checked inside the transaction. The unique index on `phone` is the real
  // guarantee; this exists to turn a constraint violation into a sentence.
  const taken = await tx.user.findUnique({
    where: { phone: input.newPhone },
    select: { id: true },
  });
  if (taken) throw new PhoneAlreadyInUseError();

  const freezeUntil = recoveryFreezeEnd(input.now);

  await tx.user.update({
    where: { id: user.id },
    data: {
      phone: input.newPhone,
      // The new number was proved by a code, so it is verified — for a
      // support-assisted move it was not, and the caller is trusted instead.
      // Either way the account's own record of "when did we last confirm this
      // number" moves forward, because it did.
      phoneVerifiedAt: input.now,
    },
  });

  // Every session, not just the other ones. The person recovering has no
  // session yet — they sign in afterwards with the new number — and an
  // attacker who had one loses it here.
  await tx.session.deleteMany({ where: { userId: user.id } });

  // The freeze is on the wallet, so the ledger's own spend check enforces it;
  // nothing here has to be remembered by the checkout path. `upsert`, because
  // an account that has never held credits has no wallet row yet and would
  // otherwise silently skip the freeze.
  await tx.wallet.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      isFrozen: true,
      frozenReason: RECOVERY_FREEZE_REASON,
      frozenUntil: freezeUntil,
    },
    update: {
      isFrozen: true,
      frozenReason: RECOVERY_FREEZE_REASON,
      frozenUntil: freezeUntil,
    },
  });

  return tx.accountRecovery.create({
    data: {
      userId: user.id,
      method: input.method,
      previousPhone: user.phone,
      newPhone: input.newPhone,
      viaEmail: input.viaEmail ?? null,
      assistedByUserId: input.assistedByUserId ?? null,
      reason: input.reason ?? null,
      creditsFrozenUntil: freezeUntil,
      createdAt: input.now,
    },
  });
}

// -----------------------------------------------------------------------------
// After the fact
// -----------------------------------------------------------------------------

/** Recoveries whose alert to the old number has not gone out. */
export async function pendingRecoveryAlerts(limit = 50) {
  return prisma.accountRecovery.findMany({
    where: { alertSentAt: null, alertError: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      previousPhone: true,
      newPhone: true,
      creditsFrozenUntil: true,
      method: true,
    },
  });
}

export async function markRecoveryAlertSent(id: string, now = new Date()): Promise<void> {
  await prisma.accountRecovery.update({
    where: { id },
    data: { alertSentAt: now },
  });
}

export async function markRecoveryAlertFailed(id: string, error: string): Promise<void> {
  await prisma.accountRecovery.update({
    where: { id },
    // Recorded rather than retried forever. An alert that cannot be delivered
    // to a dead number is expected — the number was lost, which is why we are
    // here — and a row that says so is more useful than one that keeps trying.
    data: { alertError: error.slice(0, 500) },
  });
}

/** The text sent to the number the account used to have. */
export function recoveryAlertText(recovery: {
  newPhone: string;
  creditsFrozenUntil: Date;
}): string {
  return (
    'TARA: the sign-in number for your account was changed to ' +
    `${maskPhilippineMobile(recovery.newPhone)}. If this was not you, your ` +
    'credits are frozen until ' +
    formatDayIn(recovery.creditsFrozenUntil) +
    ' — contact support from the app now.'
  );
}

/**
 * Lifts freezes whose cooling-off period has run out.
 *
 * Only the recovery freezes: `frozenUntil` is NULL for a fraud review, which
 * ends when a person ends it, so the filter is what keeps this sweep from
 * quietly unfreezing an account somebody froze on purpose.
 */
export async function liftExpiredFreezes(now = new Date()): Promise<number> {
  const { count } = await prisma.wallet.updateMany({
    where: { isFrozen: true, frozenUntil: { lte: now } },
    data: { isFrozen: false, frozenReason: null, frozenUntil: null },
  });
  return count;
}

/** For the profile screen and the console: has this account ever moved? */
export async function listRecoveries(userId: string) {
  return prisma.accountRecovery.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      assistedBy: { select: { fullName: true, phone: true } },
    },
  });
}
