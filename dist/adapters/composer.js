// PHP: composer.json + composer.lock.
//
// composer.lock is a flat list of packages with one version each, like the
// Python lockfiles. A subset is applied by composing the lockfile: updated
// packages from head, the rest from base, plus whatever new packages the
// chosen ones require. composer.json comes from head with the constraints of
// packages outside the subset put back to base (composer install checks
// them), and the lock's content-hash is recomputed the way Composer does.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MANIFEST = 'composer.json';
const LOCKFILE = 'composer.lock';
/** php, ext-json, lib-icu, composer-plugin-api… are platform requirements, not packages. */
const isPlatform = (name) => !name.includes('/') || /^(php|ext-|lib-|composer(-|$))/.test(name);
const parse = (text) => (text ? JSON.parse(text) : null);
/** name → package and whether it is a dev package. */
function index(lock) {
    const m = new Map();
    for (const pkg of lock?.packages ?? [])
        m.set(pkg.name, { pkg, dev: false });
    for (const pkg of lock?.['packages-dev'] ?? [])
        m.set(pkg.name, { pkg, dev: true });
    return m;
}
/** PHP's json_encode with default flags: escaped slashes and \uXXXX for non-ASCII; empty objects become []. */
function phpJson(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number')
        return JSON.stringify(v);
    if (typeof v === 'string') {
        return JSON.stringify(v).replace(/\//g, '\\/').replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    if (Array.isArray(v))
        return `[${v.map(phpJson).join(',')}]`;
    const entries = Object.entries(v);
    if (entries.length === 0)
        return '[]';
    return `{${entries.map(([k, x]) => `${phpJson(k)}:${phpJson(x)}`).join(',')}}`;
}
/** composer.lock's content-hash for a composer.json (Composer's Locker::getContentHash). */
export function contentHash(manifestText) {
    const content = JSON.parse(manifestText);
    const keys = ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide', 'minimum-stability', 'prefer-stable', 'repositories', 'extra'];
    const relevant = {};
    for (const k of keys)
        if (k in content)
            relevant[k] = content[k];
    const platform = content.config?.platform;
    if (platform !== undefined)
        relevant.config = { platform };
    const sorted = Object.fromEntries(Object.keys(relevant).sort().map((k) => [k, relevant[k]]));
    return createHash('md5').update(phpJson(sorted)).digest('hex');
}
/** Put the constraints of `revert` packages in head's composer.json back to base's, editing only those strings. */
export function revertManifest(baseText, headText, revert) {
    const b = parse(baseText) ?? {};
    const h = parse(headText) ?? {};
    let out = headText;
    for (const section of ['require', 'require-dev']) {
        for (const name of revert) {
            const from = b[section]?.[name];
            const to = h[section]?.[name];
            if (from === undefined || to === undefined || from === to)
                continue;
            const esc = (x) => JSON.stringify(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`(${esc(name)}\\s*:\\s*)${esc(to)}`), (_m, key) => key + JSON.stringify(from));
        }
    }
    return out;
}
/** Compose a lockfile: head's metadata, head's packages for `names`, base's for the rest, plus missing requirements. */
export function composeComposerLock(baseText, headText, names, headManifest) {
    const head = parse(headText);
    const b = index(parse(baseText));
    const h = index(head);
    const chosen = new Map();
    for (const [name, entry] of b)
        if (!names.has(name))
            chosen.set(name, entry);
    for (const name of names)
        if (h.has(name))
            chosen.set(name, h.get(name));
    // Follow requirements, starting from the root's own (head's composer.json).
    const queue = [
        ...Object.keys(headManifest.require ?? {}),
        ...Object.keys(headManifest['require-dev'] ?? {}),
        ...[...chosen.values()].flatMap((e) => Object.keys(e.pkg.require ?? {})),
    ];
    while (queue.length) {
        const dep = queue.shift();
        if (isPlatform(dep) || chosen.has(dep))
            continue;
        const add = h.get(dep) ?? b.get(dep);
        if (!add)
            continue;
        chosen.set(dep, add);
        queue.push(...Object.keys(add.pkg.require ?? {}));
    }
    const sorted = (dev) => [...chosen.values()].filter((e) => e.dev === dev).map((e) => e.pkg).sort((x, y) => x.name.localeCompare(y.name));
    return JSON.stringify({ ...head, packages: sorted(false), 'packages-dev': sorted(true) }, null, 4) + '\n';
}
export const composer = {
    name: 'composer',
    files: [MANIFEST, LOCKFILE],
    installCommand: () => 'composer install --no-interaction --no-progress',
    detect(head) {
        return head[MANIFEST] != null && head[LOCKFILE] != null;
    },
    diff(base, head) {
        const b = index(parse(base[LOCKFILE]));
        const h = index(parse(head[LOCKFILE]));
        const direct = new Map();
        for (const man of [parse(base[MANIFEST]), parse(head[MANIFEST])]) {
            for (const n of Object.keys(man?.require ?? {}))
                if (!isPlatform(n))
                    direct.set(n, 'require');
            for (const n of Object.keys(man?.['require-dev'] ?? {}))
                if (!isPlatform(n))
                    direct.set(n, 'require-dev');
        }
        const updates = [];
        for (const name of [...new Set([...b.keys(), ...h.keys()])].sort()) {
            const from = b.get(name)?.pkg.version;
            const to = h.get(name)?.pkg.version;
            // Packages that appear or disappear follow head's composer.json (or
            // the updates that need them), so only version changes are units.
            if (!from || !to || from === to)
                continue;
            const section = direct.get(name);
            updates.push({ id: name, name, section: section ?? 'lockfile', from, to, kind: section ? 'direct' : 'transitive' });
        }
        return { updates, excluded: [] };
    },
    async write(dir, base, head, subset) {
        const headLock = head[LOCKFILE];
        if (!headLock)
            throw new Error(`${LOCKFILE} does not exist at the head ref`);
        // composer install checks the lock against composer.json, so packages
        // outside the subset get base's constraints back, and the lock's
        // content-hash is recomputed for the result.
        const chosen = new Set(subset.map((u) => u.name));
        const revert = new Set(this.diff(base, head).updates.map((u) => u.name).filter((n) => !chosen.has(n)));
        const manifestText = revertManifest(base[MANIFEST] ?? '{}', head[MANIFEST] ?? '{}', revert);
        const manifest = parse(manifestText) ?? {};
        const lock = JSON.parse(composeComposerLock(base[LOCKFILE] ?? '{}', headLock, chosen, manifest));
        if (typeof lock['content-hash'] === 'string')
            lock['content-hash'] = contentHash(manifestText);
        await writeFile(join(dir, MANIFEST), manifestText);
        await writeFile(join(dir, LOCKFILE), JSON.stringify(lock, null, 4) + '\n');
        return [];
    },
};
