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
const DEPENDENCY_FILES = new Set([...adapters.flatMap((a) => a.files), 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts']);
const isDependencyFile = (p) => DEPENDENCY_FILES.has(posix.basename(p)) || /(^|\/)gradle\/[^/]+\.versions\.toml$/.test(p);
/**
 * Find the projects a change touches: for every changed dependency file,
 * the nearest directory (itself or an ancestor, within the run directory)
 * whose lockfile a supported package manager recognizes. A workspace
 * member's package.json or Cargo.toml thus maps to the workspace root.
 */
export async function discoverProjects(root, base, head, runDir) {
    const allFiles = [...new Set(adapters.flatMap((a) => a.files))];
    const repoPath = (d) => posix.join(runDir, d || '.');
    const changed = (await changedFiles(root, base, head, runDir)).filter(isDependencyFile);
    // A version catalog lives in <project>/gradle/.
    const dirOf = (p) => posix.dirname(/(^|\/)gradle\/[^/]+\.versions\.toml$/.test(p) ? posix.dirname(p) : p);
    const candidates = [...new Set(changed.map(dirOf).map((d) => (d === '.' ? '' : d)))];
    const parent = (d) => (d === '' ? null : posix.dirname(d) === '.' ? '' : posix.dirname(d));
    const detectAt = new Map();
    const detect = async (d) => {
        if (!detectAt.has(d)) {
            const snap = await snapshot(root, head, repoPath(d), allFiles);
            detectAt.set(d, adapters.find((a) => a.detect(snap)) ?? null);
        }
        return detectAt.get(d);
    };
    // The nearest ancestor project that lists `d` as one of its members
    // (a Maven module, a Gradle subproject, a workspace member with its own
    // lockfile), if any.
    const container = async (d) => {
        for (let a = parent(d); a !== null; a = parent(a)) {
            const adapter = await detect(a);
            if (!adapter?.members)
                continue;
            const rel = a === '' ? d : d.slice(a.length + 1);
            const members = adapter.members(await snapshot(root, head, repoPath(a), adapter.files), await listFiles(root, head, repoPath(a)));
            if (members.some((m) => posix.dirname(m) === rel))
                return a;
        }
        return null;
    };
    const found = new Map();
    for (const start of candidates) {
        for (let d = start; d !== null; d = parent(d)) {
            if (!(await detect(d)))
                continue;
            let top = d;
            for (let c = await container(top); c !== null; c = await container(top))
                top = c;
            found.set(top, (await detect(top)));
            break;
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
        base, head, updates, culpritLogs: [], excluded, notes, durationMs: 0, jobs: Math.max(1, Math.floor(opts.jobs ?? 1)),
        appliedSafe: false,
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
    const jobs = Math.max(1, Math.floor(opts.jobs ?? 1));
    const lanes = [];
    const idle = [];
    const waiting = [];
    let creating = Promise.resolve();
    let pending = 0;
    const wtPaths = [];
    const newLane = async () => {
        // One `git worktree add` at a time: concurrent ones can collide on git's locks.
        const made = creating.then(async () => {
            const wt = await addWorktree(root, head);
            wtPaths.push(wt.path, await realpath(wt.path));
            const lane = { wt, runDir: join(wt.path, dir), applied: new Map() };
            lanes.push(lane);
            return lane;
        });
        creating = made.catch(() => { });
        return made;
    };
    const acquire = async () => {
        const free = idle.pop();
        if (free)
            return free;
        if (lanes.length + pending < jobs) {
            pending++;
            try {
                return await newLane();
            }
            finally {
                pending--;
            }
        }
        return new Promise((resolve) => waiting.push(resolve));
    };
    const release = (lane) => {
        const next = waiting.shift();
        if (next)
            next(lane);
        else
            idle.push(lane);
    };
    const projectDir = (lane, p) => join(lane.runDir, p.dir);
    const install = (p) => opts.install ?? p.adapter.installCommand(p.head);
    // The test command sees every project's environment (e.g. GOFLAGS).
    const testEnv = Object.assign({}, ...projects.map((p) => p.adapter.env ?? {}));
    const logs = new Map();
    const keyOf = (subset) => subset.map((u) => u.id).join('\0');
    // Show paths relative to the run directory instead of the throwaway worktrees.
    const clean = (s) => wtPaths.reduce((acc, p) => acc.split(`${p}/`).join('').split(p).join('.'), s);
    // Package managers whose shared cache is not safe for concurrent installs
    // install one lane at a time; tests still run in parallel.
    const installLocks = new Map();
    const exclusive = async (p, fn) => {
        if (jobs === 1 || !p.adapter.serialInstall)
            return fn();
        const prev = installLocks.get(p.adapter.name) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        installLocks.set(p.adapter.name, next.catch(() => { }));
        return next;
    };
    const run = (lane, p, commands) => exclusive(p, async () => {
        let output = '';
        for (const cmd of [...commands, install(p)]) {
            const res = await sh(cmd, { cwd: projectDir(lane, p), timeoutMs: opts.timeoutMs, env: p.adapter.env });
            output += `$ ${multi ? `(${label(p)}) ` : ''}${cmd}\n${res.output}`;
            if (res.code !== 0)
                return { ok: false, output };
        }
        return { ok: true, output };
    });
    const apply = async (lane, subset) => {
        let output = '';
        for (const p of projects) {
            const mine = subset.filter((u) => u.project === p.dir);
            const key = keyOf(mine);
            if (lane.applied.get(p) === key)
                continue;
            lane.applied.delete(p);
            const res = await run(lane, p, await p.adapter.write(projectDir(lane, p), p.base, p.head, mine));
            output += res.output;
            if (!res.ok)
                return { ok: false, output };
            lane.applied.set(p, key);
        }
        return { ok: true, output };
    };
    const oracle = async (subset) => {
        const lane = await acquire();
        try {
            const inst = await apply(lane, subset);
            if (!inst.ok) {
                // An update that cannot even be installed is as much a culprit as one that breaks tests.
                logs.set(keyOf(subset), clean(inst.output));
                return 'fail';
            }
            let res;
            for (let attempt = 0; attempt <= opts.retries; attempt++) {
                res = await sh(opts.test, { cwd: lane.runDir, timeoutMs: opts.timeoutMs, env: testEnv });
                if (res.code === 0)
                    return 'pass';
            }
            logs.set(keyOf(subset), clean(`$ ${opts.test}\n${res.timedOut ? '(timed out)\n' : ''}${res.output}`));
            return 'fail';
        }
        finally {
            release(lane);
        }
    };
    try {
        const result = await findCulprits(updates, oracle, {
            key: (u) => u.id,
            concurrency: jobs,
            onRun: (subset, outcome, n) => opts.log(`run ${n}: ${outcome.toUpperCase().padEnd(4)} with ${subset.length ? subset.map((u) => u.name).join(', ') : '(no updates)'}`),
        });
        report.status = 'found';
        report.result = result;
        report.culpritLogs = result.culprits.map((c) => excerpt(logs.get(keyOf(c)) ?? ''));
        // Put one lane in the safe state and keep a copy of its dependency files.
        const lane = await acquire();
        const inst = await apply(lane, result.safe);
        if (!inst.ok)
            throw new Error(`Could not install the safe set:\n${clean(inst.output)}`);
        report.safeFiles = {};
        for (const p of projects) {
            if (p.adapter.finalize) {
                const mine = result.safe.filter((u) => u.project === p.dir);
                const res = await run(lane, p, await p.adapter.finalize(projectDir(lane, p), p.base, p.head, mine));
                if (!res.ok)
                    throw new Error(`Could not install the safe set:\n${clean(res.output)}`);
            }
            for (const f of Object.keys(p.head)) {
                const text = await readFile(join(projectDir(lane, p), f), 'utf8').catch(() => null);
                if (text != null)
                    report.safeFiles[posix.join(p.dir, f)] = text;
            }
        }
        if (opts.applySafe) {
            for (const f of Object.keys(report.safeFiles))
                await copyFile(join(lane.runDir, f), join(root, dir, f));
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
        await creating;
        for (const lane of lanes)
            await lane.wt.dispose();
    }
    report.durationMs = Date.now() - started;
    return report;
}
