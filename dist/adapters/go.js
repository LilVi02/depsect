// Go modules: go.mod + go.sum.
//
// go.mod lists every module in the build list, direct ones and `// indirect`
// ones. A subset is applied on top of the base go.mod with `go get mod@version`,
// so minimal version selection adds whatever the new versions require.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const GOMOD = 'go.mod';
const GOSUM = 'go.sum';
/** The `require` directives of a go.mod, both single-line and block form. */
export function parseGoMod(text) {
    const out = new Map();
    let inBlock = false;
    for (const raw of (text ?? '').split('\n')) {
        const line = raw.trim();
        if (inBlock && line === ')') {
            inBlock = false;
            continue;
        }
        if (/^require\s*\($/.test(line)) {
            inBlock = true;
            continue;
        }
        const m = (inBlock ? /^(\S+)\s+(\S+)(.*)$/ : /^require\s+(\S+)\s+(\S+)(.*)$/).exec(line);
        if (!m || m[1].startsWith('//'))
            continue;
        out.set(m[1], { path: m[1], version: m[2], indirect: /\/\/\s*indirect/.test(m[3]) });
    }
    return out;
}
/** go.sum lines from both sides, so checksums for either version are available. */
export function mergeGoSum(base, head) {
    const lines = new Set([...(base ?? '').split('\n'), ...(head ?? '').split('\n')].filter((l) => l.trim()));
    return [...lines].sort().join('\n') + '\n';
}
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
export const go = {
    name: 'go',
    files: [GOMOD, GOSUM],
    installCommand: () => 'go mod download',
    // Let `go test` and friends record the go.sum entries MVS needs.
    env: { GOFLAGS: '-mod=mod' },
    detect(head) {
        return head[GOMOD] != null;
    },
    diff(base, head) {
        const b = parseGoMod(base[GOMOD]);
        const h = parseGoMod(head[GOMOD]);
        const updates = [];
        for (const path of [...new Set([...b.keys(), ...h.keys()])].sort()) {
            const from = b.get(path);
            const to = h.get(path);
            if (from?.version === to?.version)
                continue;
            const indirect = (to ?? from).indirect;
            updates.push({
                id: path,
                name: path,
                section: indirect ? 'indirect' : 'require',
                from: from?.version ?? null,
                to: to?.version ?? null,
                kind: indirect ? 'transitive' : 'direct',
            });
        }
        return { updates, excluded: [] };
    },
    async write(dir, base, head, subset) {
        await writeFile(join(dir, GOMOD), base[GOMOD] ?? '');
        await writeFile(join(dir, GOSUM), mergeGoSum(base[GOSUM], head[GOSUM]));
        if (!subset.length)
            return [];
        return [`go get ${subset.map((u) => q(`${u.name}@${u.to ?? 'none'}`)).join(' ')}`];
    },
};
