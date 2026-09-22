import { copyFile, readFile, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { adapters } from './adapters/index.ts';
import type { Adapter, Snapshot, Update } from './adapters/types.ts';
import { BaseBrokenError, findCulprits, NoFailureError, type BisectResult, type Outcome } from './bisect.ts';
import { sh } from './exec.ts';
import { addWorktree, readAt, repoRoot, resolveRef } from './git.ts';

/**
 * Which transitive (lockfile-only) packages to bisect.
 *   auto:   only when no direct dependency changed, e.g. a lockfile refresh
 *   always: always, next to direct dependencies
 *   never:  never
 */
export type TransitiveMode = 'auto' | 'always' | 'never';

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
  transitive?: TransitiveMode;
  /** If set, write the verified-safe dependency files into the working tree. */
  applySafe: boolean;
  log: (msg: string) => void;
}

export type Status = 'found' | 'base-broken' | 'no-failure' | 'no-updates';

export interface RunReport {
  status: Status;
  adapter: string;
  base: string;
  head: string;
  /** The updates that were bisected. */
  updates: Update[];
  result?: BisectResult<Update>;
  /** Failure excerpt for each culprit set, same order as result.culprits. */
  culpritLogs: string[];
  /** Changes that were seen but not bisected. */
  excluded: string[];
  notes: string[];
  durationMs: number;
  appliedSafe: boolean;
  /** Dependency files (relative to the project dir) with only the safe updates applied. */
  safeFiles?: Record<string, string>;
}

// Test runners print the interesting part (the first failure) long before the
// summary, so start the excerpt at the first line that looks like an error.
const ERROR_LINE = /\b(not ok|FAIL(ED)?|ERR!?|[A-Za-z]*Error|panicked)\b|[✕✖×●]/;

export function excerpt(output: string, lines = 30): string {
  const all = output.trimEnd().split('\n');
  const cmd = all[0]?.startsWith('$ ') ? [all.shift()!] : [];
  const i = all.findIndex((l) => ERROR_LINE.test(l));
  const body = i < 0 ? all.slice(-lines) : all.slice(Math.max(0, i - 2), i - 2 + lines);
  return [...cmd, ...body].join('\n');
}

async function snapshot(root: string, ref: string, dir: string, files: string[]): Promise<Snapshot> {
  const snap: Snapshot = {};
  for (const f of files) snap[f] = await readAt(root, ref, posix.join(dir, f));
  return snap;
}

/** Pick the updates to bisect for the given transitive mode. */
export function selectUpdates(all: Update[], mode: TransitiveMode): { updates: Update[]; skipped: Update[] } {
  const direct = all.filter((u) => u.kind === 'direct');
  const transitive = all.filter((u) => u.kind === 'transitive');
  const include = mode === 'always' || (mode === 'auto' && direct.length === 0);
  return include ? { updates: all, skipped: [] } : { updates: direct, skipped: transitive };
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
  if (!adapter) {
    throw new Error(`No supported lockfile found in '${dir}' at ${opts.head}. Supported: ${adapters.map((a) => a.name).join(', ')}`);
  }
  const baseSnap = await snapshot(root, base, dir, adapter.files);

  const diff = adapter.diff(baseSnap, headSnap);
  const mode = opts.transitive ?? 'auto';
  const { updates, skipped } = selectUpdates(diff.updates, mode);
  const notes: string[] = [];
  if (skipped.length) {
    notes.push(
      `${skipped.length} transitive package(s) also changed. They follow the direct updates that pull them in ` +
        `and were not bisected on their own (use --transitive always to include them).`,
    );
  }
  const report: RunReport = {
    status: 'no-updates', adapter: adapter.name, base, head, updates, culpritLogs: [],
    excluded: diff.excluded, notes, durationMs: 0, appliedSafe: false,
  };
  if (updates.length === 0) {
    report.durationMs = Date.now() - started;
    return report;
  }

  opts.log(`${adapter.name}: ${updates.length} dependency update(s) between ${base.slice(0, 7)} and ${head.slice(0, 7)}`);
  for (const u of updates) {
    opts.log(`  ${u.name}  ${u.from ?? '(new)'} → ${u.to ?? '(removed)'}${u.kind === 'transitive' ? '  (transitive)' : ''}`);
  }

  // Run against the head code so the only thing that varies is dependencies.
  const wt = await addWorktree(root, head);
  const projectDir = join(wt.path, dir);
  const install = opts.install ?? adapter.installCommand(headSnap);
  const env = adapter.env;
  const logs = new Map<string, string>();
  const keyOf = (subset: Update[]) => subset.map((u) => u.id).join('\0');
  // Show paths relative to the project instead of the throwaway worktree.
  const wtPaths = [...new Set([wt.path, await realpath(wt.path)])];
  const clean = (s: string) => wtPaths.reduce((acc, p) => acc.split(`${p}/`).join('').split(p).join('.'), s);

  const apply = async (subset: Update[]): Promise<{ ok: boolean; output: string }> => {
    const commands = await adapter.write(projectDir, baseSnap, headSnap, subset);
    let output = '';
    for (const cmd of [...commands, install]) {
      const res = await sh(cmd, { cwd: projectDir, timeoutMs: opts.timeoutMs, env });
      output += `$ ${cmd}\n${res.output}`;
      if (res.code !== 0) return { ok: false, output };
    }
    return { ok: true, output };
  };

  const oracle = async (subset: Update[]): Promise<Outcome> => {
    const inst = await apply(subset);
    if (!inst.ok) {
      // An update that cannot even be installed is as much a culprit as one that breaks tests.
      logs.set(keyOf(subset), clean(inst.output));
      return 'fail';
    }
    let res;
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      res = await sh(opts.test, { cwd: projectDir, timeoutMs: opts.timeoutMs, env });
      if (res.code === 0) return 'pass';
    }
    logs.set(keyOf(subset), clean(`$ ${opts.test}\n${res!.timedOut ? '(timed out)\n' : ''}${res!.output}`));
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
    report.culpritLogs = result.culprits.map((c) => excerpt(logs.get(keyOf(c)) ?? ''));

    // Leave the worktree in the safe state and keep a copy of its dependency files.
    let inst = await apply(result.safe);
    if (inst.ok && adapter.finalize) {
      const commands = await adapter.finalize(projectDir, baseSnap, headSnap, result.safe);
      for (const cmd of [...commands, install]) {
        const res = await sh(cmd, { cwd: projectDir, timeoutMs: opts.timeoutMs, env });
        inst = { ok: res.code === 0, output: `${inst.output}$ ${cmd}\n${res.output}` };
        if (!inst.ok) break;
      }
    }
    if (!inst.ok) throw new Error(`Could not install the safe set:\n${clean(inst.output)}`);
    report.safeFiles = {};
    for (const f of adapter.files) {
      const text = await readFile(join(projectDir, f), 'utf8').catch(() => null);
      if (text != null) report.safeFiles[f] = text;
    }
    if (opts.applySafe) {
      for (const f of Object.keys(report.safeFiles)) await copyFile(join(projectDir, f), join(root, dir, f));
      report.appliedSafe = true;
    }
  } catch (err) {
    if (err instanceof BaseBrokenError) {
      report.status = 'base-broken';
      report.culpritLogs = [excerpt(logs.get('') ?? '')];
    } else if (err instanceof NoFailureError) {
      report.status = 'no-failure';
    } else throw err;
  } finally {
    await wt.dispose();
  }

  report.durationMs = Date.now() - started;
  return report;
}
