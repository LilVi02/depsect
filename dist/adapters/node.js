// JavaScript package managers. They share package.json semantics and differ
// in the lockfile format, the install command, and how a transitive package
// can be forced to a version.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBerry, npmLock, pnpmLock, yarnLock } from "./lockfiles.js";
import { sameSet, showVersions } from "./types.js";
const MANIFEST = 'package.json';
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
function nodeAdapter({ name, lockfile, reader, install, transitive }) {
    const resolved = (snap, dep, spec) => {
        const text = snap[lockfile];
        return text && spec !== undefined ? reader.direct(text, dep, spec) : undefined;
    };
    /** Base package.json with head's declarations for the direct updates in `subset`. */
    const buildManifest = (base, head, subset, pin) => {
        const baseText = base[MANIFEST];
        if (!baseText)
            throw new Error(`${MANIFEST} does not exist at the base ref`);
        const man = parse(baseText);
        const hm = parse(head[MANIFEST]);
        for (const u of subset.filter((x) => x.kind === 'direct')) {
            const b = sectionOf(man, u.name);
            const h = sectionOf(hm, u.name);
            if (b)
                delete man[b.section][u.name];
            if (!h)
                continue; // removed in head
            // Pin the exact version the head lockfile resolved, so the package
            // manager installs that version and not whatever is newest today.
            const hv = resolved(head, u.name, h.spec);
            const spec = pin && hv && isRegistryRange(h.spec) ? hv : h.spec;
            man[h.section] = { ...(man[h.section] ?? {}), [u.name]: spec };
        }
        return man;
    };
    return {
        name,
        files: [MANIFEST, lockfile],
        installCommand: install,
        detect(head) {
            return head[MANIFEST] != null && head[lockfile] != null;
        },
        diff(base, head) {
            const bm = parse(base[MANIFEST]);
            const hm = parse(head[MANIFEST]);
            const updates = [];
            const excluded = [];
            const direct = directNames(bm, hm);
            for (const dep of direct) {
                const b = sectionOf(bm, dep);
                const h = sectionOf(hm, dep);
                const bv = resolved(base, dep, b?.spec);
                const hv = resolved(head, dep, h?.spec);
                const specChanged = b?.spec !== h?.spec || b?.section !== h?.section;
                if (!specChanged && bv === hv)
                    continue;
                updates.push({
                    id: dep,
                    name: dep,
                    section: (h ?? b).section,
                    from: b ? (bv ?? b.spec) : null,
                    to: h ? (hv ?? h.spec) : null,
                    kind: 'direct',
                });
            }
            // Transitive packages whose resolved versions changed. Packages that
            // only appear or disappear are consequences of other changes.
            const bl = base[lockfile];
            const hl = head[lockfile];
            if (bl && hl) {
                const b = reader.all(bl);
                const h = reader.all(hl);
                const directSet = new Set(direct);
                for (const pkg of [...new Set([...b.keys(), ...h.keys()])].sort()) {
                    const bv = b.get(pkg);
                    const hv = h.get(pkg);
                    if (directSet.has(pkg) || !bv || !hv || sameSet(bv, hv))
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
            const man = buildManifest(base, head, subset, true);
            const trans = subset.filter((x) => x.kind === 'transitive');
            let lock = base[lockfile] ?? null;
            if (trans.length)
                ({ lock } = transitive.apply({ man, lock, headLock: head[lockfile] ?? '', subset: trans }));
            await writeFile(join(dir, MANIFEST), JSON.stringify(man, null, detectIndent(base[MANIFEST])) + '\n');
            if (lock != null)
                await writeFile(join(dir, lockfile), lock);
            return [];
        },
        // The installed lockfile already has the right versions; put back head's
        // specs (no exact pins, no temporary overrides) so the result reads like
        // the original PR.
        async finalize(dir, base, head, subset) {
            const man = buildManifest(base, head, subset, false);
            await writeFile(join(dir, MANIFEST), JSON.stringify(man, null, detectIndent(base[MANIFEST])) + '\n');
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
