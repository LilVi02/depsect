// Culprit search over a set of independent "units" (dependency updates).
//
// Given an oracle that applies a subset of units and reports pass/fail, find
// every minimal failing combination. Handles the common case (one bad bump)
// in O(log n) runs, and also catches interactions ("A alone is fine, B alone
// is fine, A+B together break") and several independent culprits in one PR.

export type Outcome = 'pass' | 'fail';

export type Oracle<T> = (subset: T[]) => Promise<Outcome>;

export interface BisectResult<T> {
  /** Each entry is a minimal set of units that fails together. */
  culprits: T[][];
  /** Every unit not implicated in a culprit set. Verified to pass together. */
  safe: T[];
  /** Number of distinct oracle invocations (cache hits excluded). */
  runs: number;
  /** Number of rounds: batches of runs that happen at the same time (equals `runs` when sequential). */
  rounds: number;
}

export class BaseBrokenError extends Error {
  constructor() {
    super('The build fails even with none of the updates applied, so there is nothing to bisect.');
    this.name = 'BaseBrokenError';
  }
}

export class NoFailureError extends Error {
  constructor() {
    super('The build passes with all updates applied, so there is no culprit to find.');
    this.name = 'NoFailureError';
  }
}

export interface BisectOptions<T> {
  key: (unit: T) => string;
  onRun?: (subset: T[], outcome: Outcome, run: number) => void;
  /**
   * How many subsets may be tested at once (default 1). The binary search
   * becomes a (concurrency + 1)-ary search: each round tests `concurrency`
   * cut points, so rounds drop from log2(n) to log_{concurrency+1}(n).
   */
  concurrency?: number;
}

export async function findCulprits<T>(
  units: T[],
  oracle: Oracle<T>,
  opts: BisectOptions<T>,
): Promise<BisectResult<T>> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const order = new Map(units.map((u, i) => [opts.key(u), i]));
  // Promises, so two concurrent requests for the same subset share one run.
  const cache = new Map<string, Promise<Outcome>>();
  let runs = 0;
  let rounds = 0;

  // Subsets are always applied in the original unit order so results are
  // reproducible and cache keys are canonical.
  const canon = (subset: T[]) => [...subset].sort((a, b) => order.get(opts.key(a))! - order.get(opts.key(b))!);
  const keyOf = (subset: T[]) => canon(subset).map(opts.key).join('\0');
  const test = (subset: T[]): Promise<Outcome> => {
    const sorted = canon(subset);
    const k = keyOf(sorted);
    const hit = cache.get(k);
    if (hit) return hit;
    const run = oracle(sorted).then((outcome) => {
      runs++;
      opts.onRun?.(sorted, outcome, runs);
      return outcome;
    });
    cache.set(k, run);
    return run;
  };
  /** Test several subsets at once: one round, if any of them has not run yet. */
  const batch = (subsets: T[][]): Promise<Outcome[]> => {
    if (subsets.some((s) => !cache.has(keyOf(s)))) rounds++;
    return Promise.all(subsets.map(test));
  };

  // Precondition: test(fixed ∪ candidates) fails and test(fixed) passes.
  // Search the shortest failing prefix; its last element is required. Each
  // round tests up to `concurrency` evenly spaced prefix lengths (one = the
  // classic binary search). If the required element fails on its own (with
  // `fixed`) we are done, otherwise the rest of the cause lives in the
  // prefix before it.
  const minimize = async (candidates: T[], fixed: T[]): Promise<T[]> => {
    // Only reachable with a non-deterministic oracle (flaky tests).
    if (candidates.length === 0) return fixed;
    let lo = 0;
    let hi = candidates.length;
    while (hi - lo > 1) {
      const k = Math.min(concurrency, hi - lo - 1);
      const cuts = [...new Set(Array.from({ length: k }, (_, i) => lo + Math.floor(((i + 1) * (hi - lo)) / (k + 1))))].filter(
        (c) => c > lo && c < hi,
      );
      const outcomes = await batch(cuts.map((c) => [...fixed, ...candidates.slice(0, c)]));
      // Shortest failing cut becomes the new upper bound; the longest passing cut below it the lower one.
      let newHi = hi;
      let newLo = lo;
      for (let i = 0; i < cuts.length; i++) {
        if (outcomes[i] === 'fail') {
          newHi = cuts[i]!;
          break;
        }
        newLo = cuts[i]!;
      }
      lo = newLo;
      hi = newHi;
    }
    const required = candidates[hi - 1]!;
    const nextFixed = [...fixed, required];
    if ((await batch([nextFixed]))[0] === 'fail') return nextFixed;
    return minimize(candidates.slice(0, hi - 1), nextFixed);
  };

  // Sanity checks: with room for two runs, do both at once.
  if (concurrency > 1) {
    const [none, all] = await batch([[], units]);
    if (none === 'fail') throw new BaseBrokenError();
    if (all === 'pass') throw new NoFailureError();
  } else {
    if ((await batch([[]]))[0] === 'fail') throw new BaseBrokenError();
    if ((await batch([units]))[0] === 'pass') throw new NoFailureError();
  }

  const culprits: T[][] = [];
  let remaining = units;
  for (;;) {
    const culprit = canon(await minimize(remaining, []));
    culprits.push(culprit);
    const bad = new Set(culprit.map(opts.key));
    remaining = remaining.filter((u) => !bad.has(opts.key(u)));
    if (remaining.length === 0 || (await batch([remaining]))[0] === 'pass') break;
  }

  return { culprits, safe: remaining, runs, rounds };
}
