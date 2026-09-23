#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { colors, noColors, toMarkdown, toTerminal } from "./report.js";
import { run } from "./runner.js";
const HELP = `depsect: find which dependency update in a grouped PR broke your build

Usage:
  depsect --test "<command>" [options]

Options:
  -t, --test <cmd>      Command that must pass (e.g. "npm test"). Required.
  -b, --base <ref>      Ref with the old dependencies (default: HEAD~1)
  -H, --head <ref>      Ref with the new dependencies (default: HEAD)
  -d, --dir <path>      Directory to run in, relative to the repo root (default: .).
                        Every project changed below it is found automatically,
                        including workspace members; the test command runs here.
  -i, --install <cmd>   Install command (default depends on the package manager)
  -r, --retries <n>     Re-run a failing test n times before trusting it (default: 0)
      --transitive <m>  Bisect lockfile-only (transitive) changes: auto, always, never
                        (default: auto = only when no direct dependency changed)
      --timeout <min>   Per-command timeout in minutes
      --apply-safe      Write the verified-safe updates to the working tree
      --markdown        Print a Markdown report instead of the terminal one
      --json            Print the raw report as JSON
  -h, --help            Show this help

Exit codes: 0 no culprit (or nothing to do), 1 culprit found, 2 base already broken, 3 error.`;
const EXIT = { 'no-updates': 0, 'no-failure': 0, found: 1, 'base-broken': 2 };
async function main() {
    const { values } = parseArgs({
        options: {
            test: { type: 'string', short: 't' },
            base: { type: 'string', short: 'b', default: 'HEAD~1' },
            head: { type: 'string', short: 'H', default: 'HEAD' },
            dir: { type: 'string', short: 'd', default: '.' },
            install: { type: 'string', short: 'i' },
            retries: { type: 'string', short: 'r', default: '0' },
            timeout: { type: 'string' },
            transitive: { type: 'string', default: 'auto' },
            'apply-safe': { type: 'boolean', default: false },
            markdown: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help || !values.test) {
        console.log(HELP);
        return values.help ? 0 : 3;
    }
    if (!['auto', 'always', 'never'].includes(values.transitive))
        throw new Error('--transitive must be auto, always or never');
    const quiet = values.json || values.markdown;
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const c = useColor && !quiet ? colors : noColors;
    const paintRun = (m) => m.replace(/^(run \d+: )(PASS|FAIL)/, (_, pre, o) => c.dim(pre) + (o === 'PASS' ? c.green(o) : c.red(o)));
    const report = await run({
        cwd: process.cwd(),
        base: values.base,
        head: values.head,
        dir: values.dir,
        test: values.test,
        install: values.install,
        retries: Number(values.retries),
        timeoutMs: values.timeout ? Number(values.timeout) * 60_000 : undefined,
        applySafe: values['apply-safe'],
        transitive: values.transitive,
        log: (m) => (quiet ? console.error(m) : console.log(paintRun(m))),
    });
    if (values.json)
        console.log(JSON.stringify({ ...report, safeFiles: undefined }, null, 2));
    else if (values.markdown)
        console.log(toMarkdown(report, values.test));
    else
        console.log(toTerminal(report, values.test, c));
    return EXIT[report.status];
}
main().then((code) => process.exit(code), (err) => {
    console.error(`depsect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
});
