#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { toMarkdown, toTerminal } from './report.ts';
import { run, type RunReport } from './runner.ts';

const HELP = `depsect: find which dependency update in a grouped PR broke your build

Usage:
  depsect --test "<command>" [options]

Options:
  -t, --test <cmd>      Command that must pass (e.g. "npm test"). Required.
  -b, --base <ref>      Ref with the old dependencies (default: HEAD~1)
  -H, --head <ref>      Ref with the new dependencies (default: HEAD)
  -d, --dir <path>      Project directory relative to the repo root (default: .)
  -i, --install <cmd>   Install command (default depends on the package manager)
  -r, --retries <n>     Re-run a failing test n times before trusting it (default: 0)
      --timeout <min>   Per-command timeout in minutes
      --apply-safe      Write the verified-safe updates to the working tree
      --markdown        Print a Markdown report instead of the terminal one
      --json            Print the raw report as JSON
  -h, --help            Show this help

Exit codes: 0 no culprit (or nothing to do), 1 culprit found, 2 base already broken, 3 error.`;

const EXIT: Record<RunReport['status'], number> = { 'no-updates': 0, 'no-failure': 0, found: 1, 'base-broken': 2 };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string', short: 't' },
      base: { type: 'string', short: 'b', default: 'HEAD~1' },
      head: { type: 'string', short: 'H', default: 'HEAD' },
      dir: { type: 'string', short: 'd', default: '.' },
      install: { type: 'string', short: 'i' },
      retries: { type: 'string', short: 'r', default: '0' },
      timeout: { type: 'string' },
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

  const quiet = values.json || values.markdown;
  const report = await run({
    cwd: process.cwd(),
    base: values.base!,
    head: values.head!,
    dir: values.dir!,
    test: values.test,
    install: values.install,
    retries: Number(values.retries),
    timeoutMs: values.timeout ? Number(values.timeout) * 60_000 : undefined,
    applySafe: values['apply-safe']!,
    log: (m) => (quiet ? console.error(m) : console.log(m)),
  });

  if (values.json) console.log(JSON.stringify(report, null, 2));
  else if (values.markdown) console.log(toMarkdown(report, values.test));
  else console.log(toTerminal(report, values.test));
  return EXIT[report.status];
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`depsect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  },
);
