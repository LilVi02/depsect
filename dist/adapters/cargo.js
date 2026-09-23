// Rust: Cargo.toml + Cargo.lock.
//
// A subset is applied on top of the base lockfile with the tool itself:
// `cargo update -p name@old --precise new` moves one crate to the exact version
// head resolved, whether it is a direct or a transitive dependency. When a
// direct dependency's declaration changed in Cargo.toml, that declaration is
// copied from head first.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findEntry, findTable, parseToml, splice } from "../toml.js";
import { showVersions } from "./types.js";
import { matchMembers } from "../workspace.js";
const MANIFEST = 'Cargo.toml';
const LOCKFILE = 'Cargo.lock';
const table = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export function parseCargoLock(text) {
    if (!text)
        return [];
    const pkgs = parseToml(text).package;
    return (Array.isArray(pkgs) ? pkgs : []).map((p) => {
        const t = table(p);
        return {
            name: String(t.name),
            version: String(t.version),
            source: typeof t.source === 'string' ? t.source : undefined,
            // "serde", or "serde 1.0.1" / "serde 1.0.1 (registry+...)" when ambiguous.
            deps: (Array.isArray(t.dependencies) ? t.dependencies : []).map((d) => String(d).split(' ')[0]),
        };
    });
}
/** Crates declared by workspace members (packages without a source). */
const directNames = (crates) => new Set(crates.filter((c) => !c.source).flatMap((c) => c.deps));
/** Pair old and new versions of a crate: semver-compatible ones first, then leftovers if one of each. */
export function pairVersions(from, to) {
    const compat = (v) => {
        const [maj = '0', min = '0', pat = '0'] = v.split(/[.+-]/);
        return maj !== '0' ? maj : min !== '0' ? `0.${min}` : `0.0.${pat}`;
    };
    const pairs = [];
    const f = [...from];
    const t = [...to];
    for (const a of [...f]) {
        const i = t.findIndex((b) => compat(b) === compat(a));
        if (i < 0)
            continue;
        pairs.push([a, t[i]]);
        t.splice(i, 1);
        f.splice(f.indexOf(a), 1);
    }
    if (f.length === 1 && t.length === 1)
        pairs.push([f[0], t[0]]);
    return pairs;
}
/** Tables that can declare dependencies in Cargo.toml. */
function dependencyTables(man) {
    const kinds = ['dependencies', 'dev-dependencies', 'build-dependencies'];
    const paths = kinds.map((k) => [k]);
    paths.push(['workspace', 'dependencies']);
    for (const target of Object.keys(table(man.target)))
        for (const k of kinds)
            paths.push(['target', target, k]);
    return paths;
}
/** Where and how `crate` is declared: `name = ...` (or an alias with `package = "name"`), or a `[dependencies.name]` table. */
function findDecl(text, crate) {
    const man = parseToml(text);
    for (const path of dependencyTables(man)) {
        let t = man;
        for (const k of path)
            t = table(t)[k];
        for (const [key, value] of Object.entries(table(t))) {
            if (key !== crate && table(value).package !== crate)
                continue;
            const span = findEntry(text, path, key) ?? findTable(text, [...path, key]);
            if (span)
                return { table: path, ...span, text: text.slice(span.start, span.end) };
        }
    }
    return null;
}
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
/** Append a declaration at the end of its table, creating the table if needed. */
function insertDecl(text, d) {
    const entry = d.text.replace(/\n*$/, '\n');
    const t = findTable(text, d.table);
    if (!t)
        return `${text.replace(/\n*$/, '\n')}\n[${d.table.map(tomlKey).join('.')}]\n${entry}`;
    const body = text.slice(t.start, t.end).replace(/\n+$/, '\n');
    return text.slice(0, t.start) + body + entry + text.slice(t.start + body.length);
}
/** Make `crate`'s declaration in the base manifest match head's. */
export function editManifest(baseText, headText, crate) {
    const b = findDecl(baseText, crate);
    const h = findDecl(headText, crate);
    if (b && h && b.text === h.text)
        return baseText;
    if (b && h && b.table.join('.') === h.table.join('.'))
        return splice(baseText, b, h.text);
    const without = b ? splice(baseText, b, '') : baseText;
    return h ? insertDecl(without, h) : without;
}
export const cargo = {
    name: 'cargo',
    files: [MANIFEST, LOCKFILE],
    installCommand: () => 'cargo fetch',
    detect(head) {
        return head[MANIFEST] != null && head[LOCKFILE] != null;
    },
    members(snap, paths) {
        const ws = table(parseToml(snap[MANIFEST] ?? '').workspace);
        const list = (v) => (Array.isArray(v) ? v.map(String) : []);
        return matchMembers(list(ws.members), paths, MANIFEST, list(ws.exclude));
    },
    diff(base, head) {
        const b = parseCargoLock(base[LOCKFILE]);
        const h = parseCargoLock(head[LOCKFILE]);
        const direct = new Set([...directNames(b), ...directNames(h)]);
        const versions = (crates) => {
            const m = new Map();
            for (const c of crates)
                if (c.source)
                    (m.get(c.name) ?? m.set(c.name, []).get(c.name)).push(c.version);
            return m;
        };
        const bv = versions(b);
        const hv = versions(h);
        const updates = [];
        const excluded = [];
        for (const name of [...new Set([...bv.keys(), ...hv.keys()])].sort()) {
            const from = (bv.get(name) ?? []).filter((v) => !hv.get(name)?.includes(v));
            const to = (hv.get(name) ?? []).filter((v) => !bv.get(name)?.includes(v));
            if (!from.length && !to.length)
                continue;
            const kind = direct.has(name) ? 'direct' : 'transitive';
            const section = kind === 'direct' ? 'dependencies' : 'lockfile';
            const pairs = pairVersions(from, to);
            for (const [f, t] of pairs) {
                updates.push({ id: pairs.length > 1 ? `${name}@${f}` : name, name, section, from: f, to: t, kind });
            }
            const unpairedFrom = from.filter((v) => !pairs.some((p) => p[0] === v));
            const unpairedTo = to.filter((v) => !pairs.some((p) => p[1] === v));
            if (kind === 'direct' && !bv.has(name))
                updates.push({ id: name, name, section, from: null, to: showVersions(to), kind });
            else if (kind === 'direct' && !hv.has(name))
                updates.push({ id: name, name, section, from: showVersions(from), to: null, kind });
            else if (kind === 'direct' && (unpairedFrom.length || unpairedTo.length))
                excluded.push(`${name} ${showVersions(from) ?? '-'} → ${showVersions(to) ?? '-'} (could not pair versions)`);
        }
        return { updates, excluded };
    },
    async write(dir, base, head, subset) {
        // The root manifest and every workspace member's: a direct update takes
        // head's declaration wherever it changed.
        const manifests = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((k) => (k === MANIFEST || k.endsWith(`/${MANIFEST}`)) && head[k] != null);
        for (const m of manifests) {
            let text = base[m] ?? head[m];
            for (const u of subset.filter((x) => x.kind === 'direct'))
                text = editManifest(text, head[m], u.name);
            await writeFile(join(dir, m), text);
        }
        await writeFile(join(dir, LOCKFILE), base[LOCKFILE] ?? '');
        const q = (s) => `'${s}'`;
        const cmds = [];
        // Version changes first: `-p name@old` must still match the base lockfile.
        // An earlier update may already have moved the crate (cargo re-resolves
        // edited declarations), in which case `-p name@new` is a no-op.
        for (const u of subset.filter((x) => x.from && x.to)) {
            const precise = `--precise ${q(u.to)}`;
            cmds.push(`cargo update -p ${q(`${u.name}@${u.from}`)} ${precise} || cargo update -p ${q(`${u.name}@${u.to}`)} ${precise}`);
        }
        // Then let cargo add and drop declarations that appeared or disappeared.
        const added = subset.filter((x) => !x.from && x.to);
        if (added.length || subset.some((x) => x.from && !x.to))
            cmds.push('cargo update --workspace');
        for (const u of added)
            cmds.push(`cargo update -p ${q(u.name)} --precise ${q(u.to)}`);
        return cmds;
    },
};
