/**
 * When a surge is worth interrupting somebody about.
 *
 * Pure, and separate from `surge-alerts.ts` for the usual reason: the numbers
 * here are product decisions about how often it is acceptable to buzz a
 * rider's phone, and they should be readable and testable without a database.
 *
 * One idea runs through all of it. **The market is measured every minute, and
 * almost none of those minutes are news.** A feature that notified on every
 * measurement would send sixty pushes an hour to every rider in a city, and
 * the result is not an informed fleet — it is an app whose notifications
 * everybody has switched off, including the ones that say an order is waiting.
 * So every rule below exists to turn a continuous measurement into the small
 * number of moments a person would actually want to know about.
 */

/**
 * How long before the same market may interrupt the same rider again.
 *
 * Forty-five minutes, which is roughly how long it takes to decide, get ready
 * and reach a pickup. A rider told it was busy half an hour ago and who did
 * not come out has made their decision; telling them again is not information,
 * it is pestering.
 */
export const ALERT_COOLDOWN_SECONDS = 45 * 60;

/**
 * How long a market must sit at its top step before it counts as understaffed.
 *
 * Forty minutes, measured in snapshots. Long enough that a lunch rush which
 * clears itself never reports — and short enough that somebody could still act
 * on it during the same evening.
 */
export const SUSTAINED_MINUTES = 40;

/** Once every four hours per market, so a bad night is one message, not nine. */
export const SUSTAINED_ALERT_COOLDOWN_SECONDS = 4 * 60 * 60;

export interface SurgeReading {
  surgeCentavos: number;
  /** The reading immediately before this one. Zero when there was none. */
  previousCentavos: number;
}

/**
 * Whether a reading is a moment worth telling riders about.
 *
 * **Only upward transitions.** Three cases have to be told apart, and lumping
 * any two together produces a visible defect:
 *
 *  - Surge appeared, or a step climbed. This is the news, and the only case
 *    that sends.
 *  - Surge is unchanged. The market has been busy for the last twenty minutes
 *    and everyone eligible was told when it started. Sending again is the
 *    sixty-pushes-an-hour failure.
 *  - Surge fell, or ended. Nothing to invite anybody to. A rider who is told
 *    "₱20 extra" and arrives to find ₱0 has been misled by a message that was
 *    true when sent, which is worse than never sending it — so a step DOWN is
 *    silent, and the rider's own screen carries the current figure.
 */
export function alertWorthSending(reading: SurgeReading): boolean {
  if (reading.surgeCentavos <= 0) return false;
  return reading.surgeCentavos > reading.previousCentavos;
}

export interface SnapshotRun {
  /** Minutes the market has been at the ceiling, from the newest row back. */
  minutes: number;
  /** How many consecutive snapshots were at the ceiling. */
  readings: number;
}

/**
 * How long the newest run at the ceiling has lasted.
 *
 * Measured from the TIMESTAMPS rather than by counting rows, because counting
 * rows silently assumes the sweep never missed a beat: forty snapshots is
 * forty minutes only if the cron ran every minute, and a cron that stalled for
 * half an hour would otherwise make a short rush look like a long one. Reading
 * the clock difference makes a gap shorten the run's credibility rather than
 * inflate it.
 *
 * Expects rows newest-first, which is how the index serves them.
 */
export function sustainedRun(
  snapshots: readonly { surgeCentavos: number; createdAt: Date }[],
  ceilingCentavos: number,
): SnapshotRun {
  if (ceilingCentavos <= 0) return { minutes: 0, readings: 0 };

  let readings = 0;
  let newest: Date | null = null;
  let oldest: Date | null = null;

  for (const snapshot of snapshots) {
    // The run is the UNBROKEN one at the front, and "at the ceiling" means
    // EXACTLY the ceiling rather than at-or-above it.
    //
    // Found against the real database. With `>=`, switching the top step off
    // made every older reading at the higher amount count as being at the new,
    // lower ceiling — so the run stretched back through a different ladder
    // entirely and the alert announced a city had been short-staffed for 765
    // minutes when it had not. A reading taken under a ladder that no longer
    // exists is not evidence about the ladder that does, so it ends the run.
    //
    // A dip BELOW the ceiling ends it for the original reason: a market that
    // fell to a lower step and climbed again has had riders reach it, which is
    // the ladder working.
    if (snapshot.surgeCentavos !== ceilingCentavos) break;
    readings += 1;
    newest ??= snapshot.createdAt;
    oldest = snapshot.createdAt;
  }

  if (newest === null || oldest === null) return { minutes: 0, readings: 0 };
  const minutes = Math.round((newest.getTime() - oldest.getTime()) / 60_000);
  return { minutes, readings };
}
