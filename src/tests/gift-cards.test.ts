import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAction, Prisma, WalletTransactionType } from '@prisma/client';
import {
  GIFT_CODE_ALPHABET,
  GIFT_CODE_LENGTH,
  MAX_GIFT_CARD_CENTAVOS,
  REFUSAL_TEXT,
  formatGiftCode,
  giftCardStatus,
  giftCodeLooksPlausible,
  isOutstanding,
  ledgerDescriptionFor,
  normaliseGiftCode,
  outstandingCentavos,
  refusalForStatus,
  type GiftCardRefusal,
  type GiftCardStatus,
} from '@/lib/gift-cards/policy';
import { generateGiftCode, generateReference, hashGiftCode } from '@/lib/gift-cards/codes';
import {
  MAX_ATTEMPTS,
  isSerializationConflict,
  withSerializationRetry,
} from '@/lib/db/serializable';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';

/**
 * Gift cards.
 *
 * Two ideas carry this file.
 *
 * **A gift card is a bearer instrument.** The string is worth money to whoever
 * holds it, which inverts every defence a promo code uses: entropy instead of
 * caps, a hash at rest instead of a public code, and a precise refusal instead
 * of a deliberately uniform one. Most of what follows is about the string.
 *
 * **It is not a top-up.** The hard constraints in `wallet/ledger.ts` say a
 * customer cannot turn their own cash into a balance and cannot move a balance
 * to somebody else. A card a customer could BUY would be both at once, so the
 * tests here pin down that this one is issued by us and lands in exactly one
 * wallet.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

function codeOnly(relativePath: string): string {
  return stripComments(source(relativePath));
}

const JAN = new Date('2026-01-10T08:00:00Z');
const card = (over: Partial<Parameters<typeof giftCardStatus>[0]> = {}) => ({
  redeemedAt: null,
  voidedAt: null,
  expiresAt: null,
  ...over,
});

// =============================================================================
describe('a card a customer could buy would break two hard constraints', () => {
  it('is issued by an administrator, never bought', () => {
    // `issueGiftCard` demands an `issuedById` and there is no price, no
    // payment, and no purchaser. If a customer could pay for one, their cash
    // would be becoming a balance — constraint 1 — and then moving to
    // somebody else — constraint 2.
    const issue = codeOnly('src/lib/gift-cards/issue.ts');
    expect(issue).toMatch(/issuedById: string;/);
    for (const forbidden of ['purchase', 'buyGiftCard', 'sellGiftCard', 'priceCentavos', 'payerId']) {
      expect(issue, `issue.ts names "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('credits exactly one wallet, and names no second party', () => {
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    for (const twoParty of [
      'fromUserId',
      'toUserId',
      'senderUserId',
      'recipientUserId',
      'fromWalletId',
      'toWalletId',
    ]) {
      expect(redeem, `redeem.ts names "${twoParty}"`).not.toContain(twoParty);
    }
    // One grant call, one wallet.
    expect((redeem.match(/grantCredit\(/g) ?? []).length).toBe(1);
  });

  it('goes through the one ledger function and writes no balance itself', () => {
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    expect(redeem).toMatch(/grantCredit\(/);
    // It must not WRITE a balance or a ledger row. It legitimately READS the
    // balance `grantCredit` reports back, to show the customer — so this
    // checks the write paths by name rather than looking for the word
    // `balanceCentavos` anywhere, which is what the first version did and
    // which flagged the return value.
    expect(redeem).not.toMatch(/wallet\.update/);
    expect(redeem).not.toMatch(/walletTransaction\.create/);
    expect(redeem).not.toMatch(/balanceCentavos:\s*(?:next|new|priorBalance|\d)/);
  });

  it('spells out in the ledger that a gift card is not a top-up', () => {
    // The "do not add these" block is the durable record of the constraint,
    // and "let customers buy gift cards" is the shape the request arrives in.
    const ledger = source('src/lib/wallet/ledger.ts');
    expect(ledger).toMatch(/sellGiftCard\(\)/);
    expect(ledger).toMatch(/top-up wearing a bow/);
  });
});

// =============================================================================
describe('the code, and why guessing it is hopeless', () => {
  it('has a frozen alphabet', () => {
    // Asserted EXACTLY, because narrowing it later would make a character
    // that used to be valid start being stripped — so a card printed last
    // year would stop matching its own hash and become an unredeemable piece
    // of paper somebody is holding.
    expect(GIFT_CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRTUVWXYZ23456789');
    expect(GIFT_CODE_ALPHABET).toHaveLength(30);
  });

  it('excludes both halves of every confusable pair', () => {
    // Excluding BOTH is what makes stripping safe rather than a guess: since
    // no valid code contains an O, a typed O cannot be silently read as a zero
    // belonging to some other real code.
    for (const confusable of ['O', '0', 'I', '1', 'L', 'S']) {
      expect(GIFT_CODE_ALPHABET, `alphabet contains ${confusable}`).not.toContain(
        confusable,
      );
    }
  });

  it('is long enough that a throttle is not the defence', () => {
    // 30^16 ≈ 4.3e23, about 78 bits. The point of checking the arithmetic is
    // that shortening the code is the tempting change, and it is the one that
    // silently turns entropy into a rate-limiting problem.
    const keyspace = Math.log2(GIFT_CODE_ALPHABET.length ** GIFT_CODE_LENGTH);
    expect(keyspace).toBeGreaterThan(70);
  });

  it('generates codes from the alphabet, at full length, without repeating', () => {
    const codes = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const code = generateGiftCode();
      expect(code).toHaveLength(GIFT_CODE_LENGTH);
      expect(giftCodeLooksPlausible(code)).toBe(true);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  it('uses a CSPRNG, not Math.random', () => {
    // Math.random is predictable from a few observed outputs, and we hand
    // codes out — so somebody who redeemed two cards from a printed batch
    // could compute the rest of it.
    const codes = codeOnly('src/lib/gift-cards/codes.ts');
    expect(codes).toMatch(/randomInt/);
    expect(codes).not.toMatch(/Math\.random/);
  });

  it('draws the reference independently of the code', () => {
    // A reference derived from the code would leak part of the secret into
    // every screen, log line and backup that holds a reference.
    const references = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const reference = generateReference();
      expect(reference).toMatch(/^GC-[A-Z0-9]{6}$/);
      references.add(reference);
    }
    expect(references.size).toBeGreaterThan(95);
  });
});

// =============================================================================
describe('hashing, and what a leaked database is worth', () => {
  it('stores a 64-character hex digest', () => {
    expect(hashGiftCode('ABCDEFGHJKMNPQRT')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across every form a human types', () => {
    const bare = 'PB7AENJ337R2E9MZ';
    for (const variant of [
      bare,
      bare.toLowerCase(),
      formatGiftCode(bare),
      `  ${formatGiftCode(bare).toLowerCase()}\n`,
      bare.replace(/(.{4})/g, '$1 ').trim(),
      // An em dash, the way a word processor autocorrects a hyphen.
      formatGiftCode(bare).replace(/-/g, '—'),
    ]) {
      expect(hashGiftCode(variant), `variant "${variant}"`).toBe(hashGiftCode(bare));
    }
  });

  it('does not depend on AUTH_SECRET', () => {
    // Deliberate: an HMAC would make rotating that secret — a routine security
    // action — silently void every card in circulation. There is no dictionary
    // to attack at 78 bits, so a key protects nothing here and would cost a
    // drawer of printed cards.
    const codes = codeOnly('src/lib/gift-cards/codes.ts');
    expect(codes).toMatch(/createHash/);
    expect(codes).not.toMatch(/createHmac/);
    expect(codes).not.toMatch(/authSecret/);
    expect(codes).not.toMatch(/AUTH_SECRET/);
  });

  it('never puts the code in anything that gets persisted', () => {
    // The ledger description is written to an append-only table that appears
    // in every backup. It takes a REFERENCE, and it takes one argument so it
    // cannot be handed both and pick wrong.
    expect(ledgerDescriptionFor('GC-7K2MPQ')).toBe('GC-7K2MPQ');
    expect(ledgerDescriptionFor.length).toBe(1);
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    expect(redeem).toMatch(/ledgerDescriptionFor\(card\.reference\)/);
    // The metadata written alongside it, too.
    expect(redeem).not.toMatch(/metadata:\s*\{[^}]*code/);
  });

  it('keeps the code out of the audit row', () => {
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    const issue = actions.slice(actions.indexOf('issueGiftCardAction'));
    const auditRow = issue.slice(issue.indexOf('recordAdminAction'), issue.indexOf('return issued'));
    expect(auditRow).toMatch(/reference/);
    expect(auditRow).not.toMatch(/\bcode\b/);
  });
});

// =============================================================================
describe('normalising strips formatting and refuses prose', () => {
  it('accepts every separator a human or a keyboard inserts', () => {
    const bare = 'PB7AENJ337R2E9MZ';
    expect(normaliseGiftCode('pb7a-enj3-37r2-e9mz')).toBe(bare);
    expect(normaliseGiftCode('PB7A ENJ3 37R2 E9MZ')).toBe(bare);
    expect(normaliseGiftCode('\tPB7A ENJ3–37R2—E9MZ\r\n')).toBe(bare);
  });

  it('does NOT mine a sentence for sixteen letters', () => {
    // The defect the live-database run caught. Stripping everything outside
    // the alphabet turned these into well-formed codes that are NOT the one in
    // the customer's hand — and with enough cards issued, one of them is
    // eventually somebody else's.
    for (const prose of [
      'Code: PB7A-ENJ3-37R2-E9MZ',
      'Your gift card: PB7A-ENJ3-37R2-E9MZ',
    ]) {
      const normalised = normaliseGiftCode(prose);
      expect(normalised).not.toBe('PB7AENJ337R2E9MZ');
      expect(
        giftCodeLooksPlausible(normalised),
        `"${prose}" normalised to a plausible code`,
      ).toBe(false);
    }
  });

  it('does not truncate a longer string down to a plausible code', () => {
    // Cutting to sixteen characters is the same guess by another route: two
    // codes pasted together are not the first one.
    const two = 'PB7AENJ337R2E9MZ' + 'H7KM3PQR9TVW24XY';
    expect(giftCodeLooksPlausible(normaliseGiftCode(two))).toBe(false);
  });

  it('never folds a confusable onto a valid character', () => {
    // A typed O must not become a zero, because the referral bug was exactly
    // this: a typo resolving to a different real code. Here it would redeem a
    // stranger's money.
    const withO = 'PB7AENJ337R2E9MO';
    expect(giftCodeLooksPlausible(normaliseGiftCode(withO))).toBe(false);
  });

  it('refuses anything that is not exactly the right length', () => {
    expect(giftCodeLooksPlausible('PB7AENJ337R2E9M')).toBe(false);
    expect(giftCodeLooksPlausible('PB7AENJ337R2E9MZZ')).toBe(false);
    expect(giftCodeLooksPlausible('PB7AENJ337R2E9MZ')).toBe(true);
  });

  it('is refused before any database work', () => {
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    const body = redeem.slice(redeem.indexOf('export async function redeemGiftCard'));
    expect(body.indexOf('giftCodeLooksPlausible')).toBeLessThan(
      body.indexOf('prisma.$transaction'),
    );
  });

  it('groups a code for display without changing what is hashed', () => {
    expect(formatGiftCode('PB7AENJ337R2E9MZ')).toBe('PB7A-ENJ3-37R2-E9MZ');
  });
});

// =============================================================================
describe('what state a card is in, derived from three timestamps', () => {
  it('is ISSUED when nothing has happened', () => {
    expect(giftCardStatus(card(), JAN)).toBe('ISSUED');
  });

  it('is ISSUED right up to the instant it expires', () => {
    expect(giftCardStatus(card({ expiresAt: new Date(JAN.getTime() + 1) }), JAN)).toBe(
      'ISSUED',
    );
    expect(giftCardStatus(card({ expiresAt: JAN }), JAN)).toBe('EXPIRED');
  });

  it('reports REDEEMED even after the expiry has passed', () => {
    // The branch order is the whole content. A card redeemed in January and
    // "expiring" in February is redeemed for good: the money moved, and an
    // expiry cannot un-move it. Getting this backwards makes old cards read as
    // expired, which is how one gets handed out twice.
    const redeemed = card({
      redeemedAt: new Date('2026-01-05T00:00:00Z'),
      expiresAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(giftCardStatus(redeemed, new Date('2026-03-01T00:00:00Z'))).toBe('REDEEMED');
  });

  it('reports REDEEMED over VOID, for data the database refuses anyway', () => {
    expect(giftCardStatus(card({ redeemedAt: JAN, voidedAt: JAN }), JAN)).toBe('REDEEMED');
    expect(source('prisma/sql/gift_cards.sql')).toMatch(/gift_card_not_redeemed_and_void/);
  });

  it('never stores the status', () => {
    // A `status` column beside the timestamps would be a second truth, and the
    // first time it drifted a redeemed card would read as issued.
    expect(source('prisma/schema.prisma')).not.toMatch(/GiftCardStatus/);
    const model = source('prisma/schema.prisma').match(/model GiftCard \{[\s\S]*?\n\}/)![0];
    expect(model).not.toMatch(/^\s*status\s/m);
  });

  it('maps each state to its own refusal, and covers all four', () => {
    const statuses: GiftCardStatus[] = ['ISSUED', 'REDEEMED', 'VOID', 'EXPIRED'];
    const refusals = statuses.map(refusalForStatus);
    expect(refusals).toEqual([null, 'ALREADY_REDEEMED', 'VOIDED', 'EXPIRED']);
  });
});

// =============================================================================
describe('the refusals say which, unlike a promo code', () => {
  it('gives every refusal its own distinct sentence', () => {
    const refusals: GiftCardRefusal[] = [
      'MALFORMED',
      'UNKNOWN',
      'ALREADY_REDEEMED',
      'VOIDED',
      'EXPIRED',
    ];
    const sentences = refusals.map((refusal) => REFUSAL_TEXT[refusal]);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(20);
    }
    // DISTINCT, which is the opposite of the promo field's deliberately
    // uniform answer. There is no oracle to protect at 78 bits, and somebody
    // holding a physical card needs to know whether it was already used,
    // whether it lapsed, or whether they misread a letter.
    expect(new Set(sentences).size).toBe(refusals.length);
  });

  it('tells an already-redeemed holder to ask their household', () => {
    expect(REFUSAL_TEXT.ALREADY_REDEEMED).toMatch(/household/);
  });

  it('has no refusal for a frozen balance', () => {
    // It would be a branch that can never be taken: the ledger blocks a freeze
    // against DEBITS only. It is also the right behaviour — a card that landed
    // in a held balance is recoverable, while a wasted card is not.
    expect(Object.keys(REFUSAL_TEXT)).not.toContain('CREDITS_FROZEN');
    expect(source('src/lib/gift-cards/policy.ts')).toMatch(
      /There is deliberately NO refusal for a frozen balance/,
    );
  });
});

// =============================================================================
describe('redemption cannot happen twice', () => {
  it('claims the card with a compare-and-set, and checks the row count', () => {
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    // `updateMany ... where redeemedAt: null` is atomic in Postgres at any
    // isolation level, so it holds even for a future caller who forgets to
    // use a transaction.
    expect(redeem).toMatch(/updateMany\(\{[\s\S]*?redeemedAt: null/);
    expect(redeem).toMatch(/if \(count !== 1\)/);
    expect(redeem).not.toMatch(/giftCard\.update\(\{/);
  });

  it('writes the ledger row inside the same transaction, before the claim', () => {
    // It has to be before: the CHECK constraint requires redeemedAt and
    // walletTransactionId to be set together, and a CHECK cannot be deferred.
    // If the claim then loses, the whole transaction rolls back.
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    const body = redeem.slice(redeem.indexOf('prisma.$transaction'));
    expect(body.indexOf('grantCredit(')).toBeLessThan(body.indexOf('updateMany('));
    expect(redeem).toMatch(/Prisma\.TransactionIsolationLevel\.Serializable/);
    expect(source('prisma/sql/gift_cards.sql')).toMatch(
      /\("redeemedAt" IS NULL\) = \("walletTransactionId" IS NULL\)/,
    );
  });

  it('keys the grant on the card, so a retry credits once', () => {
    expect(codeOnly('src/lib/gift-cards/redeem.ts')).toMatch(
      /idempotencyKey: `gift-card:\$\{card\.id\}`/,
    );
  });

  it('treats a collision on that key as already-redeemed, not as a crash', () => {
    // The independent second barrier. Two transactions that somehow both got
    // past the compare-and-set collide on the unique idempotency key, and the
    // customer-facing answer has to be the same sentence either way.
    const redeem = codeOnly('src/lib/gift-cards/redeem.ts');
    expect(redeem).toMatch(/error\.code === 'P2002'/);
    expect(redeem).toMatch(/idempotencyKey/);
    expect((redeem.match(/refuse\('ALREADY_REDEEMED'\)/g) ?? []).length).toBe(2);
  });

  it('is backstopped by the database refusing to rewrite an outcome', () => {
    const guards = source('prisma/sql/gift_cards.sql');
    expect(guards).toMatch(/is already redeemed/);
    expect(guards).toMatch(/is already void/);
    expect(guards).toMatch(/gift_card_no_rewrite/);
  });

  it('makes the terms immutable, so a card cannot be revalued after printing', () => {
    const guards = source('prisma/sql/gift_cards.sql');
    expect(guards).toMatch(/codeHash is immutable/);
    expect(guards).toMatch(/amountCentavos is immutable/);
  });
});

// =============================================================================
describe('retrying a serialization conflict', () => {
  const conflict = () =>
    new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });

  it('recognises P2034 and nothing else', () => {
    expect(isSerializationConflict(conflict())).toBe(true);
    expect(isSerializationConflict(new Error('nope'))).toBe(false);
    expect(
      isSerializationConflict(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
  });

  it('retries a conflict and returns the eventual success', async () => {
    let attempts = 0;
    const result = await withSerializationRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw conflict();
      return 'done';
    });
    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  it('never retries a decision', async () => {
    // Retrying a refusal makes the same refusal slower — and for anything that
    // consumes a single-use token, a retry that succeeded on the second pass
    // would be the app doing the thing it had just refused.
    let attempts = 0;
    await expect(
      withSerializationRetry(async () => {
        attempts += 1;
        throw new Error('already redeemed');
      }),
    ).rejects.toThrow('already redeemed');
    expect(attempts).toBe(1);
  });

  it('gives up after the fixed number of attempts and rethrows', async () => {
    let attempts = 0;
    await expect(
      withSerializationRetry(async () => {
        attempts += 1;
        throw conflict();
      }),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(attempts).toBe(MAX_ATTEMPTS);
  });
});

// =============================================================================
describe('what is still outstanding', () => {
  it('counts issued cards and nothing else', () => {
    const cards = [
      { ...card(), amountCentavos: 25_000 },
      { ...card({ redeemedAt: JAN }), amountCentavos: 50_000 },
      { ...card({ voidedAt: JAN }), amountCentavos: 10_000 },
      { ...card({ expiresAt: new Date('2026-01-01T00:00:00Z') }), amountCentavos: 99_000 },
      { ...card({ expiresAt: new Date('2027-01-01T00:00:00Z') }), amountCentavos: 5_000 },
    ];
    // The live one and the not-yet-expired one. A redeemed card is the credits
    // ledger's liability now, not this table's — counting it in both places
    // would double the figure.
    expect(outstandingCentavos(cards, JAN)).toBe(30_000);
  });

  it('treats exactly one state as outstanding', () => {
    const statuses: GiftCardStatus[] = ['ISSUED', 'REDEEMED', 'VOID', 'EXPIRED'];
    expect(statuses.filter(isOutstanding)).toEqual(['ISSUED']);
  });

  it('is totalled by a QUERY, not from the page of rows on screen', () => {
    // The list is capped for the screen's sake, and a liability computed from
    // a truncated list would understate itself the day somebody issues the
    // 201st card.
    const admin = codeOnly('src/lib/admin/gift-cards.ts');
    expect(admin).toMatch(/take: 200/);
    expect(admin).toMatch(/giftCard\.aggregate\(/);
    const totals = admin.slice(admin.indexOf('giftCard.aggregate('));
    expect(totals).toMatch(/redeemedAt: null/);
    expect(totals).toMatch(/voidedAt: null/);
    expect(totals).toMatch(/expiresAt: null/);
  });

  it('says on the console that the money is on paper', () => {
    expect(source('src/app/admin/gift-cards/page.tsx')).toMatch(
      /on paper you no\s*\n?\s*longer control/,
    );
  });
});

// =============================================================================
describe('a card is bounded, and cancelling one is a decision', () => {
  it('caps a single card, in the module and in SQL', () => {
    expect(MAX_GIFT_CARD_CENTAVOS).toBe(500_000);
    expect(source('prisma/sql/gift_cards.sql')).toMatch(
      /"amountCentavos" > 0 AND "amountCentavos" <= 500000/,
    );
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(/MAX_GIFT_CARD_CENTAVOS/);
  });

  it('refuses to cancel a redeemed card, and says what to do instead', () => {
    const issue = source('src/lib/gift-cards/issue.ts');
    expect(issue).toMatch(/already been redeemed/);
    expect(issue).toMatch(/adjustment instead/);
  });

  it('compare-and-sets the cancellation too', () => {
    // Between reading the card and cancelling it, somebody holding it may have
    // redeemed it — and cancelling a card whose money has moved would leave
    // the row saying one thing and the ledger another.
    const issue = codeOnly('src/lib/gift-cards/issue.ts');
    const voidFn = issue.slice(issue.indexOf('export async function voidGiftCard'));
    expect(voidFn).toMatch(/updateMany\(\{[\s\S]*?redeemedAt: null, voidedAt: null/);
    expect(voidFn).toMatch(/if \(count !== 1\)/);
  });

  it('defaults an expiry to never, and names the law on the form', () => {
    // RA 10962 says gift checks sold in the Philippines may not expire. A card
    // given away is arguably not one that was sold — a question for a lawyer,
    // not for the form, which is why the default is never.
    expect(source('prisma/schema.prisma')).toMatch(/RA 10962/);
    expect(source('src/app/admin/gift-cards/page.tsx')).toMatch(/RA 10962/);
    const model = source('prisma/schema.prisma').match(/model GiftCard \{[\s\S]*?\n\}/)![0];
    expect(model).toMatch(/expiresAt DateTime\?/);
    expect(model).not.toMatch(/expiresAt DateTime\?\s*@default/);
  });
});

// =============================================================================
describe('issuing is an audited decision, and the code shows once', () => {
  it('names both actions in the log’s vocabulary', () => {
    for (const action of [AdminAction.GIFT_CARD_ISSUED, AdminAction.GIFT_CARD_VOIDED]) {
      expect(ADMIN_ACTION_LABEL[action].length).toBeGreaterThan(5);
    }
  });

  it('demands a reason and writes an audit row for each', () => {
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    const bodyOf = (name: string): string => {
      const start = actions.indexOf(`export async function ${name}(`);
      expect(start, `${name} should exist`).toBeGreaterThan(-1);
      const rest = actions.slice(start + 1);
      const end = rest.indexOf('export async function ');
      return end === -1 ? rest : rest.slice(0, end);
    };
    for (const [name, action] of Object.entries({
      issueGiftCardAction: 'GIFT_CARD_ISSUED',
      voidGiftCardAction: 'GIFT_CARD_VOIDED',
    })) {
      const body = bodyOf(name);
      expect(body).toContain(`AdminAction.${action}`);
      expect(body).toContain("normaliseReason(formData.get('reason'))");
      expect(body).toContain('await recordAdminAction(');
    }
  });

  it('says the code cannot be shown again, where it is shown', () => {
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(/COPY IT NOW/);
    expect(source('src/app/admin/gift-cards/page.tsx')).toMatch(
      /The code shows once/,
    );
  });

  it('returns the code once and stores only a hash', () => {
    const issue = codeOnly('src/lib/gift-cards/issue.ts');
    expect(issue).toMatch(/codeHash,/);
    // No column named `code`, and the guard file asserts that too.
    expect(issue).not.toMatch(/data: \{[\s\S]{0,200}\bcode:/);
    expect(source('prisma/sql/gift_cards.sql')).toMatch(
      /looks like it holds the code in plaintext/,
    );
  });

  it('retries a reference collision but never a code collision', () => {
    // A six-character reference is a birthday problem worth handling. A
    // collision on a 78-bit code would mean a broken CSPRNG, and retrying it
    // would paper over exactly the failure worth hearing about.
    const issue = codeOnly('src/lib/gift-cards/issue.ts');
    expect(issue).toMatch(/includes\('reference'\)/);
    expect(issue).not.toMatch(/includes\('codeHash'\)/);
  });
});

// =============================================================================
describe('the customer’s screen', () => {
  it('owns the field and the outcome together', () => {
    // The RedeemPoints lesson: redeeming changes the balance, the change
    // refreshes the page, and a confirmation rendered by the PAGE would be
    // replaced by that refresh — leaving somebody who just added ₱250 with a
    // screen that says nothing.
    const field = codeOnly('src/components/credits/RedeemGiftCard.tsx');
    expect(field).toMatch(/useState<\{ ok: boolean; message: string \} \| null>/);
    expect(field).toMatch(/router\.refresh\(\)/);
  });

  it('keeps a refused code in the field so one letter can be fixed', () => {
    const field = codeOnly('src/components/credits/RedeemGiftCard.tsx');
    const submit = field.slice(field.indexOf('function submit'));
    expect(submit).toMatch(/if \(outcome\.ok\) \{[\s\S]*?setDraft\(''\)/);
  });

  it('computes no money and validates nothing load-bearing', () => {
    const field = codeOnly('src/components/credits/RedeemGiftCard.tsx');
    expect(field).not.toMatch(/hashGiftCode/);
    expect(field).not.toMatch(/amountCentavos =/);
  });

  it('resolves the customer from the session, never from an argument', () => {
    const action = codeOnly('src/lib/actions/gift-card-actions.ts');
    expect(action).toMatch(/requireOnboardedUser\(\)/);
    expect(action).toMatch(/userId: user\.id/);
    expect(action).not.toMatch(/userId: string/);
  });

  it('names gift cards among where credits come from', () => {
    // The header on /credits lists the sources. A new one that is not in that
    // list is a source the customer cannot account for.
    expect(source('src/app/credits/page.tsx')).toMatch(/gift cards/);
    expect(source('src/app/credits/page.tsx')).toMatch(
      /\[WalletTransactionType\.GIFT_CARD\]: 'Gift card'/,
    );
  });

  it('still says the credits rules have not changed', () => {
    // A gift card adds a way IN. It must not read as making credits
    // transferable or loadable, because it does neither.
    const page = source('src/app/credits/page.tsx');
    expect(page).toMatch(/cannot load your own money into it/);
    expect(page).toMatch(/cannot be sent to another person/);
  });
});

// =============================================================================
describe('the ledger row a redemption leaves', () => {
  it('is a GIFT_CARD row', () => {
    expect(WalletTransactionType.GIFT_CARD).toBe('GIFT_CARD');
    expect(codeOnly('src/lib/gift-cards/redeem.ts')).toMatch(
      /type: WalletTransactionType\.GIFT_CARD/,
    );
  });

  it('is positive-only in SQL as well as in TypeScript', () => {
    expect(source('prisma/sql/wallet_append_only.sql')).toMatch(
      /'PROMO_CREDIT', 'REFUND', 'REFERRAL_BONUS', 'GIFT_CARD'\) AND "amountCentavos" > 0/,
    );
  });
});
