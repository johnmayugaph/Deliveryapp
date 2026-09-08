/**
 * Gift cards: the rules, with no database, no clock and no crypto.
 *
 * ### What a gift card is here, and what it is not
 *
 * It is **not** a card a customer buys. That would need two things this app
 * deliberately does not have: a way for a customer's cash to become a balance
 * (a top-up) and a way for a balance to end up with somebody else (a
 * transfer). Both are named in the "DELIBERATELY ABSENT — do not add these"
 * block at the foot of `wallet/ledger.ts`, and they are the whole reason this
 * product has *credits* rather than a wallet.
 *
 * It **is** an instrument for TARA to give credits away to somebody whose
 * account we do not know: support goodwill for a person who has not signed in
 * yet, a printed card for a launch event, a partner giveaway. It lands as a
 * `GIFT_CARD` row in the credits ledger, which still cannot be transferred or
 * cashed out.
 *
 * ### The one property that makes this different from a promo code
 *
 * A promo code is **public**: it goes on a tarpaulin, its defence is the caps,
 * and secrecy is pointless because a code people say out loud is guessable by
 * construction.
 *
 * A gift card is a **bearer instrument**: the string itself is worth money.
 * So the defences are the opposite pair — enough entropy that guessing is
 * hopeless, and a hash at rest so a leaked backup is not a pile of cash.
 *
 * That inversion also flips the *messages*. A promo code answers "unknown",
 * "expired" and "exhausted" identically, because distinguishing them turns
 * the checkout field into an oracle for finding real codes. Here there is no
 * oracle to protect — you cannot find a 78-bit code by guessing — and the
 * person typing it is holding a physical card. They need to know whether
 * somebody at home already used it, whether it has lapsed, or whether they
 * misread a letter. So each refusal says which. See `REFUSAL_TEXT`.
 *
 * Pure: imports nothing at all.
 */

/**
 * The alphabet a code is drawn from. **This must never change.**
 *
 * Not merely "should not": `normaliseGiftCode` works by STRIPPING every
 * character outside this set, which is what lets somebody type hyphens,
 * spaces and lowercase and still be understood. Narrow the alphabet later and
 * a character that used to be valid starts being stripped — so a card printed
 * last year normalises to fifteen characters, fails to match its own hash, and
 * becomes an unredeemable piece of paper somebody is holding. Outstanding gift
 * cards are money owed to bearers; the alphabet is frozen for their sake.
 *
 * Its content is the same 30 characters the referral codes use, and for the
 * same reason: no O/0, I/1, L or S, because a code is read off a printed card
 * and typed by somebody who did not choose it. Deliberately a copy rather than
 * an import — coupling the two would mean a change made for referral reasons
 * silently reaching into money already in circulation.
 *
 * `src/tests/gift-cards.test.ts` asserts this exact string, so changing it is
 * a failing test that makes somebody read this paragraph.
 */
export const GIFT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ23456789';

/**
 * Sixteen characters from a 30-letter alphabet: 30^16, about 4.3 × 10^23
 * codes, or ~78 bits.
 *
 * Sized so that guessing is hopeless **even with no rate limiting at all**.
 * That is the property worth having: a throttle protects the server from being
 * hammered, but it is configuration, and configuration gets relaxed. Entropy
 * does not get relaxed by accident. At a million guesses a second it would
 * take longer than the age of the universe to expect one hit.
 */
export const GIFT_CODE_LENGTH = 16;

/** Displayed in groups of four, the way every card and voucher is. */
export const GIFT_CODE_GROUP_SIZE = 4;

/**
 * The most one card may be worth. Mirrors `gift_card_amount_is_sane`.
 *
 * Not because a larger gift is unthinkable, but because a single bearer
 * instrument worth more than this is almost always a decimal point in the
 * wrong place — and the recovery from issuing one is finding whoever is
 * holding the paper. Issue several, or use a signed adjustment against an
 * account you can name.
 */
export const MAX_GIFT_CARD_CENTAVOS = 500_000;

// -----------------------------------------------------------------------------
// Reading and writing a code
// -----------------------------------------------------------------------------

/**
 * Groups a bare code for display: `H7KM3PQR9TVW24XY` → `H7KM-3PQR-9TVW-24XY`.
 *
 * Presentation only. What is hashed and compared is always the bare form, so
 * the grouping can change without touching a single stored card.
 */
export function formatGiftCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += GIFT_CODE_GROUP_SIZE) {
    groups.push(code.slice(index, index + GIFT_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Formatting a human or a keyboard inserts into a code, and nothing else:
 * spaces (including the non-breaking one a copy-paste can carry), tabs,
 * newlines, and every dash a word processor might have autocorrected a hyphen
 * into.
 */
const SEPARATORS = /[\s\u00a0\-\u2010\u2011\u2012\u2013\u2014\u2212]+/g;

/**
 * Tidies a code somebody typed or pasted.
 *
 * Uppercased, with FORMATTING removed — the hyphens we printed, the spaces
 * they typed instead, a trailing newline from a paste. Nothing else. Anything
 * left over that is not in the alphabet makes the string implausible, and
 * `giftCodeLooksPlausible` refuses it rather than guessing.
 *
 * ### Why it does not strip everything outside the alphabet
 *
 * That was the first version, and the live-database run caught it. "Strip
 * every character that is not a valid one" sounds like a superset of this and
 * is actually a different, dangerous function, because English prose is made
 * of alphabet characters:
 *
 *     "Code: UMCH-3HG9-MZEJ-Z73F"          -> CDEUMCH3HG9MZEJZ
 *     "Your gift card: UMCH-3HG9-MZEJ-Z73F" -> YURGFTCARDUMCH3H
 *
 * Both of those are well-formed sixteen-character codes that are **not the
 * code the person is holding** — and with enough cards issued, one of them
 * eventually IS somebody else's. That is the referral bug in a new dress: its
 * first version folded confusable characters onto each other, so a typo could
 * resolve to a different real code and attribute somebody to a stranger. Here
 * it would redeem a stranger's money.
 *
 * So: strip formatting, refuse prose. "That does not look like a code" is a
 * worse-feeling answer than silently finding sixteen letters in a sentence,
 * and a far better one.
 *
 * Nor does it truncate to sixteen characters. A longer string is not a code
 * with something extra on the end — it is not a code, and cutting it down is
 * the same guess by another route.
 */
export function normaliseGiftCode(raw: string): string {
  return raw.toUpperCase().replace(SEPARATORS, '');
}

/**
 * Whether a normalised code is worth a database round trip at all.
 *
 * A code that cannot be a code is refused without a lookup: a hash comparison
 * cannot fix a typo, and this field is reachable by anybody with an account.
 */
export function giftCodeLooksPlausible(code: string): boolean {
  if (code.length !== GIFT_CODE_LENGTH) return false;
  for (const character of code) {
    if (!GIFT_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// What state a card is in
// -----------------------------------------------------------------------------

/**
 * The four states a card can be in — derived, never stored.
 *
 * A `status` column beside `redeemedAt`, `voidedAt` and `expiresAt` would be a
 * second truth, and the first time it drifted a redeemed card would read as
 * issued and be handed out again. Same discipline as a wallet balance being
 * the sum of its ledger.
 */
export type GiftCardStatus = 'ISSUED' | 'REDEEMED' | 'VOID' | 'EXPIRED';

/** Just the columns the status depends on. Structural, so a row passes in. */
export interface GiftCardTimestamps {
  redeemedAt: Date | null;
  voidedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * A total function from three timestamps and a clock to one state.
 *
 * The order of the branches is the whole content:
 *
 *  - **Redeemed wins over everything.** A card redeemed in January and
 *    "expiring" in February is REDEEMED for good — the money moved, and an
 *    expiry cannot un-move it. Getting this backwards would make old cards
 *    quietly stop appearing as redeemed, which is how one gets handed out
 *    twice.
 *  - **Void next.** The database already refuses a card that is both
 *    (`gift_card_not_redeemed_and_void`), so this order only decides what to
 *    say about data that cannot exist.
 *  - **Expiry last**, and only for a card that is still live.
 */
export function giftCardStatus(
  card: GiftCardTimestamps,
  now: Date = new Date(),
): GiftCardStatus {
  if (card.redeemedAt !== null) return 'REDEEMED';
  if (card.voidedAt !== null) return 'VOID';
  if (card.expiresAt !== null && card.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return 'ISSUED';
}

/**
 * Whether this card is still money we owe.
 *
 * Exactly one state counts: ISSUED. A redeemed card became a credits balance
 * and is that ledger's liability now, not this table's — counting it in both
 * places would double the figure. A void card is cancelled. An expired one is
 * a decision already taken.
 */
export function isOutstanding(status: GiftCardStatus): boolean {
  return status === 'ISSUED';
}

/**
 * The face value of every card still owed to whoever holds it.
 *
 * The number the console exists to show. A gift card is the first thing in
 * this app that hands *spendable* money to a bearer — a referral needs
 * somebody to sign up and order, loyalty needs somebody to have ordered, a
 * promo code needs an order at checkout — so the total sitting on printed
 * paper is a real liability with no natural ceiling but the one we choose.
 */
export function outstandingCentavos(
  cards: readonly (GiftCardTimestamps & { amountCentavos: number })[],
  now: Date = new Date(),
): number {
  return cards.reduce(
    (total, card) =>
      isOutstanding(giftCardStatus(card, now)) ? total + card.amountCentavos : total,
    0,
  );
}

// -----------------------------------------------------------------------------
// Refusing a redemption
// -----------------------------------------------------------------------------

export type GiftCardRefusal =
  | 'MALFORMED'
  | 'UNKNOWN'
  | 'ALREADY_REDEEMED'
  | 'VOIDED'
  | 'EXPIRED';

/**
 * There is deliberately NO refusal for a frozen balance.
 *
 * The first draft of this union had one, and it would have been a branch that
 * can never be taken: `recordWalletTransaction` blocks a freeze only against
 * DEBITS, on the stated grounds that a refund into a frozen balance must still
 * land or a cancellation during the freeze loses somebody's money. A gift card
 * is a credit, so it lands.
 *
 * That is also the right behaviour on its own terms. Consider the case the
 * freeze exists for: somebody has taken over an account by moving its phone
 * number, and credits are held for three days. If a gift card could be
 * refused, the holder would burn an attempt and be told to come back — but if
 * it lands, the thief gains nothing (the balance is unspendable and the real
 * owner recovers it) and the card is not wasted. Refusing would protect
 * nobody and cost the cardholder their card.
 */

/**
 * What the person holding the card is told.
 *
 * Each refusal says which, unlike the promo field's deliberately uniform
 * answer — see the note at the top of this file. The distinction is safe here
 * (a 78-bit code cannot be found by guessing) and it is the *only* useful
 * thing to say to somebody standing there with a card in their hand: "already
 * used" sends them to ask their family, "expired" sends them to us, and "not
 * recognised" sends them to re-read the letters.
 *
 * Compile-enforced over the union, so a new refusal cannot ship without the
 * sentence a customer reads.
 */
export const REFUSAL_TEXT: Readonly<Record<GiftCardRefusal, string>> = {
  MALFORMED: `A gift card code is ${GIFT_CODE_LENGTH} letters and numbers. Check the card and type it again.`,
  UNKNOWN:
    'We do not recognise that code. Check the letters — some look alike on a printed card.',
  ALREADY_REDEEMED:
    'That card has already been added to an account. If it was not you, somebody in your household may have used it.',
  VOIDED: 'That card was cancelled. Get in touch and we will sort it out.',
  EXPIRED: 'That card has expired. Get in touch and we will sort it out.',
};

/** The refusal implied by a card's state, or null when it can be redeemed. */
export function refusalForStatus(status: GiftCardStatus): GiftCardRefusal | null {
  switch (status) {
    case 'ISSUED':
      return null;
    case 'REDEEMED':
      return 'ALREADY_REDEEMED';
    case 'VOID':
      return 'VOIDED';
    case 'EXPIRED':
      return 'EXPIRED';
  }
}

// -----------------------------------------------------------------------------
// What goes in the ledger
// -----------------------------------------------------------------------------

/**
 * The description the customer reads in their credits history.
 *
 * Takes the **reference**, and there is a real trap here: writing the code
 * into this string would persist the plaintext in `WalletTransaction` — a
 * table that is append-only and included in every backup — and quietly undo
 * the entire point of hashing it. The reference is the non-secret handle that
 * exists precisely so a card can be named without being spent.
 *
 * The function takes ONE argument for that reason. It cannot be handed a code
 * and a reference and pick the wrong one.
 *
 * Just the reference, with no "Gift card" in front of it. Both screens that
 * render a description — the customer's history and the account page in the
 * console — render the transaction TYPE beside it, so a prefix here reads as
 * "Gift card / Gift card GC-5686JY". The `GC-` already says what it is, and
 * the reference on its own is what support asks for on the phone.
 */
export function ledgerDescriptionFor(reference: string): string {
  return reference;
}
