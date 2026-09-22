import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const parse = (text) => (text ? JSON.parse(text) : null);
function detectIndent(text) {
    const m = /^[ \t]+(?=")/m.exec(text);
    return m ? m[0] : 2;
}
function locked(lock, name) {
    return lock?.packages?.[`node_modules/${name}`]?.version;
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
export const npm = {
    name: 'npm',
    files: [MANIFEST, LOCKFILE],
    installCommand: 'npm install --no-audit --no-fund --loglevel=error',
    detect(head) {
        return head[MANIFEST] != null && head[LOCKFILE] != null;
    },
    diff(base, head) {
        const bm = parse(base[MANIFEST]);
        const hm = parse(head[MANIFEST]);
        const bl = parse(base[LOCKFILE]);
        const hl = parse(head[LOCKFILE]);
        const updates = [];
        for (const name of directNames(bm, hm)) {
            const b = sectionOf(bm, name);
            const h = sectionOf(hm, name);
            const bv = locked(bl, name);
            const hv = locked(hl, name);
            const specChanged = b?.spec !== h?.spec || b?.section !== h?.section;
            if (!specChanged && bv === hv)
                continue;
            updates.push({
                id: name,
                name,
                section: (h ?? b).section,
                from: b ? (bv ?? b.spec) : null,
                to: h ? (hv ?? h.spec) : null,
            });
        }
        return updates;
    },
    notes(base, head) {
        const bm = parse(base[MANIFEST]);
        const hm = parse(head[MANIFEST]);
        const direct = new Set(directNames(bm, hm).map((n) => `node_modules/${n}`));
        const bp = parse(base[LOCKFILE])?.packages ?? {};
        const hp = parse(head[LOCKFILE])?.packages ?? {};
        let transitive = 0;
        for (const key of new Set([...Object.keys(bp), ...Object.keys(hp)])) {
            if (key === '' || direct.has(key))
                continue;
            if (bp[key]?.version !== hp[key]?.version)
                transitive++;
        }
        return transitive > 0
            ? [
                `${transitive} transitive package(s) changed in ${LOCKFILE} as well. depsect bisects direct dependencies ` +
                    `and lets npm re-resolve their subtrees, so transitive-only changes are not tested individually.`,
            ]
            : [];
    },
    async write(dir, base, head, subset) {
        const baseText = base[MANIFEST];
        if (!baseText)
            throw new Error(`${MANIFEST} does not exist at the base ref`);
        const man = parse(baseText);
        const hm = parse(head[MANIFEST]);
        const hl = parse(head[LOCKFILE]);
        for (const u of subset) {
            const b = sectionOf(man, u.name);
            const h = sectionOf(hm, u.name);
            if (b)
                delete man[b.section][u.name];
            if (!h)
                continue; // removed in head
            // If only the lockfile moved (a range that already allowed the new
            // version), pin the exact version so npm actually installs it.
            const hv = locked(hl, u.name);
            const spec = b && b.spec === h.spec && b.section === h.section && hv ? hv : h.spec;
            const key = h.section;
            man[key] = { ...(man[key] ?? {}), [u.name]: spec };
        }
        await writeFile(join(dir, MANIFEST), JSON.stringify(man, null, detectIndent(baseText)) + '\n');
        const lock = base[LOCKFILE];
        if (lock != null)
            await writeFile(join(dir, LOCKFILE), lock);
    },
};
export const adapters = [npm];
