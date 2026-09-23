// JavaScript package managers. They share package.json semantics and differ
// in the lockfile format, the install command, and how a transitive package
// can be forced to a version.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { matchMembers } from "../workspace.js";
import { isBerry, npmLock, pnpmLock, yarnLock } from "./lockfiles.js";
import { sameSet, showVersions } from "./types.js";
const MANIFEST = 'package.json';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const parse = (text) => (text ? JSON.parse(text) : null);
function detectIndent(text) {
    const m = /^[ \t]+(?=")/m.exec(text);
    return m ? m[0] : 2;
}
/** Find which section of the manifest declares `name`, if any. */
function sectionOf(man, name) {
    for (const s of SECTIONS) {
        const spec = man?.[s]?.[name];
        if (spec !== undefined)
            return { section: s, spec };
    }
    return null;
}
function directNames(...mans) {
    const names = new Set();
    for (const man of mans)
        for (const s of SECTIONS)
            for (const n of Object.keys(man?.[s] ?? {}))
                names.add(n);
    return [...names].sort();
}
/** A registry range like "^1.2.3" or ">=2 <3", as opposed to file:, git:, npm: aliases, workspace:, URLs. */
const isRegistryRange = (spec) => /^[\s\d^~<>=*xX.|-]+$/.test(spec) || /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(spec);
/** Workspace globs from package.json `workspaces` (npm, Yarn) or pnpm-workspace.yaml `packages`. */
export function workspacePatterns(snap) {
    const man = parse(snap[MANIFEST]);
    const ws = man?.workspaces;
    const fromManifest = Array.isArray(ws) ? ws : (ws?.packages ?? []);
    const yaml = snap[PNPM_WORKSPACE] ?? '';
    const block = /^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?|[ \t]*\n)*)/m.exec(yaml)?.[1] ?? '';
    const fromPnpm = [...block.matchAll(/^[ \t]+-[ \t]*['"]?([^'"\n#]+?)['"]?[ \t]*(?:#.*)?$/gm)].map((m) => m[1]);
    return [...fromManifest, ...fromPnpm];
}
/** package.json files in a snapshot: the root one first, then workspace members. */
const manifestsOf = (...snaps) => {
    const keys = new Set(snaps.flatMap((s) => Object.keys(s).filter((k) => (k === MANIFEST || k.endsWith(`/${MANIFEST}`)) && s[k] != null)));
    return [...keys].sort((a, b) => (a === MANIFEST ? -1 : b === MANIFEST ? 1 : a.localeCompare(b)));
};
/** The lockfile "importer" of a manifest: its directory relative to the root, '' for the root. */
const importerOf = (manifest) => (manifest === MANIFEST ? '' : posix.dirname(manifest));
function nodeAdapter({ name, lockfile, reader, install, transitive }) {
    const resolved = (snap, dep, spec, manifest = MANIFEST) => {
        const text = snap[lockfile];
        return text && spec !== undefined ? reader.direct(text, dep, spec, importerOf(manifest)) : undefined;
    };
    /**
     * One manifest from base, with head's declarations for the direct updates
     * in `subset`. Members that only exist in head are taken from head as-is.
     */
    const buildManifest = (manifest, base, head, subset, pin) => {
        const baseText = base[manifest];
        if (!baseText)
            return parse(head[manifest]);
        const man = parse(baseText);
        const hm = parse(head[manifest]);
        for (const u of subset.filter((x) => x.kind === 'direct')) {
            const b = sectionOf(man, u.name);
            const h = sectionOf(hm, u.name);
            if (!b && !h)
                continue;
            if (b)
                delete man[b.section][u.name];
            if (!h)
                continue; // removed in head
            // Pin the exact version the head lockfile resolved, so the package
            // manager installs that version and not whatever is newest today.
            const hv = resolved(head, u.name, h.spec, manifest);
            const spec = pin && hv && isRegistryRange(h.spec) ? hv : h.spec;
            man[h.section] = { ...(man[h.section] ?? {}), [u.name]: spec };
        }
        return man;
    };
    const writeManifests = async (dir, base, head, subset, pin) => {
        const out = new Map();
        for (const m of manifestsOf(base, head)) {
            if (head[m] == null)
                continue; // a member removed in head is gone from the worktree too
            const man = buildManifest(m, base, head, subset, pin);
            if (man)
                out.set(m, man);
        }
        return out;
    };
    const save = async (dir, base, head, mans) => {
        for (const [m, man] of mans) {
            await mkdir(join(dir, posix.dirname(m)), { recursive: true });
            await writeFile(join(dir, m), JSON.stringify(man, null, detectIndent(base[m] ?? head[m])) + '\n');
        }
    };
    return {
        name,
        files: name === 'pnpm' ? [MANIFEST, lockfile, PNPM_WORKSPACE] : [MANIFEST, lockfile],
        installCommand: install,
        detect(head) {
            return head[MANIFEST] != null && head[lockfile] != null;
        },
        members(snap, paths) {
            const patterns = workspacePatterns(snap);
            return patterns.length ? matchMembers(patterns, paths, MANIFEST) : [];
        },
        diff(base, head) {
            const manifests = manifestsOf(base, head);
            const updates = [];
            const excluded = [];
            const direct = directNames(...manifests.flatMap((m) => [parse(base[m]), parse(head[m])]));
            // Workspace packages themselves show up in lockfiles but are not dependencies.
            const workspacePackages = new Set(manifests.filter((m) => m !== MANIFEST).flatMap((m) => [parse(base[m])?.name, parse(head[m])?.name]).filter((n) => typeof n === 'string'));
            for (const dep of direct) {
                if (workspacePackages.has(dep))
                    continue;
                let changed = false;
                let section;
                const from = new Set();
                const to = new Set();
                for (const m of manifests) {
                    const b = sectionOf(parse(base[m]), dep);
                    const h = sectionOf(parse(head[m]), dep);
                    if (!b && !h)
                        continue;
                    const bv = resolved(base, dep, b?.spec, m);
                    const hv = resolved(head, dep, h?.spec, m);
                    if (b?.spec !== h?.spec || b?.section !== h?.section || bv !== hv)
                        changed = true;
                    if (b)
                        from.add(bv ?? b.spec);
                    if (h)
                        to.add(hv ?? h.spec);
                    section ??= (h ?? b).section;
                }
                if (!changed)
                    continue;
                updates.push({ id: dep, name: dep, section: section, from: showVersions(from), to: showVersions(to), kind: 'direct' });
            }
            // Transitive packages whose resolved versions changed. Packages that
            // only appear or disappear are consequences of other changes.
            const bl = base[lockfile];
            const hl = head[lockfile];
            if (bl && hl) {
                const b = reader.all(bl);
                const h = reader.all(hl);
                const skip = new Set([...direct, ...workspacePackages]);
                for (const pkg of [...new Set([...b.keys(), ...h.keys()])].sort()) {
                    const bv = b.get(pkg);
                    const hv = h.get(pkg);
                    if (skip.has(pkg) || !bv || !hv || sameSet(bv, hv))
                        continue;
                    const u = { id: pkg, name: pkg, section: 'lockfile', from: showVersions(bv), to: showVersions(hv), kind: 'transitive' };
                    if (transitive.supports(bv, hv))
                        updates.push(u);
                    else
                        excluded.push(`${pkg} ${u.from} → ${u.to} (several versions installed side by side)`);
                }
            }
            return { updates, excluded };
        },
        async write(dir, base, head, subset) {
            if (!base[MANIFEST])
                throw new Error(`${MANIFEST} does not exist at the base ref`);
            const mans = await writeManifests(dir, base, head, subset, true);
            const trans = subset.filter((x) => x.kind === 'transitive');
            let lock = base[lockfile] ?? null;
            if (trans.length)
                ({ lock } = transitive.apply({ man: mans.get(MANIFEST), lock, headLock: head[lockfile] ?? '', subset: trans }));
            await save(dir, base, head, mans);
            if (lock != null)
                await writeFile(join(dir, lockfile), lock);
            return [];
        },
        // The installed lockfile already has the right versions; put back head's
        // specs (no exact pins, no temporary overrides) so the result reads like
        // the original PR.
        async finalize(dir, base, head, subset) {
            await save(dir, base, head, await writeManifests(dir, base, head, subset, false));
            return [];
        },
    };
}
const npmName = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
/**
 * Replace every installed copy of each package (and whatever is nested
 * under it) with the copies from the head lockfile. `npm install` then fixes
 * up anything the new versions need that the old tree does not have.
 */
export function spliceNpmLock(baseLock, headLock, names) {
    const base = JSON.parse(baseLock);
    const head = JSON.parse(headLock);
    const wanted = new Set(names);
    const owned = (pkgs) => {
        const roots = Object.keys(pkgs).filter((k) => k.includes('node_modules/') && wanted.has(npmName(k)));
        return Object.keys(pkgs).filter((k) => roots.some((r) => k === r || k.startsWith(`${r}/node_modules/`)));
    };
    const packages = { ...(base.packages ?? {}) };
    for (const k of owned(packages))
        delete packages[k];
    for (const k of owned(head.packages ?? {}))
        packages[k] = head.packages[k];
    const sorted = Object.fromEntries(Object.keys(packages).sort().map((k) => [k, packages[k]]));
    return JSON.stringify({ ...base, packages: sorted }, null, 2) + '\n';
}
const single = (base, head) => base.size === 1 && head.size === 1;
const headVersion = (u) => u.to;
export const npm = nodeAdapter({
    name: 'npm',
    lockfile: 'package-lock.json',
    reader: npmLock,
    install: () => 'npm install --no-audit --no-fund --loglevel=error',
    transitive: {
        supports: () => true,
        apply: ({ lock, headLock, subset }) => ({
            lock: lock == null ? null : spliceNpmLock(lock, headLock, subset.map((u) => u.name)),
        }),
    },
});
export const pnpm = nodeAdapter({
    name: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    reader: pnpmLock,
    // pnpm freezes the lockfile under CI=true; depsect changes package.json on purpose.
    install: () => 'pnpm install --no-frozen-lockfile',
    transitive: {
        supports: single,
        apply: ({ man, lock, subset }) => {
            const pnpmField = (man.pnpm ?? {});
            pnpmField.overrides = { ...(pnpmField.overrides ?? {}), ...Object.fromEntries(subset.map((u) => [u.name, headVersion(u)])) };
            man.pnpm = pnpmField;
            return { lock };
        },
    },
});
export const yarn = nodeAdapter({
    name: 'yarn',
    lockfile: 'yarn.lock',
    reader: yarnLock,
    install: (head) => isBerry(head['yarn.lock'] ?? '')
        ? 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install'
        : 'yarn install --non-interactive --no-progress',
    transitive: {
        supports: single,
        apply: ({ man, lock, subset }) => {
            man.resolutions = { ...(man.resolutions ?? {}), ...Object.fromEntries(subset.map((u) => [u.name, headVersion(u)])) };
            return { lock };
        },
    },
});
