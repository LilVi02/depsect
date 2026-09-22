# depsect

[![npm](https://img.shields.io/npm/v/depsect)](https://www.npmjs.com/package/depsect) [![ci](https://github.com/LilVi02/depsect/actions/workflows/ci.yml/badge.svg)](https://github.com/LilVi02/depsect/actions/workflows/ci.yml) [![license](https://img.shields.io/github/license/LilVi02/depsect)](LICENSE)

**`git bisect` for grouped dependency updates.**
Dependabot bumped 23 packages in one PR and CI is red. Which one broke it? `depsect` tells you, and hands you the other 22 already verified green.

<p align="center">
  <img src="docs/demo.svg" alt="depsect bisecting a grouped update of 7 real npm packages: chalk and date-fns are the culprits, the other 5 are verified safe" width="760">
</p>

<p align="center"><sub>A real run on <a href="https://github.com/LilVi02/depsect-demo">depsect-demo</a>: 7 real npm packages bumped in one PR. Install and test time is compressed.</sub></p>

## Why

Grouping dependency updates is great until the group fails. Then you get one red check and 20 bumps, and the options are all bad: merge nothing, bump packages by hand one at a time, or split the group and wait for more CI runs.

`git bisect` doesn't help, because every update lives in **the same commit**. depsect bisects *inside* the change: it applies subsets of the updates on top of the old lockfile, runs your tests, and narrows down to the smallest set that fails.

It finds:

- **the single bad bump** in `O(log n)` runs: 64 updates take about 10 runs, not 64;
- **incompatible pairs** (or triples): `react@19` is fine and `some-lib@5` is fine, but together they break;
- **several independent culprits** in the same PR;
- the **safe set**: every other update, re-verified together, so you can merge it right away.

If the build fails even without the updates, or passes with all of them, depsect says so instead of blaming an innocent package.

## GitHub Action

Run it when a bot's dependency PR fails:

```yaml
# .github/workflows/depsect.yml
name: depsect
on: pull_request

jobs:
  depsect:
    if: github.actor == 'dependabot[bot]' || github.actor == 'renovate[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # to post the report
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - uses: LilVi02/depsect@v0
        with:
          test-command: npm test
```

Using pnpm or Yarn? Add `pnpm/action-setup` or `corepack enable` before depsect, the same way you would for your normal CI.

It posts a report on the PR (and updates it on re-runs) with the culprit, the failing output, and the list of safe updates. The same report goes to the job summary.

<p align="center">
  <a href="https://github.com/LilVi02/depsect-demo/pull/1"><img src="docs/pr-comment.png" alt="depsect report comment on a pull request: chalk 4.1.2 → 6.0.0 and date-fns 2.30.0 → 4.4.0 broke the build, the other 5 updates pass together" width="640"></a>
</p>

| Input | Default | |
| --- | --- | --- |
| `test-command` | *required* | Command that must pass. |
| `install-command` | auto | How to install dependencies. Default: `npm install`, `pnpm install --no-frozen-lockfile` or `yarn install`, depending on the lockfile. |
| `base` | PR base commit | Ref with the old dependencies. |
| `head` | `HEAD` | Ref with the new dependencies. |
| `working-directory` | `.` | Project directory (for monorepos). |
| `retries` | `0` | Re-run failing tests before trusting them (flaky suites). |
| `timeout-minutes` | `0` | Per-command timeout. |
| `apply-safe` | `false` | Write the safe updates to the working tree. Pair it with [create-pull-request](https://github.com/peter-evans/create-pull-request) to open a green PR automatically. |
| `comment` | `true` | Comment on the PR. |
| `fail-on-culprit` | `true` | Fail the step when a culprit is found. |

Outputs: `status` (`found` / `no-failure` / `base-broken` / `no-updates`), `culprits` (JSON, e.g. `[["alpha"],["delta","gamma"]]`), `safe` (JSON).

## CLI

```bash
npx depsect --test "npm test"                        # compares HEAD~1 → HEAD
npx depsect --base origin/main --test "npm run build && npm test"
npx depsect --test "npm test" --apply-safe           # keep only the safe bumps
```

depsect works in a throwaway `git worktree`, so your checkout and `node_modules` stay untouched (unless you pass `--apply-safe`). Run `depsect --help` for all options. Exit codes: `0` no culprit, `1` culprit found, `2` base already broken, `3` error.

## How it works

1. Read `package.json` and the lockfile (`package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`) at `base` and `head`, then list the changed direct dependencies. That includes lockfile-only bumps, where the range already allowed the new version.
2. Check out `head` in a temporary worktree, so the code stays constant and only dependencies vary.
3. For a subset *S* of updates, write the **base** manifest and lockfile with just *S* applied, install, and run the tests. Installing on top of the old lockfile means everything outside *S* stays pinned.
4. Search:
   - check that the empty set passes and the full set fails;
   - binary-search the shortest failing prefix, whose last update is required;
   - if that update fails alone, it is the culprit; otherwise, keep it fixed and search the prefix again for its partner. This finds minimal interacting sets without testing every combination;
   - remove the culprit set and repeat until the rest passes. What is left is the safe set.
5. Every subset result is cached, so no configuration runs twice.

## Status and roadmap

Supported today: **npm**, **pnpm**, and **Yarn** (v1 and Berry). The package manager is picked from the lockfile. The search core is independent of the ecosystem, so adding one means writing a single adapter.

- [x] npm, pnpm, Yarn v1, Yarn Berry
- [ ] Python (uv, Poetry), Cargo, Go modules
- [ ] Bisect transitive-only lockfile changes (currently reported, not isolated)
- [ ] Open a split PR with the safe updates directly from the Action
- [ ] Run independent subsets in parallel

Known limitation: when depsect applies a subset, the package manager re-resolves that package's own dependencies, which can differ slightly from what the bot's lockfile picked. This almost never changes the verdict, but it is not a byte-for-byte replay.

## Development

```bash
npm install
npm test        # unit tests + end-to-end tests against real git repos (offline)
                # e2e runs for pnpm/Yarn when they are on PATH; Yarn Berry needs DEPSECT_TEST_BERRY_PATH
npm run build   # compiles to dist/ (committed, used by the Action)
```

## License

[Apache License 2.0](LICENSE)
