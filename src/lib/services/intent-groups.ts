import { IntentGroup } from '@prisma/client';

/**
 * Presentation metadata for the home screen's intent groups.
 *
 * Note what is NOT here: any service key. Which services belong to which group
 * is `Service.intentGroup` in the database, so regrouping the home screen is a
 * data edit and never a code change. This module only names the groups.
 *
 * The labels are plain Filipino-market language rather than a translation of
 * someone else's taxonomy — a Filipino customer reads "Padala at Pabili" and
 * knows exactly what is behind it.
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
    label: 'Pagkain at Grocery',
    tagline: 'Kainan at tindahan, dala sa pintuan mo',
    sortOrder: 1,
  },
  [IntentGroup.GET]: {
    label: 'Padala at Pabili',
    tagline: 'Ipadala o ipamili — kami na ang pupunta',
    sortOrder: 2,
  },
  [IntentGroup.GO]: {
    label: 'Sakay',
    tagline: 'Ihahatid ka namin kung saan mo kailangan',
    sortOrder: 3,
  },
  [IntentGroup.PAY]: {
    label: 'Bayad',
    tagline: 'Bayarin at rewards sa isang lugar',
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
