import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sh, shOk } from "./exec.js";
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
export async function repoRoot(cwd) {
    return (await shOk('git rev-parse --show-toplevel', { cwd })).trim();
}
export async function resolveRef(cwd, ref) {
    return (await shOk(`git rev-parse --verify ${q(`${ref}^{commit}`)}`, { cwd })).trim();
}
/** Contents of `path` (relative to repo root) at `ref`, or null if it does not exist there. */
export async function readAt(cwd, ref, path) {
    const res = await sh(`git show ${q(`${ref}:${path}`)}`, { cwd });
    return res.code === 0 ? res.output : null;
}
/** A detached, throwaway checkout of `ref` so the user's working tree is never touched. */
export async function addWorktree(cwd, ref) {
    const parent = await mkdtemp(join(tmpdir(), 'depsect-'));
    const path = join(parent, 'wt');
    await shOk(`git worktree add --detach ${q(path)} ${q(ref)}`, { cwd });
    return {
        path,
        async dispose() {
            await sh(`git worktree remove --force ${q(path)}`, { cwd });
            await rm(parent, { recursive: true, force: true });
        },
    };
}
