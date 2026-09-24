// Runs several lookups at once and picks a winner by priority (list order),
// resolving as early as the answer is actually settled. Kept free of imports
// so the ordering rules can be tested on their own.

export type Skipped = { skipped: string };

export type PriorityResult<H> = {
  /** The earliest entry (by position) that produced a hit, or null if none did. */
  winner: { index: number; hit: H } | null;
  /** Entries that failed or were skipped, as of when this resolved. Entries still running are not listed. */
  failures: { index: number; message: string }[];
};

type Outcome<H> =
  | { kind: "hit"; hit: H }
  | { kind: "none" }
  | { kind: "failed"; message: string };

/**
 * Each entry is a lookup already in flight (a promise resolving to a hit, or
 * null for "checked, nothing there"), or `{ skipped }` for one that
 * shouldn't run at all. Position is priority: if more than one entry has a
 * hit, the earliest wins.
 *
 * Resolves the moment the answer can no longer change:
 *   - a hit at position i, once every entry BEFORE i has finished. Entries
 *     after i are never waited on, so a hit from the first caller returns
 *     as soon as the first caller answers, however slow the others are.
 *   - or null, once every entry has finished with no hit.
 *
 * A promise that rejects counts as failed, not as "nothing there," and is
 * reported in `failures` so a not-found result can say which entries never
 * got checked. Entries still running when this resolves are left to finish
 * on their own; their outcome is simply ignored here.
 */
export function firstHitInPriorityOrder<H>(
  entries: (Promise<H | null> | Skipped)[],
): Promise<PriorityResult<H>> {
  return new Promise((resolve) => {
    const outcomes: (Outcome<H> | undefined)[] = entries.map(() => undefined);
    let done = false;

    const failures = () =>
      outcomes.flatMap((o, index) => (o?.kind === "failed" ? [{ index, message: o.message }] : []));

    const decide = () => {
      if (done) return;
      for (let index = 0; index < outcomes.length; index++) {
        const outcome = outcomes[index];
        if (!outcome) return; // an earlier entry is still running, so it isn't decided yet
        if (outcome.kind === "hit") {
          done = true;
          resolve({ winner: { index, hit: outcome.hit }, failures: failures() });
          return;
        }
      }
      done = true;
      resolve({ winner: null, failures: failures() });
    };

    entries.forEach((entry, index) => {
      if ("skipped" in entry) {
        outcomes[index] = { kind: "failed", message: entry.skipped };
        return;
      }
      entry
        .then((hit) => {
          outcomes[index] = hit === null ? { kind: "none" } : { kind: "hit", hit };
        })
        .catch((err) => {
          outcomes[index] = { kind: "failed", message: err instanceof Error ? err.message : String(err) };
        })
        .then(decide);
    });

    decide(); // covers every entry having been skipped up front (or an empty list)
  });
}
