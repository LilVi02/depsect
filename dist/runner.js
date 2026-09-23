import { copyFile, readFile, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { adapters } from "./adapters/index.js";
import { BaseBrokenError, findCulprits, NoFailureError } from "./bisect.js";
import { sh } from "./exec.js";
import { addWorktree, changedFiles, listFiles, readAt, repoRoot, resolveRef } from "./git.js";
// Test runners print the interesting part (the first failure) long before the
// summary, so start the excerpt at the first line that looks like an error.
const ERROR_LINE = /\b(not ok|FAIL(ED)?|ERR!?|[A-Za-z]*Error|panicked)\b|[✕✖×●]/;
export function excerpt(output, lines = 30) {
    const all = output.trimEnd().split('\n');
    const cmd = all[0]?.startsWith('$ ') ? [all.shift()] : [];
    const i = all.findIndex((l) => ERROR_LINE.test(l));
    const body = i < 0 ? all.slice(-lines) : all.slice(Math.max(0, i - 2), i - 2 + lines);
    return [...cmd, ...body].join('\n');
}
async function snapshot(root, ref, dir, files) {
    const snap = {};
    for (const f of files)
        snap[f] = await readAt(root, ref, posix.join(dir, f));
    return snap;
}
/** Files that can signal a dependency change, including workspace member manifests. */
const DEPENDENCY_FILES = new Set([...adapters.flatMap((a) => a.files), 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod']);
/**
 * Find the projects a change touches: for every changed dependency file,
 * the nearest directory (itself or an ancestor, within the run directory)
 * whose lockfile a supported package manager recognizes. A workspace
 * member's package.json or Cargo.toml thus maps to the workspace root.
 */
export async function discoverProjects(root, base, head, runDir) {
    const allFiles = [...new Set(adapters.flatMap((a) => a.files))];
    const repoPath = (d) => posix.join(runDir, d || '.');
    const changed = (await changedFiles(root, base, head, runDir)).filter((p) => DEPENDENCY_FILES.has(posix.basename(p)));
    const candidates = [...new Set(changed.map((p) => posix.dirname(p)).map((d) => (d === '.' ? '' : d)))];
    const found = new Map();
    const detectAt = new Map();
    for (const start of candidates) {
        for (let d = start; d !== null; d = d === '' ? null : posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
            if (!detectAt.has(d)) {
                const snap = await snapshot(root, head, repoPath(d), allFiles);
                detectAt.set(d, adapters.find((a) => a.detect(snap)) ?? null);
            }
            const adapter = detectAt.get(d);
            if (adapter) {
                found.set(d, adapter);
                break;
            }
        }
    }
    const projects = [];
    for (const [dir, adapter] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
        let files = adapter.files;
        if (adapter.members) {
            const headCore = await snapshot(root, head, repoPath(dir), files);
            const baseCore = await snapshot(root, base, repoPath(dir), files);
            files = [
                ...new Set([
                    ...files,
                    ...adapter.members(headCore, await listFiles(root, head, repoPath(dir))),
                    ...adapter.members(baseCore, await listFiles(root, base, repoPath(dir))),
                ]),
            ];
        }
        projects.push({
            dir,
            adapter,
            base: await snapshot(root, base, repoPath(dir), files),
            head: await snapshot(root, head, repoPath(dir), files),
        });
    }
    return projects;
}
/** Pick the updates to bisect for the given transitive mode. */
export function selectUpdates(all, mode) {
    const direct = all.filter((u) => u.kind === 'direct');
    const transitive = all.filter((u) => u.kind === 'transitive');
    const include = mode === 'always' || (mode === 'auto' && direct.length === 0);
    return include ? { updates: all, skipped: [] } : { updates: direct, skipped: transitive };
}
export async function run(opts) {
    const started = Date.now();
    const root = await repoRoot(opts.cwd);
    const base = await resolveRef(root, opts.base);
    const head = await resolveRef(root, opts.head);
    const dir = opts.dir.replace(/^\.\/?/, '').replace(/\/+$/, '') || '.';
    const projects = await discoverProjects(root, base, head, dir);
    const multi = projects.length > 1;
    const label = (p) => p.dir || '.';
    // Collect every project's updates; ids carry the project when there are several.
    const mode = opts.transitive ?? 'auto';
    const updates = [];
    const excluded = [];
    const notes = [];
    let skippedTransitive = 0;
    for (const p of projects) {
        const diff = p.adapter.diff(p.base, p.head);
        const sel = selectUpdates(diff.updates, mode);
        skippedTransitive += sel.skipped.length;
        for (const u of sel.updates)
            updates.push({ ...u, project: p.dir, id: multi ? `${label(p)}:${u.id}` : u.id });
        excluded.push(...diff.excluded.map((e) => (multi ? `${label(p)}: ${e}` : e)));
    }
    if (skippedTransitive) {
        notes.push(`${skippedTransitive} transitive package(s) also changed. They follow the direct updates that pull them in ` +
            `and were not bisected on their own (use --transitive always to include them).`);
    }
    const report = {
        status: 'no-updates',
        adapter: [...new Set(projects.map((p) => p.adapter.name))].join(' + ') || 'none',
        projects: projects.map((p) => ({ dir: label(p), adapter: p.adapter.name })),
        base, head, updates, culpritLogs: [], excluded, notes, durationMs: 0, appliedSafe: false,
    };
    if (updates.length === 0) {
        report.durationMs = Date.now() - started;
        return report;
    }
    opts.log(`${report.adapter}: ${updates.length} dependency update(s) between ${base.slice(0, 7)} and ${head.slice(0, 7)}` +
        (multi ? ` in ${projects.length} projects (${projects.map(label).join(', ')})` : ''));
    for (const u of updates) {
        const where = multi ? `  [${u.project || '.'}]` : '';
        opts.log(`  ${u.name}  ${u.from ?? '(new)'} → ${u.to ?? '(removed)'}${u.kind === 'transitive' ? '  (transitive)' : ''}${where}`);
    }
    // Run against the head code so the only thing that varies is dependencies.
    const wt = await addWorktree(root, head);
    const runDir = join(wt.path, dir);
    const projectDir = (p) => join(runDir, p.dir);
    const install = (p) => opts.install ?? p.adapter.installCommand(p.head);
    // The test command sees every project's environment (e.g. GOFLAGS).
    const testEnv = Object.assign({}, ...projects.map((p) => p.adapter.env ?? {}));
    const logs = new Map();
    const keyOf = (subset) => subset.map((u) => u.id).join('\0');
    // Show paths relative to the run directory instead of the throwaway worktree.
    const wtPaths = [...new Set([wt.path, await realpath(wt.path)])];
    const clean = (s) => wtPaths.reduce((acc, p) => acc.split(`${p}/`).join('').split(p).join('.'), s);
    // What each project currently has installed, so unchanged projects are not reinstalled.
    const applied = new Map();
    const run = async (p, commands) => {
        let output = '';
        for (const cmd of [...commands, install(p)]) {
            const res = await sh(cmd, { cwd: projectDir(p), timeoutMs: opts.timeoutMs, env: p.adapter.env });
            output += `$ ${multi ? `(${label(p)}) ` : ''}${cmd}\n${res.output}`;
            if (res.code !== 0)
                return { ok: false, output };
        }
        return { ok: true, output };
    };
    const apply = async (subset) => {
        let output = '';
        for (const p of projects) {
            const mine = subset.filter((u) => u.project === p.dir);
            const key = keyOf(mine);
            if (applied.get(p) === key)
                continue;
            applied.delete(p);
            const res = await run(p, await p.adapter.write(projectDir(p), p.base, p.head, mine));
            output += res.output;
            if (!res.ok)
                return { ok: false, output };
            applied.set(p, key);
        }
        return { ok: true, output };
    };
    const oracle = async (subset) => {
        const inst = await apply(subset);
        if (!inst.ok) {
            // An update that cannot even be installed is as much a culprit as one that breaks tests.
            logs.set(keyOf(subset), clean(inst.output));
            return 'fail';
        }
        let res;
        for (let attempt = 0; attempt <= opts.retries; attempt++) {
            res = await sh(opts.test, { cwd: runDir, timeoutMs: opts.timeoutMs, env: testEnv });
            if (res.code === 0)
                return 'pass';
        }
        logs.set(keyOf(subset), clean(`$ ${opts.test}\n${res.timedOut ? '(timed out)\n' : ''}${res.output}`));
        return 'fail';
    };
    try {
        const result = await findCulprits(updates, oracle, {
            key: (u) => u.id,
            onRun: (subset, outcome, n) => opts.log(`run ${n}: ${outcome.toUpperCase().padEnd(4)} with ${subset.length ? subset.map((u) => u.name).join(', ') : '(no updates)'}`),
        });
        report.status = 'found';
        report.result = result;
        report.culpritLogs = result.culprits.map((c) => excerpt(logs.get(keyOf(c)) ?? ''));
        // Leave the worktree in the safe state and keep a copy of its dependency files.
        const inst = await apply(result.safe);
        if (!inst.ok)
            throw new Error(`Could not install the safe set:\n${clean(inst.output)}`);
        report.safeFiles = {};
        for (const p of projects) {
            if (p.adapter.finalize) {
                const mine = result.safe.filter((u) => u.project === p.dir);
                const res = await run(p, await p.adapter.finalize(projectDir(p), p.base, p.head, mine));
                if (!res.ok)
                    throw new Error(`Could not install the safe set:\n${clean(res.output)}`);
            }
            for (const f of Object.keys(p.head)) {
                const text = await readFile(join(projectDir(p), f), 'utf8').catch(() => null);
                if (text != null)
                    report.safeFiles[posix.join(p.dir, f)] = text;
            }
        }
        if (opts.applySafe) {
            for (const f of Object.keys(report.safeFiles))
                await copyFile(join(runDir, f), join(root, dir, f));
            report.appliedSafe = true;
        }
    }
    catch (err) {
        if (err instanceof BaseBrokenError) {
            report.status = 'base-broken';
            report.culpritLogs = [excerpt(logs.get('') ?? '')];
        }
        else if (err instanceof NoFailureError) {
            report.status = 'no-failure';
        }
        else
            throw err;
    }
    finally {
        await wt.dispose();
    }
    report.durationMs = Date.now() - started;
    return report;
}
