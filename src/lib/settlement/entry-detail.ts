import { SettlementEntryType, SettlementParty } from '@prisma/client';
import { referenceIsRequired } from '@/lib/settlement/policy';

/**
 * What a statement line can say beyond its amount.
 *
 * Two things were being recorded and shown to nobody.
 *
 * **`metadata`.** `accrueOrderSettlement` writes the subtotal, the commission
 * rate and the commission taken on every store earnings line, and the fee and
 * the tip on every rider one. Nothing read it. So a shop that sold ₱500 of
 * food saw `+₱425.00` and had to do the arithmetic to check what had been
 * deducted — on the one screen whose whole job is to be checkable.
 *
 * **`reference`.** The schema requires one on a payout, a remittance and an
 * adjustment, and says why: *"a claim with no reference is one nobody can
 * check later."* It was displayed on three admin screens and on none of the
 * partner statements — so the person who most needs to match a payout against
 * their bank was the one person who could not see its reference.
 *
 * ### Why the reading is defensive
 *
 * `metadata` is `Json?`, written by application code, and this renders on a
 * screen about somebody's money. A blob with a string where a number belongs
 * must not take the screen down, and must not be displayed either: a wrong
 * figure on a payout screen is worse than no figure, because a shop would
 * reconcile against it. So every field is checked and a line is dropped
 * rather than guessed.
 *
 * Pure: imports the enums and nothing else.
 */

/** A value with its unit, so the component formats and this module decides. */
export type DetailValue =
  | { kind: 'money'; centavos: number }
  | { kind: 'rate'; basisPoints: number };

export interface EntryDetailLine {
  label: string;
  value: DetailValue;
}

/**
 * Whether a partner should be able to check this line against a statement.
 *
 * Asked of `referenceIsRequired`, which the ledger's WRITER already uses to
 * refuse an entry with no reference. The first version of this module had its
 * own `Readonly<Record<SettlementEntryType, boolean>>` saying the same thing —
 * a second copy of one decision, which is the drift the absorbed-cost sum was
 * just consolidated to avoid. Two copies means a screen that can demand a
 * reference the writer no longer requires, or stay silent about one it does.
 *
 * Used in both directions: to show a reference, and to say plainly when one
 * that should exist does not. A shop looking at "Payout ₱5,000" with nothing
 * to match it against should be told that, rather than left to assume the
 * screen simply does not show references.
 */

/** A finite integer, or null. Anything else is not a figure to show. */
function centavos(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function basisPoints(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null;
}

/**
 * The breakdown behind one line, for the party whose statement it is.
 *
 * Empty for every type that has nothing to break down, and empty when the
 * metadata is missing or malformed — which is the same answer, deliberately:
 * the line still shows its amount, and the screen does not editorialise about
 * our data quality on somebody's payout.
 */
export interface DetailContext {
  /**
   * The shop's commission rate right now.
   *
   * The rate is snapshotted on every entry, so an old line can carry an old
   * rate. Rendered on every line it was pure noise — seventy identical "Rate
   * 15.00%" rows under a footer already saying the shop pays 15% — but
   * dropping it altogether would lose it in the one case that matters: a line
   * priced before the rate changed, which is exactly when the footer's
   * current figure would mislead. So it is shown only when the line disagrees
   * with the footer. Found by looking at the rendered screen.
   */
  currentCommissionBasisPoints?: number | undefined;
}

export function entryDetailLines(
  entry: { type: SettlementEntryType; metadata: unknown },
  party: SettlementParty,
  context: DetailContext = {},
): EntryDetailLine[] {
  if (entry.type !== SettlementEntryType.ORDER_EARNINGS) return [];
  const meta = entry.metadata;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return [];
  const bag = meta as Record<string, unknown>;

  if (party === SettlementParty.STORE) {
    const subtotal = centavos(bag.subtotalCentavos);
    const commission = centavos(bag.commissionCentavos);
    const rate = basisPoints(bag.commissionBasisPoints);
    if (subtotal === null) return [];

    const lines: EntryDetailLine[] = [
      { label: 'Food', value: { kind: 'money', centavos: subtotal } },
    ];
    // A zero-commission shop is owed the whole subtotal, and a "Commission
    // ₱0.00" line on every order of its statement is noise. The rate line is
    // dropped with it for the same reason.
    if (commission !== null && commission > 0) {
      lines.push({
        label: 'TARA commission',
        value: { kind: 'money', centavos: commission },
      });
      const current = context.currentCommissionBasisPoints;
      const rateIsNews = rate !== null && rate > 0 && rate !== current;
      if (rateIsNews) {
        lines.push({
          // Named so it reads as a fact about THIS order rather than about the
          // agreement, because that is the only time it appears.
          label: current === undefined ? 'Rate' : 'Rate then',
          value: { kind: 'rate', basisPoints: rate },
        });
      }
    }
    return lines;
  }

  const fee = centavos(bag.deliveryFeeCentavos);
  const tip = centavos(bag.tipCentavos);
  const lines: EntryDetailLine[] = [];
  if (fee !== null) {
    lines.push({ label: 'Delivery fee', value: { kind: 'money', centavos: fee } });
  }
  // Shown only when there was one. "Tip ₱0.00" on every delivery reads as a
  // comment on the customer.
  if (tip !== null && tip > 0) {
    lines.push({ label: 'Tip', value: { kind: 'money', centavos: tip } });
  }
  return lines;
}

/** What to say about a line's reference: the value, or that it is missing. */
export type ReferenceState =
  | { kind: 'none' }
  | { kind: 'shown'; reference: string }
  | { kind: 'missing' };

export function referenceState(entry: {
  type: SettlementEntryType;
  reference: string | null;
}): ReferenceState {
  const trimmed = entry.reference?.trim();
  if (trimmed) return { kind: 'shown', reference: trimmed };
  return referenceIsRequired(entry.type) ? { kind: 'missing' } : { kind: 'none' };
}

/**
 * The sentence for a payout with no reference against it.
 *
 * Addressed to the partner, not to us: they are the one who cannot reconcile,
 * and telling them to ask is more use than telling them something is wrong.
 */
export const MISSING_REFERENCE_NOTE =
  'No reference was recorded. Ask the TARA team if you need to match this against your account.';
