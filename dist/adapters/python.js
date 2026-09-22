// Python: uv (uv.lock) and Poetry (poetry.lock).
//
// A Python environment holds one version of each package, and both lockfiles
// are flat lists of `[[package]]` blocks. So a subset is applied by composing
// a lockfile: blocks for updated packages come from head, everything else from
// base, plus whatever new packages the updated versions need. The project's
// own pyproject.toml and lock metadata come from head, and the tool installs
// the composed lockfile as-is (`uv sync --frozen`, `poetry sync`).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseToml } from "../toml.js";
import { sameSet, showVersions } from "./types.js";
const PYPROJECT = 'pyproject.toml';
/** PEP 503 name normalization. */
export const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
/** Name part of a PEP 508 requirement like "requests[socks] (>=2.31) ; python_version > '3.8'". */
const requirementName = (req) => normalize(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? req);
const table = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const array = (v) => (Array.isArray(v) ? v : []);
/** Names referenced as `{ name = "x" }` anywhere in a uv dependency list or table of lists. */
function uvDepNames(v) {
    if (Array.isArray(v))
        return v.flatMap((x) => (typeof table(x).name === 'string' ? [normalize(table(x).name)] : []));
    return Object.values(table(v)).flatMap(uvDepNames);
}
export function parseFlatLock(text, flavor) {
    const lines = text.split('\n');
    const starts = [];
    let footerAt = lines.length;
    lines.forEach((l, i) => {
        if (l.trim() === '[[package]]')
            starts.push(i);
        else if (flavor === 'poetry' && l.trim() === '[metadata]')
            footerAt = i;
    });
    const header = lines.slice(0, starts[0] ?? footerAt).join('\n');
    const footer = lines.slice(footerAt).join('\n');
    const blocks = starts.map((s, i) => {
        const blockText = lines.slice(s, starts[i + 1] ?? footerAt).join('\n');
        const pkg = table(array(parseToml(blockText).package)[0]);
        const name = normalize(String(pkg.name));
        const source = table(pkg.source);
        const deps = flavor === 'uv'
            ? [...uvDepNames(pkg.dependencies), ...uvDepNames(pkg['optional-dependencies']), ...uvDepNames(pkg['dev-dependencies'])]
            : Object.keys(table(pkg.dependencies)).map(normalize);
        const root = flavor === 'uv' && ('virtual' in source || 'editable' in source);
        return { name, version: String(pkg.version), text: blockText.replace(/\n+$/, ''), deps: [...new Set(deps)], root };
    });
    return { header, blocks, footer };
}
const versionsByName = (lock) => {
    const m = new Map();
    for (const b of lock.blocks)
        if (!b.root)
            (m.get(b.name) ?? m.set(b.name, new Set()).get(b.name)).add(b.version);
    return m;
};
/**
 * Compose a lockfile: head's root blocks, head's blocks for `names`, base's
 * blocks for everything else, plus (transitively) any package a chosen block
 * depends on that is missing, taken from head if head has it, else from base.
 */
export function composeFlatLock(base, head, names, separator) {
    const byName = (lock) => {
        const m = new Map();
        for (const b of lock.blocks)
            if (!b.root)
                (m.get(b.name) ?? m.set(b.name, []).get(b.name)).push(b);
        return m;
    };
    const b = byName(base);
    const h = byName(head);
    const chosen = new Map();
    for (const [name, blocks] of b)
        if (!names.has(name))
            chosen.set(name, blocks);
    for (const name of names)
        if (h.has(name))
            chosen.set(name, h.get(name));
    const roots = head.blocks.filter((x) => x.root);
    const queue = [...roots, ...[...chosen.values()].flat()];
    while (queue.length) {
        for (const dep of queue.shift().deps) {
            if (chosen.has(dep) || roots.some((r) => r.name === dep))
                continue;
            const add = h.get(dep) ?? b.get(dep);
            if (!add)
                continue;
            chosen.set(dep, add);
            queue.push(...add);
        }
    }
    const blocks = [...roots, ...[...chosen.values()].flat()].sort((x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version, undefined, { numeric: true }));
    return [head.header.replace(/\n+$/, ''), ...blocks.map((x) => x.text), head.footer.replace(/\n+$/, '')]
        .filter((s) => s !== '')
        .join(separator) + '\n';
}
function pythonAdapter(spec) {
    const read = (snap) => {
        const lockText = snap[spec.lockfile];
        if (!lockText)
            return null;
        const lock = parseFlatLock(lockText, spec.flavor);
        const pyproject = snap[PYPROJECT] ? parseToml(snap[PYPROJECT]) : {};
        return { lock, direct: spec.direct(pyproject, lock) };
    };
    return {
        name: spec.name,
        files: [PYPROJECT, spec.lockfile],
        installCommand: () => spec.install,
        detect(head) {
            return head[PYPROJECT] != null && head[spec.lockfile] != null;
        },
        diff(base, head) {
            const b = read(base);
            const h = read(head);
            if (!h)
                return { updates: [], excluded: [] };
            const bv = b ? versionsByName(b.lock) : new Map();
            const hv = versionsByName(h.lock);
            const updates = [];
            for (const name of [...new Set([...bv.keys(), ...hv.keys()])].sort()) {
                const from = bv.get(name);
                const to = hv.get(name);
                if (sameSet(from, to))
                    continue;
                // Packages that appear or disappear follow head's pyproject.toml (or
                // the updates that need them), so only version changes are units.
                if (!from || !to)
                    continue;
                const group = h.direct.get(name) ?? b?.direct.get(name);
                updates.push({
                    id: name,
                    name,
                    section: group ?? 'lockfile',
                    from: showVersions(from),
                    to: showVersions(to),
                    kind: group ? 'direct' : 'transitive',
                });
            }
            return { updates, excluded: [] };
        },
        async write(dir, base, head, subset) {
            const baseLock = base[spec.lockfile];
            const headLock = head[spec.lockfile];
            if (!headLock)
                throw new Error(`${spec.lockfile} does not exist at the head ref`);
            const composed = composeFlatLock(parseFlatLock(baseLock ?? '', spec.flavor), parseFlatLock(headLock, spec.flavor), new Set(subset.map((u) => u.name)), '\n\n');
            await writeFile(join(dir, PYPROJECT), head[PYPROJECT] ?? '');
            await writeFile(join(dir, spec.lockfile), composed);
            return [];
        },
    };
}
export const uv = pythonAdapter({
    name: 'uv',
    lockfile: 'uv.lock',
    flavor: 'uv',
    install: 'uv sync --frozen',
    direct(_pyproject, lock) {
        // uv records the project's direct dependencies on its own lock entry.
        const out = new Map();
        for (const root of lock.blocks.filter((b) => b.root)) {
            const pkg = table(array(parseToml(root.text).package)[0]);
            for (const n of uvDepNames(pkg.dependencies))
                out.set(n, 'dependencies');
            for (const [g, deps] of Object.entries(table(pkg['optional-dependencies'])))
                for (const n of uvDepNames(deps))
                    out.set(n, g);
            for (const [g, deps] of Object.entries(table(pkg['dev-dependencies'])))
                for (const n of uvDepNames(deps))
                    out.set(n, g);
        }
        return out;
    },
});
export const poetry = pythonAdapter({
    name: 'poetry',
    lockfile: 'poetry.lock',
    flavor: 'poetry',
    install: 'poetry sync --no-interaction',
    direct(pyproject) {
        const out = new Map();
        const project = table(pyproject.project);
        for (const r of array(project.dependencies))
            out.set(requirementName(String(r)), 'dependencies');
        for (const [g, reqs] of Object.entries(table(project['optional-dependencies'])))
            for (const r of array(reqs))
                out.set(requirementName(String(r)), g);
        const tool = table(table(pyproject.tool).poetry);
        for (const n of Object.keys(table(tool.dependencies)))
            if (n !== 'python')
                out.set(normalize(n), 'dependencies');
        for (const n of Object.keys(table(tool['dev-dependencies'])))
            out.set(normalize(n), 'dev');
        for (const [g, grp] of Object.entries(table(tool.group)))
            for (const n of Object.keys(table(table(grp).dependencies)))
                out.set(normalize(n), g);
        return out;
    },
});
