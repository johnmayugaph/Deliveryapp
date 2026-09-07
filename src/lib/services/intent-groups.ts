import { IntentGroup } from '@prisma/client';

/**
 * Presentation metadata for the home screen's intent groups.
 *
 * Note what is NOT here: any service key. Which services belong to which group
 * is `Service.intentGroup` in the database, so regrouping the home screen is a
 * data edit and never a code change. This module only names the groups.
 *
 * The labels are plain English, and plain: a group is named for what somebody
 * is trying to do, not for the internal taxonomy. They were Filipino
 * ("Padala at Pabili") until the product decided otherwise — a reminder that
 * this file, and not the service records, is where that wording lives.
 */
export interface IntentGroupPresentation {
  /** Section heading on the home screen. */
  label: string;
  /** One line under the heading. */
  tagline: string;
  /** Order the sections appear in. */
  sortOrder: number;
}

export const INTENT_GROUP_PRESENTATION: Readonly<
  Record<IntentGroup, IntentGroupPresentation>
> = {
  [IntentGroup.EAT]: {
    label: 'Food & grocery',
    tagline: 'Meals and groceries, brought to your door',
    sortOrder: 1,
  },
  [IntentGroup.GET]: {
    label: 'Send & buy',
    tagline: 'Send it or buy it — we make the trip',
    sortOrder: 2,
  },
  [IntentGroup.GO]: {
    label: 'Rides',
    tagline: 'We take you where you need to go',
    sortOrder: 3,
  },
  [IntentGroup.PAY]: {
    label: 'Pay',
    tagline: 'Bills and rewards in one place',
    sortOrder: 4,
  },
};

export function intentGroupPresentation(group: IntentGroup): IntentGroupPresentation {
  return INTENT_GROUP_PRESENTATION[group];
}

/** Groups in display order. Empty groups are dropped by the caller, not here. */
export const INTENT_GROUPS_IN_ORDER: readonly IntentGroup[] = (
  Object.keys(INTENT_GROUP_PRESENTATION) as IntentGroup[]
).sort(
  (a, b) =>
    INTENT_GROUP_PRESENTATION[a].sortOrder - INTENT_GROUP_PRESENTATION[b].sortOrder,
);
