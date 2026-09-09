/**
 * What a customer is told about credits they cannot spend right now.
 *
 * `getSpendableCentavos` returns **zero** for a frozen wallet, which is the
 * right answer to the question checkout asks — "how much can be put against
 * this bill" — and the wrong thing to render. Its own comment claimed the
 * consequence had been handled:
 *
 *   > The balance itself is unchanged and the credits screen still shows it,
 *   > with the reason — money that has vanished from the screen is a support
 *   > ticket, money that is visible and held is an explanation.
 *
 * The credits screen calls that same function, so it showed **₱0.00** and said
 * nothing. The only place in the whole app a customer is told their credits are
 * held is `/recover`, at the moment of recovery — so somebody who recovers
 * their account on Monday and opens Credits on Tuesday sees a zero balance and
 * no reason, which is exactly the support ticket the comment describes
 * avoiding. Prose about a gate, rotting quietly beside the gate.
 *
 * A screen that cannot tell "you have none" from "yours are held" must say the
 * second one. Same rule as the six screens that answered a gone session by
 * inventing an empty history.
 *
 * The two freezes are not the same message, and the difference is
 * `frozenUntil`:
 *
 *   - **Set** — the recovery cooling-off period. It ends on its own, on a date
 *     that can be named, and nobody needs to be contacted.
 *   - **NULL** — a fraud review. It ends when somebody ends it. Naming a date
 *     would be inventing one; the honest thing is to say who to ask.
 *
 * Pure: imports nothing.
 */

/** What state a customer's credits are in, for the purpose of showing them. */
export type CreditsState =
  /** Nothing in the ledger. Nothing to explain. */
  | { kind: 'NONE' }
  /** A balance, and it can be spent. */
  | { kind: 'SPENDABLE'; centavos: number }
  /**
   * A balance that exists and cannot be spent yet. `until` is the moment it
   * lifts on its own, or null when only a person can lift it.
   */
  | { kind: 'HELD'; centavos: number; until: Date | null };

export interface WalletFacts {
  /** The ledger sum. What the customer HAS, regardless of any hold. */
  balanceCentavos: number;
  isFrozen: boolean;
  frozenUntil: Date | null;
}

/**
 * Whether a freeze applies at `now`.
 *
 * Deliberately a copy of `freezeIsInForce`'s reasoning rather than an import:
 * that module reaches Prisma through its siblings and this one is imported by
 * client components. The two are pinned together by a test that asserts they
 * agree across the cases, which is the arrangement that keeps a duplicated
 * rule honest.
 */
export function holdIsInForce(facts: WalletFacts, now: Date): boolean {
  if (!facts.isFrozen) return false;
  if (facts.frozenUntil === null) return true;
  return facts.frozenUntil.getTime() > now.getTime();
}

/** The state to render, from what the wallet says. */
export function creditsState(facts: WalletFacts, now: Date): CreditsState {
  if (facts.balanceCentavos <= 0) return { kind: 'NONE' };
  if (holdIsInForce(facts, now)) {
    return {
      kind: 'HELD',
      centavos: facts.balanceCentavos,
      until: facts.frozenUntil,
    };
  }
  return { kind: 'SPENDABLE', centavos: facts.balanceCentavos };
}

/** What can actually be put against a bill. Zero whenever anything is held. */
export function spendableFrom(state: CreditsState): number {
  return state.kind === 'SPENDABLE' ? state.centavos : 0;
}

/**
 * The sentence a customer reads about a hold, or null when there is nothing to
 * explain.
 *
 * Takes the date formatter rather than choosing one, so a screen keeps its own
 * locale and this module stays pure.
 */
export function describeHold(
  state: CreditsState,
  formatCentavos: (centavos: number) => string,
  formatDate: (date: Date) => string,
): string | null {
  if (state.kind !== 'HELD') return null;
  const amount = formatCentavos(state.centavos);
  return state.until === null
    ? /* No date, because there is not one. A fraud review ends when somebody
         ends it, and a made-up date is worse than none: it turns one
         disappointment into two. */
      `${amount} is held while we check something on your account. It has not ` +
      `gone anywhere — message support and we will tell you where it stands.`
    : `${amount} is held until ${formatDate(state.until)}. This happens for a ` +
      `few days after an account moves to a new number, so somebody who takes ` +
      `over a number cannot spend what is not theirs. Nothing has been taken.`;
}

/**
 * The short form, for beside a payment option rather than in a panel.
 *
 * "₱0.00 available" next to a radio button is the specific falsehood this
 * replaces: the money is there and the screen said it was not.
 */
export function shortHoldNote(
  state: CreditsState,
  formatCentavos: (centavos: number) => string,
): string {
  switch (state.kind) {
    case 'NONE':
      return 'none yet';
    case 'SPENDABLE':
      return `${formatCentavos(state.centavos)} available`;
    case 'HELD':
      return `${formatCentavos(state.centavos)} held`;
  }
}
