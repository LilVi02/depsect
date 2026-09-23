// Workspace member discovery shared by the adapters: match globs like
// "packages/*", "crates/**" or "!packages/legacy" against the repo's files.
import { posix } from 'node:path';
/** Regex for a workspace glob over directory paths (`*` stays within one segment, `**` spans several). */
export function globToRegExp(glob) {
    const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '*' && clean[i + 1] === '*') {
            // "a/**/b" also matches "a/b".
            if (clean[i + 2] === '/') {
                re += '(?:.*/)?';
                i += 2;
            }
            else {
                re += '.*';
                i += 1;
            }
        }
        else if (c === '*')
            re += '[^/]*';
        else if (c === '?')
            re += '[^/]';
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}
/**
 * Manifest files (e.g. "packages/a/package.json") of the workspace members
 * matched by `patterns`, among `paths` (all files, relative to the workspace root).
 */
export function matchMembers(patterns, paths, manifest, exclude = []) {
    const include = patterns.filter((p) => !p.startsWith('!')).map(globToRegExp);
    const skip = [...patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)), ...exclude].map(globToRegExp);
    return paths
        .filter((p) => posix.basename(p) === manifest && p !== manifest)
        .filter((p) => !p.split('/').includes('node_modules'))
        .filter((p) => {
        const dir = posix.dirname(p);
        return include.some((re) => re.test(dir)) && !skip.some((re) => re.test(dir));
    })
        .sort();
}
