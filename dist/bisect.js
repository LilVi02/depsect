// Culprit search over a set of independent "units" (dependency updates).
//
// Given an oracle that applies a subset of units and reports pass/fail, find
// every minimal failing combination. Handles the common case (one bad bump)
// in O(log n) runs, and also catches interactions ("A alone is fine, B alone
// is fine, A+B together break") and several independent culprits in one PR.
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
export async function findCulprits(units, oracle, opts) {
    const order = new Map(units.map((u, i) => [opts.key(u), i]));
    const cache = new Map();
    let runs = 0;
    // Subsets are always applied in the original unit order so results are
    // reproducible and cache keys are canonical.
    const canon = (subset) => [...subset].sort((a, b) => order.get(opts.key(a)) - order.get(opts.key(b)));
    const test = async (subset) => {
        const sorted = canon(subset);
        const k = sorted.map(opts.key).join('\0');
        const hit = cache.get(k);
        if (hit)
            return hit;
        const outcome = await oracle(sorted);
        runs++;
        cache.set(k, outcome);
        opts.onRun?.(sorted, outcome, runs);
        return outcome;
    };
    // Precondition: test(fixed ∪ candidates) fails and test(fixed) passes.
    // Binary-search the shortest failing prefix; its last element is required.
    // If it fails on its own (with `fixed`) we are done, otherwise the rest of
    // the cause lives in the prefix before it.
    const minimize = async (candidates, fixed) => {
        // Only reachable with a non-deterministic oracle (flaky tests).
        if (candidates.length === 0)
            return fixed;
        let lo = 0;
        let hi = candidates.length;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if ((await test([...fixed, ...candidates.slice(0, mid)])) === 'fail')
                hi = mid;
            else
                lo = mid;
        }
        const required = candidates[hi - 1];
        const nextFixed = [...fixed, required];
        if ((await test(nextFixed)) === 'fail')
            return nextFixed;
        return minimize(candidates.slice(0, hi - 1), nextFixed);
    };
    if ((await test([])) === 'fail')
        throw new BaseBrokenError();
    if ((await test(units)) === 'pass')
        throw new NoFailureError();
    const culprits = [];
    let remaining = units;
    for (;;) {
        const culprit = canon(await minimize(remaining, []));
        culprits.push(culprit);
        const bad = new Set(culprit.map(opts.key));
        remaining = remaining.filter((u) => !bad.has(opts.key(u)));
        if (remaining.length === 0 || (await test(remaining)) === 'pass')
            break;
    }
    return { culprits, safe: remaining, runs };
}
