import { copyFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { adapters } from './adapters/npm.ts';
import type { Adapter, Snapshot, Update } from './adapters/types.ts';
import { BaseBrokenError, findCulprits, NoFailureError, type BisectResult, type Outcome } from './bisect.ts';
import { sh } from './exec.ts';
import { addWorktree, readAt, repoRoot, resolveRef } from './git.ts';

export interface RunOptions {
  cwd: string;
  base: string;
  head: string;
  /** Project directory relative to the repo root. */
  dir: string;
  test: string;
  install?: string;
  /** Re-run a failing test this many times before believing it (flaky suites). */
  retries: number;
  timeoutMs?: number;
  /** If set, write the verified-safe manifest + lockfile into the working tree. */
  applySafe: boolean;
  log: (msg: string) => void;
}

export type Status = 'found' | 'base-broken' | 'no-failure' | 'no-updates';

export interface RunReport {
  status: Status;
  adapter: string;
  base: string;
  head: string;
  updates: Update[];
  result?: BisectResult<Update>;
  /** Tail of the failing output for each culprit set, same order as result.culprits. */
  culpritLogs: string[];
  notes: string[];
  durationMs: number;
  appliedSafe: boolean;
}

const tail = (s: string, lines = 40) => s.trimEnd().split('\n').slice(-lines).join('\n');

async function snapshot(root: string, ref: string, dir: string, files: string[]): Promise<Snapshot> {
  const snap: Snapshot = {};
  for (const f of files) snap[f] = await readAt(root, ref, posix.join(dir, f));
  return snap;
}

export async function run(opts: RunOptions): Promise<RunReport> {
  const started = Date.now();
  const root = await repoRoot(opts.cwd);
  const base = await resolveRef(root, opts.base);
  const head = await resolveRef(root, opts.head);
  const dir = opts.dir.replace(/^\.\/?/, '') || '.';

  const allFiles = [...new Set(adapters.flatMap((a) => a.files))];
  const headSnap = await snapshot(root, head, dir, allFiles);
  const adapter: Adapter | undefined = adapters.find((a) => a.detect(headSnap));
  if (!adapter) throw new Error(`No supported lockfile found in '${dir}' at ${opts.head}. Supported: ${adapters.map((a) => a.name).join(', ')}`);
  const baseSnap = await snapshot(root, base, dir, adapter.files);

  const updates = adapter.diff(baseSnap, headSnap);
  const notes = adapter.notes(baseSnap, headSnap);
  const report: RunReport = {
    status: 'no-updates', adapter: adapter.name, base, head, updates, culpritLogs: [], notes,
    durationMs: 0, appliedSafe: false,
  };
  if (updates.length === 0) {
    report.durationMs = Date.now() - started;
    return report;
  }

  opts.log(`${adapter.name}: ${updates.length} dependency update(s) between ${base.slice(0, 7)} and ${head.slice(0, 7)}`);
  for (const u of updates) opts.log(`  ${u.name}  ${u.from ?? '(new)'} → ${u.to ?? '(removed)'}`);

  // Run against the head code so the only thing that varies is dependencies.
  const wt = await addWorktree(root, head);
  const projectDir = join(wt.path, dir);
  const install = opts.install ?? adapter.installCommand;
  const logs = new Map<string, string>();
  const keyOf = (subset: Update[]) => subset.map((u) => u.id).join('\0');

  const apply = async (subset: Update[]): Promise<{ ok: boolean; output: string }> => {
    await adapter.write(projectDir, baseSnap, headSnap, subset);
    const res = await sh(install, { cwd: projectDir, timeoutMs: opts.timeoutMs });
    return { ok: res.code === 0, output: `$ ${install}\n${res.output}` };
  };

  const oracle = async (subset: Update[]): Promise<Outcome> => {
    const inst = await apply(subset);
    if (!inst.ok) {
      // An update that breaks installation is as much a culprit as one that breaks tests.
      logs.set(keyOf(subset), inst.output);
      return 'fail';
    }
    let res;
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      res = await sh(opts.test, { cwd: projectDir, timeoutMs: opts.timeoutMs });
      if (res.code === 0) return 'pass';
    }
    logs.set(keyOf(subset), `$ ${opts.test}\n${res!.timedOut ? '(timed out)\n' : ''}${res!.output}`);
    return 'fail';
  };

  try {
    const result = await findCulprits(updates, oracle, {
      key: (u) => u.id,
      onRun: (subset, outcome, n) =>
        opts.log(`run ${n}: ${outcome.toUpperCase().padEnd(4)} with ${subset.length ? subset.map((u) => u.name).join(', ') : '(no updates)'}`),
    });
    report.status = 'found';
    report.result = result;
    report.culpritLogs = result.culprits.map((c) => tail(logs.get(keyOf(c)) ?? ''));

    if (opts.applySafe) {
      const inst = await apply(result.safe);
      if (!inst.ok) throw new Error(`Could not install the safe set:\n${inst.output}`);
      for (const f of adapter.files) await copyFile(join(projectDir, f), join(root, dir, f));
      report.appliedSafe = true;
    }
  } catch (err) {
    if (err instanceof BaseBrokenError) {
      report.status = 'base-broken';
      report.culpritLogs = [tail(logs.get('') ?? '')];
    } else if (err instanceof NoFailureError) {
      report.status = 'no-failure';
    } else throw err;
  } finally {
    await wt.dispose();
  }

  report.durationMs = Date.now() - started;
  return report;
}
