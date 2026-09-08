/**
 * What a dish's choices may be, and which selections are valid.
 *
 * Pure, and used from three places that must agree: the merchant screen that
 * declares the groups, the customer screen that renders them, and
 * `quoteCheckout`, which is the only one whose answer is authoritative. A
 * customer's browser deciding that "extra rice" costs nothing has to be
 * unable to make that true, so nothing here trusts a price that arrives with
 * a selection — only the ids.
 *
 * The grammar is `minChoices`/`maxChoices` and nothing else. Two settings
 * cover every real menu:
 *
 *  - **(1, 1)** — "pick a size". Cannot be skipped, cannot be doubled.
 *  - **(0, n)** — "any add-ons you like".
 *
 * (2, 3) is legal and occasionally useful ("choose two sides"), so it is not
 * forbidden; what IS forbidden is a group nobody can satisfy, which is the one
 * mistake a shop can make here that a customer would meet as a dead end.
 */

export const MAX_GROUP_NAME_LENGTH = 40;
export const MAX_OPTION_NAME_LENGTH = 60;

/** More than this on one dish is a menu that needs splitting, not a form. */
export const MAX_GROUPS_PER_ITEM = 8;
export const MAX_OPTIONS_PER_GROUP = 20;

/**
 * A single choice may add up to ₱2,000.
 *
 * High enough for "whole lechon instead of a kilo", and a ceiling at all so
 * that a typo — 15000 for ₱15 — is refused rather than charged.
 */
export const MAX_OPTION_DELTA_CENTAVOS = 2_000_00;

export class GroupNameRequiredError extends Error {
  constructor() {
    super('Give the choice a name, like “Size” or “Sawsawan”.');
    this.name = 'GroupNameRequiredError';
  }
}

export class OptionNameRequiredError extends Error {
  constructor() {
    super('Give the choice an answer, like “Large”.');
    this.name = 'OptionNameRequiredError';
  }
}

export class OptionDeltaNotUnderstoodError extends Error {
  constructor() {
    super('Write what it adds in pesos, like 15 or 0.');
    this.name = 'OptionDeltaNotUnderstoodError';
  }
}

export class OptionDeltaOutOfRangeError extends Error {
  constructor(readonly centavos: number) {
    super(
      centavos < 0
        ? 'A choice can only add to the price. To sell it cheaper, add a ' +
          'second item at the lower price.'
        : 'A single choice can add at most ₱2,000.',
    );
    this.name = 'OptionDeltaOutOfRangeError';
  }
}

export class ImpossibleGroupError extends Error {
  constructor(readonly minChoices: number, readonly maxChoices: number) {
    super(
      `A choice cannot ask for at least ${minChoices} and at most ${maxChoices}.`,
    );
    this.name = 'ImpossibleGroupError';
  }
}

export class UnsatisfiableGroupError extends Error {
  // `groupName`, not `name`: `Error.name` is the class's own name and is what
  // the monitoring fingerprint groups on.
  constructor(
    readonly groupName: string,
    readonly minChoices: number,
    readonly available: number,
  ) {
    super(
      `“${groupName}” asks for ${minChoices} but only has ${available} available. ` +
        'Add more answers, or lower what it asks for.',
    );
    this.name = 'UnsatisfiableGroupError';
  }
}

export class DuplicateOptionNameError extends Error {
  constructor(readonly optionName: string) {
    super(`“${optionName}” is already one of the answers.`);
    this.name = 'DuplicateOptionNameError';
  }
}

export class OptionNotOnItemError extends Error {
  constructor() {
    super('One of those choices is not on this dish. Reload the page and try again.');
    this.name = 'OptionNotOnItemError';
  }
}

export class OptionUnavailableError extends Error {
  constructor(readonly optionName: string) {
    super(`“${optionName}” has run out.`);
    this.name = 'OptionUnavailableError';
  }
}

export class TooFewChoicesError extends Error {
  constructor(readonly groupName: string, readonly minChoices: number) {
    super(
      minChoices === 1
        ? `Choose a ${groupName.toLowerCase()}.`
        : `Choose ${minChoices} for ${groupName}.`,
    );
    this.name = 'TooFewChoicesError';
  }
}

export class TooManyChoicesError extends Error {
  constructor(readonly groupName: string, readonly maxChoices: number) {
    super(
      maxChoices === 1
        ? `Only one ${groupName.toLowerCase()} can be chosen.`
        : `At most ${maxChoices} can be chosen for ${groupName}.`,
    );
    this.name = 'TooManyChoicesError';
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Case- and space-insensitive comparison, for "is this the same answer". */
export function sameOptionText(left: string, right: string): boolean {
  return collapse(left).toLowerCase() === collapse(right).toLowerCase();
}

export function normaliseGroupName(raw: string): string {
  const name = collapse(raw).slice(0, MAX_GROUP_NAME_LENGTH);
  if (name.length === 0) throw new GroupNameRequiredError();
  return name;
}

export function normaliseOptionName(raw: string): string {
  const name = collapse(raw).slice(0, MAX_OPTION_NAME_LENGTH);
  if (name.length === 0) throw new OptionNameRequiredError();
  return name;
}

/** Centavos a choice adds, or a refusal naming which rule it broke. */
export function parseOptionDelta(
  raw: string,
  toCentavos: (input: string) => number | null,
): number {
  const trimmed = raw.trim();
  // An empty box means "adds nothing", which is the common case for a size
  // that is simply the default.
  if (trimmed.length === 0) return 0;

  // Caught here rather than left to the parser, which refuses a minus sign as
  // unreadable — and would answer "write it like 15 or 0" to a shop that
  // wrote exactly that, with a minus in front. This is the one input where
  // the reason matters more than the syntax, because the answer is "sell it
  // as its own dish" and nobody would guess that from a format hint.
  if (/^[-−]\s*₱?\s*[\d,.]+$/.test(trimmed)) {
    throw new OptionDeltaOutOfRangeError(-1);
  }

  const centavos = toCentavos(trimmed);
  if (centavos === null) throw new OptionDeltaNotUnderstoodError();
  if (centavos < 0 || centavos > MAX_OPTION_DELTA_CENTAVOS) {
    throw new OptionDeltaOutOfRangeError(centavos);
  }
  return centavos;
}

/** The bounds a group may be created or edited with. */
export function normaliseChoiceBounds(input: {
  minChoices: number;
  maxChoices: number;
}): { minChoices: number; maxChoices: number } {
  const { minChoices: min, maxChoices: max } = input;
  // Checked BEFORE any rounding. Flooring first and then asking whether the
  // result is an integer is a test that cannot fail — it silently turned
  // "one and a half" into "one", which is a number the shop never typed.
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 0 ||
    max < 1 ||
    min > max ||
    max > MAX_OPTIONS_PER_GROUP
  ) {
    throw new ImpossibleGroupError(min, max);
  }
  return { minChoices: min, maxChoices: max };
}

/** Just the fields the selection rules read. */
export interface OptionLike {
  id: string;
  name: string;
  priceDeltaCentavos: number;
  isAvailable: boolean;
}

export interface GroupLike {
  id: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  options: OptionLike[];
}

/**
 * Whether a group can be satisfied at all right now.
 *
 * A required group whose answers have all run out is a dish nobody can order,
 * and the shop should hear about it from their own screen rather than from a
 * customer. Reported rather than thrown where it is only a warning.
 */
export function groupIsSatisfiable(group: GroupLike): boolean {
  return group.options.filter((option) => option.isAvailable).length >= group.minChoices;
}

/** Which groups on a dish currently cannot be answered. */
export function unsatisfiableGroups(groups: readonly GroupLike[]): GroupLike[] {
  return groups.filter((group) => !groupIsSatisfiable(group));
}

export interface ResolvedChoice {
  optionId: string;
  groupId: string;
  name: string;
  priceDeltaCentavos: number;
}

/**
 * Turns a set of chosen option ids into priced choices, or refuses.
 *
 * This is the function `quoteCheckout` leans on, and the reason it takes ids
 * and returns prices rather than the other way round. Four ways a selection
 * can be wrong, and each has its own error because each has a different fix:
 * an option that is not on this dish (a stale page), one that has run out (try
 * something else), too few (answer the question), too many (pick one).
 *
 * Choices come back in the order the shop arranged their groups and options,
 * not the order they were clicked, so two customers who picked the same things
 * get identical snapshots — and a kitchen printout reads the same way every
 * time.
 */
export function resolveChoices(
  groups: readonly GroupLike[],
  chosenIds: readonly string[],
): ResolvedChoice[] {
  const unique = new Set(chosenIds);
  const byId = new Map<string, { group: GroupLike; option: OptionLike }>();
  for (const group of groups) {
    for (const option of group.options) byId.set(option.id, { group, option });
  }

  for (const id of unique) {
    if (!byId.has(id)) throw new OptionNotOnItemError();
  }

  const resolved: ResolvedChoice[] = [];
  for (const group of groups) {
    const chosen = group.options.filter((option) => unique.has(option.id));
    if (chosen.length < group.minChoices) {
      throw new TooFewChoicesError(group.name, group.minChoices);
    }
    if (chosen.length > group.maxChoices) {
      throw new TooManyChoicesError(group.name, group.maxChoices);
    }
    for (const option of chosen) {
      if (!option.isAvailable) throw new OptionUnavailableError(option.name);
      resolved.push({
        optionId: option.id,
        groupId: group.id,
        name: option.name,
        priceDeltaCentavos: option.priceDeltaCentavos,
      });
    }
  }
  return resolved;
}

/** What one of these dishes costs, per unit, with those choices. */
export function unitPriceWithChoices(
  basePriceCentavos: number,
  choices: readonly { priceDeltaCentavos: number }[],
): number {
  return choices.reduce((total, choice) => total + choice.priceDeltaCentavos, basePriceCentavos);
}

/**
 * The line a customer reads under a dish they added: "Large, extra rice".
 *
 * Names only. The prices are already in the line total, and repeating them
 * beside each choice turns a receipt into arithmetic homework.
 */
export function describeChoices(choices: readonly { name: string }[]): string {
  return choices.map((choice) => choice.name).join(', ');
}

/** What a group asks for, in words, under its heading. */
export function describeGroupRule(group: {
  minChoices: number;
  maxChoices: number;
}): string {
  if (group.minChoices === 1 && group.maxChoices === 1) return 'Choose one';
  if (group.minChoices === 0 && group.maxChoices === 1) return 'Choose one, or none';
  if (group.minChoices === 0) return `Choose up to ${group.maxChoices}`;
  if (group.minChoices === group.maxChoices) return `Choose ${group.minChoices}`;
  return `Choose ${group.minChoices} to ${group.maxChoices}`;
}
