// Just enough lockfile parsing to answer two questions:
//   1. which version does the lockfile resolve for this direct dependency?
//   2. which name@version pairs does it contain overall? (for the transitive note)
// No dependencies: pnpm and Yarn Berry lockfiles use a small, regular subset
// of YAML, and Yarn v1 has its own simple format.
const unquote = (s) => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
/** Minimal block-YAML reader: nested maps and scalars. List items are skipped. */
export function parseYamlish(text) {
    const root = {};
    const stack = [{ indent: -1, node: root }];
    for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- '))
            continue;
        const indent = raw.length - raw.trimStart().length;
        // The key ends at the first colon followed by whitespace or end of line,
        // so keys like `foo@file:vendor/foo.tgz:` work.
        const m = /^((?:"(?:[^"\\]|\\.)*")|(?:'[^']*')|.+?):(?:\s+(.*))?$/.exec(trimmed);
        if (!m)
            continue;
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent)
            stack.pop();
        const parent = stack[stack.length - 1].node;
        const key = unquote(m[1]);
        const value = m[2]?.trim();
        if (value === undefined || value === '') {
            const child = {};
            parent[key] = child;
            stack.push({ indent, node: child });
        }
        else {
            parent[key] = unquote(value);
        }
    }
    return root;
}
const sub = (t, key) => {
    const v = typeof t === 'object' ? t[key] : undefined;
    return typeof v === 'object' ? v : undefined;
};
/** "@scope/name@1.2.3" → ["@scope/name", "1.2.3"] */
function splitAt(id) {
    const i = id.indexOf('@', 1);
    return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}
function add(map, name, version) {
    let set = map.get(name);
    if (!set)
        map.set(name, (set = new Set()));
    set.add(version);
}
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
export const npmLock = {
    direct(text, name, _spec, importer = '') {
        const pkgs = JSON.parse(text).packages ?? {};
        // A workspace member's copy is nested under it unless it was hoisted to the root.
        return (importer && pkgs[`${importer}/node_modules/${name}`]?.version) || pkgs[`node_modules/${name}`]?.version;
    },
    all(text) {
        const out = new Map();
        for (const [key, pkg] of Object.entries(JSON.parse(text).packages ?? {})) {
            const i = key.lastIndexOf('node_modules/');
            if (i < 0 || !pkg.version)
                continue;
            add(out, key.slice(i + 'node_modules/'.length), pkg.version);
        }
        return out;
    },
};
// --- pnpm: pnpm-lock.yaml (v6 and v9 formats) -------------------------------
// Peer-dependency suffixes like "18.3.1(react@18.3.1)" are not part of the version.
const stripPeers = (v) => v.replace(/\(.*$/, '');
export const pnpmLock = {
    direct(text, name, _spec, importerPath = '') {
        const tree = parseYamlish(text);
        const importer = sub(sub(tree, 'importers'), importerPath || '.') ?? tree;
        for (const s of DEP_SECTIONS) {
            const entry = sub(importer, s)?.[name];
            if (typeof entry === 'string')
                return stripPeers(entry);
            if (entry && typeof entry.version === 'string')
                return stripPeers(entry.version);
        }
        return undefined;
    },
    all(text) {
        const out = new Map();
        for (const key of Object.keys(sub(parseYamlish(text), 'packages') ?? {})) {
            const id = stripPeers(key.replace(/^\//, ''));
            // v5 used "/name/1.2.3"; v6+ uses "name@1.2.3".
            const [name, version] = id.includes('@', 1) ? splitAt(id) : [id.slice(0, id.lastIndexOf('/')), id.slice(id.lastIndexOf('/') + 1)];
            add(out, name, version);
        }
        return out;
    },
};
export const isBerry = (text) => /^__metadata:/m.test(text);
function yarnEntries(text) {
    const entries = [];
    if (isBerry(text)) {
        for (const [key, value] of Object.entries(parseYamlish(text))) {
            if (key === '__metadata' || typeof value !== 'object' || typeof value.version !== 'string')
                continue;
            if (key.includes('@workspace:'))
                continue; // the project itself, or a monorepo package
            entries.push({ descriptors: key.split(/,\s*/).map(unquote), version: value.version });
        }
        return entries;
    }
    // v1: unindented `"a@^1", a@^1.2:` headers followed by indented `version "1.2.3"`.
    let current = null;
    for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#'))
            continue;
        if (!/^\s/.test(line) && line.trimEnd().endsWith(':')) {
            current = { descriptors: line.trimEnd().slice(0, -1).split(/,\s*/).map(unquote), version: '' };
            entries.push(current);
            continue;
        }
        const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
        if (m && current && !current.version)
            current.version = m[1];
    }
    return entries.filter((e) => e.version);
}
export const yarnLock = {
    direct(text, name, spec) {
        const wanted = new Set([`${name}@${spec}`, `${name}@npm:${spec}`]);
        return yarnEntries(text).find((e) => e.descriptors.some((d) => wanted.has(d)))?.version;
    },
    all(text) {
        const out = new Map();
        for (const e of yarnEntries(text))
            add(out, splitAt(e.descriptors[0])[0], e.version);
        return out;
    },
};
